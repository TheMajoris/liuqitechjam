import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "../../../apps/server/src/types.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type {
  PlatformAgentInvokerContract,
  PlatformAgentInvokerInput,
} from "../../../apps/server/src/orchestration/platform-agent-invoker.js";
import {
  OrchestrationService,
  type OrchestrationAgentAccess,
} from "../../../apps/server/src/orchestration/orchestration-service.js";
import type {
  CreateOrchestrationInput,
  OrchestrationSession,
  OrchestrationTurn,
} from "../../../apps/server/src/orchestration/types.js";
import { AgentService } from "../../../apps/server/src/agent-service.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import { WorkspaceManager } from "../../../apps/server/src/workspace.js";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
} from "../../../apps/server/src/types.js";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRecorder,
} from "../../../apps/server/src/audit/audit-types.js";

const agentIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function makeAgent(id: string, status: Agent["status"] = "ready"): Agent {
  const timestamp = "2026-08-28T00:00:00.000Z";
  return {
    id,
    name: `Agent ${id.slice(0, 4)}`,
    description: "Test Agent",
    instructions: "Do the assigned work.",
    modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    status,
    workspacePath: `/tmp/launchpad-${id}`,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeInput(
  participants = agentIds.map((agentId, position) => ({
    id: `participant-${position}`,
    agentId,
    role: `Role ${position}`,
    position,
  })),
): CreateOrchestrationInput {
  return {
    name: "Release pipeline",
    originalPrompt: "Ship the requested change safely.",
    participants,
    maxSteps: participants.length,
    perAgentTimeoutMs: 1_000,
  };
}

async function makeStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-orchestration-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

async function waitForTerminal(
  service: OrchestrationService,
  id: string,
): Promise<OrchestrationSession> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = (await service.getSession(id)).session;
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "stopped" ||
      session.status === "interrupted"
    ) {
      return session;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for orchestration " + id);
}

class ImmediateInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  readonly cancellations: string[] = [];
  private count = 0;

  async invoke(input: PlatformAgentInvokerInput) {
    this.calls.push(input);
    this.count += 1;
    const runId = `00000000-0000-4000-8000-${String(this.count).padStart(12, "0")}`;
    await input.onRunAccepted?.(runId);
    return {
      runId,
      output: `result-${this.count}`,
    };
  }

  async cancel(runId: string): Promise<void> {
    this.cancellations.push(runId);
  }
}

class PendingInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  readonly cancellations: string[] = [];
  readonly storageFailureCancellations: string[] = [];
  private resolvePending: (() => void) | null = null;
  private rejectPending: ((error: Error) => void) | null = null;

  async invoke(input: PlatformAgentInvokerInput) {
    this.calls.push(input);
    const runId = "00000000-0000-4000-8000-000000000099";
    await input.onRunAccepted?.(runId);
    return new Promise<{ runId: string; output: string }>((resolve, reject) => {
      this.resolvePending = () => resolve({ runId, output: "late result" });
      this.rejectPending = reject;
      input.signal?.addEventListener(
        "abort",
        () => reject(new Error("child Run cancelled")),
        { once: true },
      );
    });
  }

  async cancel(runId: string): Promise<void> {
    this.cancellations.push(runId);
    this.rejectPending?.(new Error("child Run cancelled"));
    this.rejectPending = null;
    this.resolvePending = null;
  }

  async cancelForStorageFailure(runId: string): Promise<void> {
    this.storageFailureCancellations.push(runId);
    this.rejectPending?.(new Error("child Run cancelled"));
    this.rejectPending = null;
    this.resolvePending = null;
  }
}

function makeAgentsAccess(agents: Agent[]): OrchestrationAgentAccess {
  return { listAgents: () => agents };
}

/** Records audit inputs verbatim so the span tree can be asserted. */
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

class EchoRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "echo-thread",
      usage: { inputTokens: 4, outputTokens: 2 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** A real AgentService so child Runs travel the platform invoker path. */
async function makePlatformAgentService(
  audit: AuditRecorder,
): Promise<{ service: AgentService; store: JsonStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-orchestration-audit-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    WORKER_CURATED_MODELS: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new EchoRunner(),
  );
  service.setAuditRecorder(audit);
  await service.initialize();
  return { service, store };
}

describe("OrchestrationService", () => {
  it("runs an arbitrary roster in order, journals turns, and preserves monotonic events", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ImmediateInvoker();
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession(
      makeInput([
        {
          id: "last",
          agentId: agentIds[2]!,
          role: "Finisher",
          position: 2,
        },
        {
          id: "first",
          agentId: agentIds[0]!,
          role: "Planner",
          position: 0,
        },
        {
          id: "middle",
          agentId: agentIds[1]!,
          role: "Builder",
          position: 1,
        },
      ]),
    );

    const accepted = await service.startSession(created.id);
    expect(["queued", "running", "completed"]).toContain(accepted.status);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("completed");

    const detail = await service.getSession(created.id);
    expect(detail.turns.map((turn) => turn.participantId)).toEqual([
      "first",
      "middle",
      "last",
    ]);
    expect(detail.turns.map((turn) => turn.stepIndex)).toEqual([0, 1, 2]);
    expect(detail.turns.every((turn) => turn.status === "completed")).toBe(true);
    expect(invoker.calls.map((call) => call.agentId)).toEqual([
      agentIds[0],
      agentIds[1],
      agentIds[2],
    ]);
    expect(invoker.calls[1]?.prompt).toContain("result-1");
    const sequences = detail.events.map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_value, index) => index));
    expect(detail.events.at(-1)?.type).toBe("orchestration_completed");
    expect(detail.events.at(-1)?.completionReason).toBe("roster_exhausted");
  });

  it("repairs a completed dispatched turn from committed output without dispatching", async () => {
    const store = await makeStore();
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const agentId = agentIds[0]!;
    const participantId = "recovery-completed";
    const runId = "55555555-5555-4555-8555-555555555555";
    const turnId = "66666666-6666-4666-8666-666666666666";
    const timestamp = "2026-09-01T00:00:00.000Z";
    const output =
      "token: should-not-leak\nworkspacePath: /Users/darren/private\n" +
      "x".repeat(9_000);
    const session: OrchestrationSession = {
      id: sessionId,
      name: "Recoverable session",
      originalPrompt: "Recover the committed result.",
      participants: [{ id: participantId, agentId, role: "Worker", position: 0 }],
      mode: "sequential",
      status: "running",
      currentParticipantId: participantId,
      currentRunId: runId,
      stepIndex: 0,
      maxSteps: 1,
      perAgentTimeoutMs: 1_000,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
    };
    const turn: OrchestrationTurn = {
      id: turnId,
      sessionId,
      participantId,
      agentId,
      runId,
      position: 0,
      stepIndex: 0,
      status: "dispatched",
      safeInputSummary: "Recover the committed result.",
      safeOutput: null,
      outputTruncated: false,
      errorCode: null,
      createdAt: timestamp,
      completedAt: null,
    };
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "completed",
      prompt: "Recover the committed result.",
      output,
      error: null,
      usage: null,
      startedAt: timestamp,
      completedAt: "2026-09-01T00:00:01.000Z",
      createdAt: timestamp,
    };
    await store.mutate((database) => {
      database.orchestrations.push(session);
      database.orchestrationTurns.push(turn);
      database.runs.push(run);
    });

    const invoker = new ImmediateInvoker();
    const service = new OrchestrationService(store, makeAgentsAccess([]), invoker);
    await service.initialize();
    await service.initialize();

    const detail = await service.getSession(sessionId);
    expect(detail.session.status).toBe("interrupted");
    expect(detail.session.currentRunId).toBeNull();
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]).toMatchObject({
      id: turnId,
      runId,
      stepIndex: 0,
      status: "completed",
      outputTruncated: true,
    });
    expect(detail.turns[0]?.safeOutput).not.toContain("should-not-leak");
    expect(detail.turns[0]?.safeOutput).toContain("[REDACTED]");
    expect(detail.turns[0]?.safeOutput).toContain("[REDACTED PATH]");
    expect(detail.turns[0]?.safeOutput?.length).toBeLessThan(output.length);
    expect(detail.events.filter((event) => event.type === "run_completed")).toHaveLength(1);
    expect(detail.events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(invoker.calls).toHaveLength(0);
  });

  it("settles failed, cancelled, nonterminal, and missing child evidence safely", async () => {
    const store = await makeStore();
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const timestamp = "2026-09-01T00:00:00.000Z";
    const participants = [
      { id: "recovery-failed", agentId: agentIds[0]!, role: "Failed", position: 0 },
      { id: "recovery-cancelled", agentId: agentIds[1]!, role: "Cancelled", position: 1 },
      { id: "recovery-running", agentId: agentIds[2]!, role: "Running", position: 2 },
      { id: "recovery-missing", agentId: agentIds[0]!, role: "Missing", position: 3 },
    ];
    const session: OrchestrationSession = {
      id: sessionId,
      name: "Partial session",
      originalPrompt: "Inspect recovered child state.",
      participants,
      mode: "sequential",
      status: "interrupted",
      currentParticipantId: null,
      currentRunId: null,
      stepIndex: 4,
      maxSteps: 4,
      perAgentTimeoutMs: 1_000,
      errorCode: "ORCHESTRATION_INTERRUPTED",
      errorMessage: "Orchestration was interrupted because the server restarted",
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
    };
    const runs: AgentRun[] = [
      {
        id: "88888888-8888-4888-8888-888888888880",
        agentId: participants[0]!.agentId,
        status: "failed",
        prompt: "failed",
        output: null,
        error: "worker failed",
        errorCode: "MODEL_INFERENCE_LIMIT_EXCEEDED",
        usage: null,
        startedAt: timestamp,
        completedAt: timestamp,
        createdAt: timestamp,
      },
      {
        id: "88888888-8888-4888-8888-888888888881",
        agentId: participants[1]!.agentId,
        status: "cancelled",
        prompt: "cancelled",
        output: null,
        error: "Run cancelled",
        usage: null,
        startedAt: timestamp,
        completedAt: timestamp,
        createdAt: timestamp,
      },
      {
        id: "88888888-8888-4888-8888-888888888882",
        agentId: participants[2]!.agentId,
        status: "running",
        prompt: "running",
        output: null,
        error: null,
        usage: null,
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
      },
    ];
    const turns: OrchestrationTurn[] = participants.map((participant, index) => ({
      id: `99999999-9999-4999-8999-99999999999${index}`,
      sessionId,
      participantId: participant.id,
      agentId: participant.agentId,
      runId:
        index < runs.length
          ? runs[index]!.id
          : "88888888-8888-4888-8888-888888888883",
      position: participant.position,
      stepIndex: index,
      status: "dispatched",
      safeInputSummary: participant.role,
      safeOutput: null,
      outputTruncated: false,
      errorCode: null,
      createdAt: timestamp,
      completedAt: null,
    }));
    await store.mutate((database) => {
      database.orchestrations.push(session);
      database.orchestrationTurns.push(...turns);
      database.runs.push(...runs);
    });

    const invoker = new ImmediateInvoker();
    const service = new OrchestrationService(store, makeAgentsAccess([]), invoker);
    await service.initialize();

    const detail = await service.getSession(sessionId);
    expect(detail.session.status).toBe("interrupted");
    expect(detail.turns.map((turn) => [turn.status, turn.errorCode])).toEqual([
      ["failed", "MODEL_INFERENCE_LIMIT_EXCEEDED"],
      ["cancelled", "RUN_CANCELLED"],
      ["cancelled", "ORCHESTRATION_INTERRUPTED"],
      ["failed", "RUN_NOT_FOUND"],
    ]);
    expect(detail.turns.map((turn) => turn.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(detail.events.filter((event) => event.type === "participant_failed")).toHaveLength(2);
    expect(detail.events.filter((event) => event.type === "child_run_cancelled")).toHaveLength(2);
    expect(invoker.calls).toHaveLength(0);
  });

  it("fails a round-robin session at maxSteps and persists execution step indices", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ImmediateInvoker();
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession({
      ...makeInput(),
      mode: "round_robin",
      maxSteps: 5,
    });

    await service.startSession(created.id);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorCode).toBe("MAX_STEPS_EXCEEDED");
    expect(terminal.completionReason).toBeNull();

    const detail = await service.getSession(created.id);
    expect(detail.turns.map((turn) => turn.stepIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(detail.turns.map((turn) => turn.participantId)).toEqual([
      "participant-0",
      "participant-1",
      "participant-2",
      "participant-0",
      "participant-1",
    ]);
    expect(invoker.calls).toHaveLength(5);
    expect(detail.events.at(-1)).toMatchObject({
      type: "orchestration_failed",
      errorCode: "MAX_STEPS_EXCEEDED",
    });
    expect(detail.events.at(-1)?.completionReason).toBeUndefined();
  });

  it("revalidates each dispatch and fails before invoking an unavailable next Agent", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ImmediateInvoker();
    let dispatchChecks = 0;
    const access: OrchestrationAgentAccess = {
      listAgents: () => {
        dispatchChecks += 1;
        if (dispatchChecks >= 3) agents[1]!.status = "stopped";
        return agents;
      },
    };
    const service = new OrchestrationService(store, access, invoker);
    const created = await service.createSession(makeInput());

    await service.startSession(created.id);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorCode).toBe("AGENT_STOPPED");
    expect(invoker.calls).toHaveLength(1);
    const detail = await service.getSession(created.id);
    expect(detail.turns).toHaveLength(1);
    expect(detail.events.some((event) => event.type === "participant_failed")).toBe(
      true,
    );
  });

  it("stops and quiesces an active session through its accepted child Run", async () => {
    const store = await makeStore();
    const agents = [makeAgent(agentIds[0]!)];
    const invoker = new PendingInvoker();
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession(
      makeInput([
        {
          id: "worker",
          agentId: agentIds[0]!,
          role: "Worker",
          position: 0,
        },
      ]),
    );
    await service.startSession(created.id);
    for (let attempt = 0; attempt < 100 && invoker.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect(invoker.calls).toHaveLength(1);

    const stopped = await service.stopSession(created.id);
    expect(stopped.status).toBe("stopped");
    expect(invoker.cancellations).toEqual([
      "00000000-0000-4000-8000-000000000099",
    ]);
    expect((await service.getSession(created.id)).events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["child_run_cancelled", "orchestration_stopped"]),
    );
    expect(agents[0]?.status).toBe("ready");

    const quiesced = await service.createSession(
      makeInput([
        {
          id: "worker",
          agentId: agentIds[0]!,
          role: "Worker",
          position: 0,
        },
      ]),
    );
    await service.startSession(quiesced.id);
    for (let attempt = 0; attempt < 100 && invoker.calls.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect(invoker.calls).toHaveLength(2);

    await service.quiesceForStorageFailure({ timeoutMs: 1_000 });

    // Fatal Team shutdown uses the memory-only physical seam. In particular,
    // it must not route through AgentService.cancelRun and its Storage read.
    expect(invoker.storageFailureCancellations).toEqual([
      "00000000-0000-4000-8000-000000000099",
    ]);
    expect(invoker.cancellations).toHaveLength(1);
  });

  it("snapshots the server-wide supervisor model and passes it to routing", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    } as const;
    agents[1]!.modelRef = supervisorModel;
    await store.mutate((database) => database.agents.push(...agents));
    let selectedModel: string | undefined;
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker: new ImmediateInvoker(),
      selectNextParticipant: async (input) => {
        selectedModel = input.supervisorModel;
        return { kind: "end", reason: "supervisor_completed" };
      },
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
        catalogRevision: 7,
      }),
    });
    const created = await service.createSession({
      ...makeInput([{
        id: "worker",
        agentId: agentIds[0]!,
        role: "Worker",
        position: 0,
      }]),
      mode: "supervisor",
    });

    // No Agent is designated to supervise, and none is consumed by it.
    expect(created.supervisorAgentId).toBeUndefined();

    await service.startSession(created.id);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("completed");
    expect(selectedModel).toBe(supervisorModel.modelId);
    expect(terminal).toMatchObject({
      supervisorModelRef: supervisorModel,
      supervisorModelCatalogRevision: 7,
    });
    expect(terminal.supervisorAgentId).toBeUndefined();
  });

  it("routes with no Agents in the roster at all", async () => {
    const store = await makeStore();
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    } as const;
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess([]),
      invoker: new ImmediateInvoker(),
      selectNextParticipant: async () => ({
        kind: "end",
        reason: "supervisor_completed",
      }),
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
      }),
    });

    // Supervision costs no Agent, so an empty roster is a roster problem only
    // — never a missing-supervisor problem.
    const created = await service.createSession({
      name: "No roster",
      originalPrompt: "",
      participants: [],
      projectId: "44444444-4444-4444-8444-444444444444",
      mode: "supervisor",
      maxSteps: 4,
      perAgentTimeoutMs: 1_000,
    });

    expect(created.status).toBe("draft");
    expect(created.supervisorAgentId).toBeUndefined();
  });

  it("starts an empty Workspace draft from its first prompt", async () => {
    const store = await makeStore();
    const projectId = "44444444-4444-4444-8444-444444444444";
    const agents = [makeAgent(agentIds[0]!)];
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    } as const;
    agents[0]!.modelRef = supervisorModel;
    await store.mutate((database) => {
      database.projects.push({
        id: projectId,
        name: "Workspace",
        description: "",
        workspacePath: "/tmp/workspace",
        teamId: null,
        ownerPrincipalId: "demo-owner",
        status: "active",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
      database.agents.push(...agents);
      database.projectAgents.push({
        projectId,
        agentId: agents[0]!.id,
        codexThreadId: null,
        attachedAt: "2026-08-28T00:00:00.000Z",
        role: "editor",
        toolGrants: [],
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
    });
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker: new ImmediateInvoker(),
      selectNextParticipant: async () => ({
        kind: "end",
        reason: "supervisor_completed",
      }),
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
        catalogRevision: 8,
      }),
    });
    const created = await service.createSession({
      name: "Workspace draft",
      originalPrompt: "",
      participants: [],
      projectId,
      mode: "supervisor",
      maxSteps: 4,
      perAgentTimeoutMs: 1_000,
    });

    expect(created.status).toBe("draft");
    expect(created.supervisorAgentId).toBeUndefined();

    const accepted = await service.startSession(created.id, "Ship the change");
    expect(["queued", "running", "completed"]).toContain(accepted.status);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal).toMatchObject({
      status: "completed",
      originalPrompt: "Ship the change",
      supervisorModelRef: supervisorModel,
      supervisorModelCatalogRevision: 8,
    });
    expect(terminal.participants).toMatchObject([
      {
        agentId: agents[0]!.id,
        role: "editor",
        position: 0,
      },
    ]);
  });

  it("runs a legacy draft that still carries a supervisor Agent ID", async () => {
    const store = await makeStore();
    const agents = [makeAgent(agentIds[0]!)];
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    } as const;
    agents[0]!.modelRef = supervisorModel;
    await store.mutate((database) => database.agents.push(...agents));
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker: new ImmediateInvoker(),
      selectNextParticipant: async () => ({
        kind: "end",
        reason: "supervisor_completed",
      }),
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
      }),
    });
    const created = await service.createSession({
      ...makeInput([{
        id: "worker",
        agentId: agents[0]!.id,
        role: "Worker",
        position: 0,
      }]),
      mode: "supervisor",
    });
    // Records written before routing became a model still carry the field.
    // It must stay loadable and must not influence which model routes.
    await store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === created.id);
      if (session) session.supervisorAgentId = agents[0]!.id;
    });

    const accepted = await service.startSession(created.id);
    expect(["queued", "running", "completed"]).toContain(accepted.status);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("completed");
    expect(terminal.supervisorModelRef).toEqual(supervisorModel);
  });

  it("audits one span tree rooted at the orchestration for every child Run", async () => {
    const audit = new RecordingAudit();
    const { service: agentService, store } = await makePlatformAgentService(audit);
    const planner = await agentService.createAgent({
      name: "Planner",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const builder = await agentService.createAgent({
      name: "Builder",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const service = new OrchestrationService({ store, agentService, audit });
    const created = await service.createSession({
      name: "Traced pipeline",
      originalPrompt: "Ship the requested change safely.",
      participants: [
        { id: "first", agentId: planner.id, role: "Planner", position: 0 },
        { id: "second", agentId: builder.id, role: "Builder", position: 1 },
      ],
      maxSteps: 2,
      perAgentTimeoutMs: 5_000,
    });

    await service.startSession(created.id);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("completed");

    const roots = audit.ofType("orchestration_started");
    expect(roots).toHaveLength(1);
    const root = roots[0]?.span;
    expect(root?.traceId).toBe(created.id);
    expect(root?.parentSpanId).toBeUndefined();

    const dispatched = audit.ofType("participant_dispatched");
    expect(dispatched).toHaveLength(2);
    for (const event of dispatched) {
      expect(event.span?.parentSpanId).toBe(root?.spanId);
      expect(event.span?.traceId).toBe(created.id);
    }
    const participantSpanIds = dispatched.map((event) => event.span?.spanId);

    const started = audit.ofType("run_started");
    expect(started).toHaveLength(2);
    for (const event of started) {
      expect(event.orchestrationId).toBe(created.id);
      expect(event.span?.traceId).toBe(created.id);
      expect(participantSpanIds).toContain(event.span?.parentSpanId);
    }

    const completed = audit.ofType("run_completed");
    expect(completed).toHaveLength(2);
    for (const event of completed) {
      expect(started.some((item) => item.span?.spanId === event.span?.spanId)).toBe(true);
      expect(typeof event.durationMs).toBe("number");
    }

    const finished = audit.ofType("orchestration_completed");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.span?.spanId).toBe(root?.spanId);
    expect(typeof finished[0]?.durationMs).toBe("number");
  });
});
