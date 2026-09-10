import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultAuthorizationService } from "../../../apps/server/src/access/default-authorization-service.js";
import { AgentService } from "../../../apps/server/src/agent-service.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import { OrchestrationService } from "../../../apps/server/src/orchestration/orchestration-service.js";
import type { OrchestrationSession } from "../../../apps/server/src/orchestration/types.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../../apps/server/src/types.js";
import { WorkspaceManager } from "../../../apps/server/src/workspace.js";
import { ProjectServiceExecutionScope } from "../../../apps/server/src/projects/project-execution.js";
import { ProjectService } from "../../../apps/server/src/projects/project-service.js";
import { ProjectWorkspaceManager } from "../../../apps/server/src/projects/project-workspace.js";
import { GitWorkspaceCheckpointStore } from "../../../apps/server/src/projects/git-workspace-checkpoint-store.js";
import { WorkspaceCheckpointService } from "../../../apps/server/src/projects/workspace-checkpoint-service.js";
import { WorkspaceOperationCoordinator } from "../../../apps/server/src/projects/workspace-operation-coordinator.js";
import { createWorkspaceRecoveryFacade } from "../../../apps/server/src/projects/workspace-recovery-facade.js";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRecorder,
} from "../../../apps/server/src/audit/audit-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Script = (request: RunnerRequest, call: number) => Promise<RunnerResult>;

/** Deterministic Agents that really edit the shared workspace. */
class ScriptedRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  readonly scripts = new Map<string, Script>();
  private readonly calls = new Map<string, number>();
  /** Resolves when a run is paused; tests use it to hold a writer mid-turn. */
  pause: { agentId: string; release: Promise<void> } | null = null;

  async run(request: RunnerRequest): Promise<RunnerResult> {
    // Only scalar facts are recorded; the request also carries audit taps.
    this.requests.push({
      agentId: request.agentId,
      workspacePath: request.workspacePath,
      prompt: request.prompt,
      threadId: request.threadId,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    });
    const call = (this.calls.get(request.agentId) ?? 0) + 1;
    this.calls.set(request.agentId, call);
    if (this.pause?.agentId === request.agentId) await this.pause.release;
    const script = this.scripts.get(request.agentId);
    if (!script) return { output: "no script", threadId: "thread-" + request.agentId, usage: null };
    return script(request, call);
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class RecordingAudit implements AuditRecorder {
  readonly inputs: AuditEventInput[] = [];
  async record(input: AuditEventInput): Promise<AuditEvent> {
    this.inputs.push(input);
    return {} as AuditEvent;
  }
  ofType(type: AuditEventInput["type"]): AuditEventInput[] {
    return this.inputs.filter((input) => input.type === type);
  }
}

async function write(workspace: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(workspace, ...relative.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function read(workspace: string, relative: string): Promise<string> {
  return readFile(path.join(workspace, ...relative.split("/")), "utf8");
}

async function exists(workspace: string, relative: string): Promise<boolean> {
  try {
    await lstat(path.join(workspace, ...relative.split("/")));
    return true;
  } catch {
    return false;
  }
}

async function makeStack(options: { enabled?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lqam-recovery-"));
  roots.push(root);
  const enabled = options.enabled ?? true;
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    WORKER_CURATED_MODELS: "ep-test",
    WORKSPACE_CHECKPOINTS_ENABLED: enabled ? "true" : "false",
    WORKSPACE_CHECKPOINT_LOCAL_PROCESS: "allow",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const runner = new ScriptedRunner();
  const audit = new RecordingAudit();
  const agentService = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  agentService.setAuditRecorder(audit);
  const projectWorkspaces = new ProjectWorkspaceManager(path.join(root, "data", "projects"));
  const projectService = new ProjectService(
    store,
    projectWorkspaces,
    agentService,
    new DefaultAuthorizationService(),
  );
  const gitStore = new GitWorkspaceCheckpointStore({
    privateRoot: path.join(root, "data", "workspace-checkpoints"),
    workspacePathFor: (projectId) => projectWorkspaces.workspacePath(projectId),
    configuredSecrets: () => ["test-key"],
  });
  const checkpoints = new WorkspaceCheckpointService({ store, gitStore, enabled, audit });
  const operations = new WorkspaceOperationCoordinator(store);
  projectService.setWorkspaceCheckpoints(checkpoints, operations, {
    settlementPolicy: "trust_process_exit",
    runtimeSupported: true,
  });
  agentService.setProjectExecutionScope(new ProjectServiceExecutionScope(projectService));
  await checkpoints.initialize();
  await agentService.initialize();
  await projectService.initialize();
  const orchestration = new OrchestrationService({
    store,
    agentService,
    audit,
    projectBinding: {
      async bindConversation(projectId, conversationId, agentIds) {
        await projectService.bindConversation(projectId, conversationId, agentIds);
      },
      assertProjectMutationAllowed(projectId) {
        projectService.assertProjectMutationAllowed(projectId);
      },
    },
    workspaceRecovery: createWorkspaceRecoveryFacade({ projects: projectService, checkpoints, operations }),
  });
  await orchestration.initialize();

  const agents = [] as { id: string; name: string }[];
  for (const name of ["Planner", "Builder", "Reviewer"]) {
    const agent = await agentService.createAgent({
      name,
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    agents.push({ id: agent.id, name });
  }
  const project = await projectService.create({ name: "Recovery demo" });
  for (const agent of agents) await projectService.attachAgent(project.id, agent.id);
  const workspace = projectWorkspaces.workspacePath(project.id);
  await write(workspace, "src/message.ts", 'export const message = "hello";\n');

  const session = await orchestration.createSession({
    name: "Recovery",
    originalPrompt: "Ship the review-ready message.",
    projectId: project.id,
    participants: agents.map((agent, position) => ({
      id: "participant-" + agent.name.toLowerCase(),
      agentId: agent.id,
      role: agent.name,
      position,
    })),
    maxSteps: 3,
    perAgentTimeoutMs: 5_000,
  });
  return {
    root,
    store,
    runner,
    audit,
    agentService,
    projectService,
    checkpoints,
    operations,
    orchestration,
    agents: Object.fromEntries(agents.map((agent) => [agent.name, agent.id])) as Record<
      "Planner" | "Builder" | "Reviewer",
      string
    >,
    project,
    workspace,
    session,
  };
}

async function waitForTerminal(
  service: OrchestrationService,
  id: string,
): Promise<OrchestrationSession> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const session = (await service.getSession(id)).session;
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "stopped" ||
      session.status === "interrupted"
    ) {
      return session;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for orchestration " + id);
}

/** The demo scripts: Planner plans, Builder ships, Reviewer breaks then succeeds. */
function installDemoScripts(stack: Awaited<ReturnType<typeof makeStack>>, reviewerFailsOnCall = 1) {
  const { runner, agents } = stack;
  runner.scripts.set(agents.Planner, async (request) => {
    await write(request.workspacePath, "PLAN.md", "# Plan\n\n1. Change the message.\n");
    return { output: "plan-written", threadId: "planner-thread", usage: { inputTokens: 5, outputTokens: 2 } };
  });
  runner.scripts.set(agents.Builder, async (request) => {
    await write(request.workspacePath, "src/message.ts", 'export const message = "Ready for review";\n');
    return { output: "message-updated", threadId: "builder-thread", usage: { inputTokens: 7, outputTokens: 3 } };
  });
  runner.scripts.set(agents.Reviewer, async (request, call) => {
    if (call === reviewerFailsOnCall) {
      await write(request.workspacePath, "src/message.ts", 'export const message = "BROKEN";\n');
      await rm(path.join(request.workspacePath, "PLAN.md"), { force: true });
      await write(request.workspacePath, "src/partial.ts", "// half done\n");
      throw new Error("Reviewer crashed mid-turn");
    }
    await write(request.workspacePath, "REVIEW.md", "Approved: " + (await read(request.workspacePath, "src/message.ts")));
    return { output: "review-approved-" + String(call), threadId: "reviewer-thread", usage: { inputTokens: 9, outputTokens: 4 } };
  });
}

describe("Workspace checkpoints and recovery", () => {
  it("captures a baseline and a ready checkpoint after each successful turn, and none after a failure", async () => {
    const stack = await makeStack();
    installDemoScripts(stack);
    const { orchestration, session, workspace, agents } = stack;

    await orchestration.startSession(session.id);
    const failed = await waitForTerminal(orchestration, session.id);
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("RUN_FAILED");

    const detail = await orchestration.getSession(session.id);
    const checkpoints = detail.checkpoints ?? [];
    expect(checkpoints.map((checkpoint) => [checkpoint.kind, checkpoint.state])).toEqual([
      ["baseline", "ready"],
      ["turn_success", "ready"],
      ["turn_success", "ready"],
    ]);
    expect(checkpoints.map((checkpoint) => checkpoint.ordinal)).toEqual([1, 2, 3]);
    const plannerTurn = detail.turns.find((turn) => turn.agentId === agents.Planner);
    const builderTurn = detail.turns.find((turn) => turn.agentId === agents.Builder);
    const reviewerTurn = detail.turns.find((turn) => turn.agentId === agents.Reviewer);
    expect(checkpoints[1]?.turnId).toBe(plannerTurn?.id);
    expect(checkpoints[2]?.turnId).toBe(builderTurn?.id);
    expect(builderTurn?.workspaceCheckpointId).toBe(checkpoints[2]?.checkpointId);
    expect(checkpoints[2]?.recoverable).toBe(true);
    expect(reviewerTurn?.status).toBe("failed");
    expect(reviewerTurn?.workspaceCheckpointId).toBeUndefined();
    // No fourth dispatch, and the partial mutations remain on disk.
    expect(stack.runner.requests).toHaveLength(3);
    expect(await read(workspace, "src/message.ts")).toContain("BROKEN");
    expect(await exists(workspace, "src/partial.ts")).toBe(true);
    expect(await exists(workspace, "PLAN.md")).toBe(false);
    // The reservation was released once the cycle settled.
    expect(stack.operations.heldOperation(stack.project.id)).toBeNull();
    // Safe views carry no Git identity.
    expect(JSON.stringify(checkpoints)).not.toMatch(/gitSha|treeSha|manifestHash|resume/u);
  });

  it("restores after Builder and resumes with the Reviewer only, in a fresh Project thread", async () => {
    const stack = await makeStack();
    installDemoScripts(stack);
    const { orchestration, session, workspace, agents, audit } = stack;
    await orchestration.startSession(session.id);
    await waitForTerminal(orchestration, session.id);
    const before = await orchestration.getSession(session.id);
    const builderCheckpoint = before.checkpoints!.find(
      (checkpoint) => checkpoint.turnId === before.turns.find((turn) => turn.agentId === agents.Builder)?.id,
    )!;
    const failedStep = before.turns.find((turn) => turn.status === "failed")!.stepIndex!;
    // Orchestration turns keep their thread in the orchestration slot, so the
    // Agent's direct Project thread is never touched by a session.
    const threadsBefore = stack.store
      .snapshot()
      .projectAgents.map((item) => item.orchestrationThreadId ?? null);
    expect(threadsBefore.filter((thread) => thread !== null).length).toBe(2);
    expect(
      stack.store.snapshot().projectAgents.every((item) => item.codexThreadId === null),
    ).toBe(true);

    const requestId = "5d1f4a20-0000-4000-8000-000000000001";
    const accepted = await orchestration.recoverFromCheckpoint(session.id, {
      checkpointId: builderCheckpoint.checkpointId,
      requestId,
      acknowledgeSourceRestore: true,
    });
    expect(accepted.duplicate).toBe(false);
    expect(accepted.recovery.stage).toBe("reserved");
    // A transport retry finds the same operation, never a second restore.
    const again = await orchestration.recoverFromCheckpoint(session.id, {
      checkpointId: builderCheckpoint.checkpointId,
      requestId,
      acknowledgeSourceRestore: true,
    });
    expect(again.duplicate).toBe(true);
    expect(again.recovery.operationId).toBe(accepted.recovery.operationId);

    await orchestration.waitForRecovery(accepted.recovery.operationId);
    const resumed = await waitForTerminal(orchestration, session.id);
    expect(resumed.status).toBe("completed");

    // Source: Builder's file is back, the Reviewer's partial file is gone.
    expect(await read(workspace, "src/message.ts")).toBe('export const message = "Ready for review";\n');
    expect(await exists(workspace, "src/partial.ts")).toBe(false);
    expect(await read(workspace, "PLAN.md")).toContain("Change the message.");
    expect(await read(workspace, "REVIEW.md")).toContain("Ready for review");

    // Execution: Planner and Builder did not run again; the Reviewer saw
    // Builder's handoff and started with no Project thread.
    const requestsByAgent = stack.runner.requests.map((request) => request.agentId);
    expect(requestsByAgent).toEqual([agents.Planner, agents.Builder, agents.Reviewer, agents.Reviewer]);
    const resumedRequest = stack.runner.requests[3]!;
    expect(resumedRequest.prompt).toContain("message-updated");
    expect(resumedRequest.threadId).toBeNull();

    const after = await orchestration.getSession(session.id);
    const newTurns = after.turns.filter((turn) => (turn.stepIndex ?? -1) > failedStep);
    expect(newTurns).toHaveLength(1);
    expect(newTurns[0]).toMatchObject({ agentId: agents.Reviewer, status: "completed" });
    expect(after.turns.some((turn) => turn.status === "failed")).toBe(true);
    const recovery = after.recovery!;
    expect(recovery.stage).toBe("resume_accepted");
    expect(recovery.safetyCheckpointId).not.toBeNull();
    const kinds = after.checkpoints!.map((checkpoint) => checkpoint.kind);
    expect(kinds).toEqual(["baseline", "turn_success", "turn_success", "safety", "baseline", "turn_success"]);
    expect(after.checkpoints!.every((checkpoint) => checkpoint.state === "ready")).toBe(true);
    expect(after.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace_checkpoint_restore_started",
        "workspace_checkpoint_restored",
        "workspace_recovery_resumed",
        "workspace_checkpoint_created",
      ]),
    );
    const project = stack.store.snapshot().projects[0]!;
    expect(project.workspaceEpoch).toBe(1);
    expect(project.currentCheckpointId).toBe(after.checkpoints!.at(-1)?.checkpointId);
    expect(stack.operations.heldOperation(stack.project.id)).toBeNull();
    expect(audit.ofType("workspace_checkpoint_restored")).toHaveLength(1);
    expect(audit.ofType("workspace_recovery_resumed")).toHaveLength(1);
    const usage = stack.store.snapshot().runs.map((run) => run.usage?.outputTokens ?? 0);
    expect(usage).toEqual([2, 3, 0, 4]);
  });

  it("rejects the same request ID with a different checkpoint and a stale checkpoint after restore", async () => {
    const stack = await makeStack();
    installDemoScripts(stack);
    const { orchestration, session } = stack;
    await orchestration.startSession(session.id);
    await waitForTerminal(orchestration, session.id);
    const before = await orchestration.getSession(session.id);
    const [baseline, planner, builder] = before.checkpoints!;
    const requestId = "5d1f4a20-0000-4000-8000-000000000002";
    const accepted = await orchestration.recoverFromCheckpoint(session.id, {
      checkpointId: builder!.checkpointId,
      requestId,
      acknowledgeSourceRestore: true,
    });
    await expect(
      orchestration.recoverFromCheckpoint(session.id, {
        checkpointId: planner!.checkpointId,
        requestId,
        acknowledgeSourceRestore: true,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_IDEMPOTENCY_CONFLICT" });
    await orchestration.waitForRecovery(accepted.recovery.operationId);
    expect((await waitForTerminal(orchestration, session.id)).status).toBe("completed");
    // Every checkpoint stays listed and restorable, including the baseline.
    const after = await orchestration.getSession(session.id);
    expect(after.checkpoints!.find((checkpoint) => checkpoint.checkpointId === baseline!.checkpointId)?.recoverable).toBe(true);
    await expect(
      orchestration.recoverFromCheckpoint(session.id, {
        checkpointId: "00000000-0000-4000-8000-00000000dead",
        requestId: "5d1f4a20-0000-4000-8000-000000000003",
        acknowledgeSourceRestore: true,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND" });
  });

  it("keeps the Agent's output but fails the Run when the checkpoint cannot be taken", async () => {
    const stack = await makeStack();
    installDemoScripts(stack);
    const { orchestration, session, runner, agents } = stack;
    runner.scripts.set(agents.Builder, async (request) => {
      // A credential copied into source: the scanner must refuse the snapshot.
      await write(request.workspacePath, "src/config.ts", 'export const key = "test-key";\n');
      return { output: "builder-leaked", threadId: "builder-thread", usage: { inputTokens: 7, outputTokens: 3 } };
    });

    await orchestration.startSession(session.id);
    const failed = await waitForTerminal(orchestration, session.id);
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("CHECKPOINT_CAPTURE_FAILED");
    expect(failed.errorMessage).not.toContain("test-key");

    const builderRun = stack.store.snapshot().runs.find((run) => run.agentId === agents.Builder)!;
    expect(builderRun.status).toBe("failed");
    expect(builderRun.errorCode).toBe("CHECKPOINT_CAPTURE_FAILED");
    expect(builderRun.output).toBe("builder-leaked");
    expect(builderRun.usage?.outputTokens).toBe(3);
    expect(builderRun.workspaceCheckpointId).toBeUndefined();
    // The Reviewer never ran, and no candidate is offered as recoverable.
    expect(runner.requests.map((request) => request.agentId)).toEqual([agents.Planner, agents.Builder]);
    const detail = await orchestration.getSession(session.id);
    expect(detail.checkpoints!.filter((checkpoint) => checkpoint.state === "ready")).toHaveLength(2);
    expect(detail.checkpoints!.some((checkpoint) => checkpoint.state === "failed" && checkpoint.unavailableReason === "CHECKPOINT_SECRET_DETECTED")).toBe(true);
    expect(stack.operations.heldOperation(stack.project.id)).toBeNull();
    expect(stack.store.snapshot().projectLeases).toHaveLength(0);
  });

  it("excludes every other writer while a cycle owns the Project", async () => {
    const stack = await makeStack();
    installDemoScripts(stack);
    const { orchestration, session, runner, agents, agentService, projectService } = stack;
    const other = await orchestration.createSession({
      name: "Other",
      originalPrompt: "Interfere",
      projectId: stack.project.id,
      participants: [{ id: "p", agentId: agents.Planner, role: "Planner", position: 0 }],
      maxSteps: 1,
      perAgentTimeoutMs: 5_000,
    });
    let release!: () => void;
    runner.pause = {
      agentId: agents.Builder,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    await orchestration.startSession(session.id);
    for (let attempt = 0; attempt < 500 && runner.requests.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(runner.requests).toHaveLength(2);

    // Operator recovery while the Team is running.
    const before = await orchestration.getSession(session.id);
    await expect(
      orchestration.recoverFromCheckpoint(session.id, {
        checkpointId: before.checkpoints![1]!.checkpointId,
        requestId: "5d1f4a20-0000-4000-8000-000000000004",
        acknowledgeSourceRestore: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // A direct Project run is not a cycle participant.
    await expect(
      agentService.sendMessage(agents.Reviewer, "sneak in", { projectId: stack.project.id }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_DIRECT_PROJECT_RUN_UNSUPPORTED" });
    // Another conversation on the same Project cannot reserve it, and
    // Project lifecycle mutations are refused too.
    await expect(orchestration.startSession(other.id)).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    await expect(projectService.archive(stack.project.id)).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    await expect(projectService.detachAgent(stack.project.id, agents.Reviewer)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });

    release();
    expect((await waitForTerminal(orchestration, session.id)).status).toBe("failed");
    expect(stack.operations.heldOperation(stack.project.id)).toBeNull();
    // The other conversation may run once the Project is free again.
    await orchestration.startSession(other.id);
    expect((await waitForTerminal(orchestration, other.id)).status).toBe("completed");
  });

  it("gives a later follow-up only the accepted branch, not the abandoned turn", async () => {
    const stack = await makeStack();
    installDemoScripts(stack, 99);
    const { orchestration, session, runner, agents } = stack;
    await orchestration.startSession(session.id);
    expect((await waitForTerminal(orchestration, session.id)).status).toBe("completed");
    const first = await orchestration.getSession(session.id);
    const builderCheckpoint = first.checkpoints!.find(
      (checkpoint) => checkpoint.turnId === first.turns.find((turn) => turn.agentId === agents.Builder)?.id,
    )!;

    // Restore after Builder even though the Reviewer succeeded: its first
    // review becomes an abandoned branch.
    const accepted = await orchestration.recoverFromCheckpoint(session.id, {
      checkpointId: builderCheckpoint.checkpointId,
      requestId: "5d1f4a20-0000-4000-8000-000000000005",
      acknowledgeSourceRestore: true,
    });
    await orchestration.waitForRecovery(accepted.recovery.operationId);
    expect((await waitForTerminal(orchestration, session.id)).status).toBe("completed");
    const reviewerOutputs = stack.store
      .snapshot()
      .runs.filter((run) => run.agentId === agents.Reviewer)
      .map((run) => run.output);
    expect(reviewerOutputs).toEqual(["review-approved-1", "review-approved-2"]);

    runner.requests.length = 0;
    await orchestration.continueSession(session.id, "Polish the wording.");
    expect((await waitForTerminal(orchestration, session.id)).status).toBe("completed");
    const plannerPrompt = runner.requests[0]!.prompt;
    expect(plannerPrompt).toContain("review-approved-2");
    expect(plannerPrompt).not.toContain("review-approved-1");
    // The abandoned turn stays in the visible history.
    const detail = await orchestration.getSession(session.id);
    expect(detail.turns.filter((turn) => turn.agentId === agents.Reviewer)).toHaveLength(3);
  });

  it("runs unchanged with checkpoints disabled", async () => {
    const stack = await makeStack({ enabled: false });
    installDemoScripts(stack, 99);
    const { orchestration, session, root } = stack;
    await orchestration.startSession(session.id);
    expect((await waitForTerminal(orchestration, session.id)).status).toBe("completed");
    const detail = await orchestration.getSession(session.id);
    expect(detail.checkpoints).toBeUndefined();
    expect(stack.store.snapshot().workspaceCheckpoints).toHaveLength(0);
    expect(stack.store.snapshot().workspaceOperations).toHaveLength(0);
    expect(await exists(path.join(root, "data"), "workspace-checkpoints")).toBe(false);
  });
});
