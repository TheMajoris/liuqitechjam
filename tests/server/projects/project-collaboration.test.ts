import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultAuthorizationService } from "../../../apps/server/src/access/default-authorization-service.js";
import { AgentService } from "../../../apps/server/src/agent-service.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import { OrchestrationService } from "../../../apps/server/src/orchestration/orchestration-service.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../../apps/server/src/types.js";
import { WorkspaceManager } from "../../../apps/server/src/workspace.js";
import { ProjectServiceExecutionScope } from "../../../apps/server/src/projects/project-execution.js";
import { ProjectService } from "../../../apps/server/src/projects/project-service.js";
import { ProjectWorkspaceManager } from "../../../apps/server/src/projects/project-workspace.js";
import { ProjectWriteLeaseCoordinator } from "../../../apps/server/src/projects/project-write-lease-coordinator.js";
import type { RuntimeReconciliationResult } from "../../../apps/server/src/types.js";
import type { Database } from "../../../apps/server/src/types.js";
import type { Storage, StorageFatalHandler } from "../../../apps/server/src/store.js";
import type { ApplicationLifecycleFailure } from "../../../apps/server/src/application-health.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A runner that actually touches the filesystem it is handed.
 *
 * The whole point of this wave is which directory gets mounted, so the proof
 * has to be a real read and a real write, not a recorded argument.
 */
class FileWritingRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  /** Appended to app.txt; falls back to the acting Agent ID. */
  nextLine = "";

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    const target = path.join(request.workspacePath, "app.txt");
    const existing = await readFile(target, "utf8").catch(() => "");
    await writeFile(target, existing + (this.nextLine || request.agentId) + "\n", "utf8");
    const instructions = await readFile(
      path.join(request.workspacePath, "AGENTS.md"),
      "utf8",
    ).catch(() => "");
    return {
      output: "read:" + JSON.stringify(existing) + " agents:" + instructions.length,
      threadId: request.threadId ?? "thread-" + request.agentId,
      usage: null,
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Makes only the idempotent lease-removal mutation fail after the worker ran. */
class FailingLeaseReleaseStore implements Storage {
  failReleases = false;
  failArchive = false;

  constructor(private readonly inner: Storage) {}

  async initialize(): Promise<void> {
    await this.inner.initialize();
  }

  snapshot(): Database {
    return this.inner.snapshot();
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    return this.inner.mutate(async (database) => {
      const before = database.projectLeases.length;
      const result = await mutation(database);
      if (this.failReleases && database.projectLeases.length < before) {
        throw new Error("lease release unavailable");
      }
      if (this.failArchive && database.projects.some((project) => project.status === "archived")) {
        this.failArchive = false;
        throw new Error("archive persistence unavailable");
      }
      return result;
    });
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setFatalHandler(handler: StorageFatalHandler | undefined): void {
    this.inner.setFatalHandler?.(handler);
  }
}

class ReleaseFlagRunner extends FileWritingRunner {
  constructor(private readonly afterRun: () => void) {
    super();
  }

  override async run(request: RunnerRequest): Promise<RunnerResult> {
    const result = await super.run(request);
    this.afterRun();
    return result;
  }
}

async function makeStack(
  runner: AgentRunner = new FileWritingRunner(),
  options: { storeFactory?: (filePath: string) => Storage } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "project-collab-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    WORKER_CURATED_MODELS: "ep-test",
  });
  const storePath = path.join(root, "data", "db.json");
  const store = options.storeFactory?.(storePath) ?? new JsonStore(storePath);
  const agentService = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await agentService.initialize();
  const projectService = new ProjectService(
    store,
    new ProjectWorkspaceManager(path.join(root, "data", "projects")),
    agentService,
    new DefaultAuthorizationService(),
  );
  await projectService.initialize();
  agentService.setProjectExecutionScope(new ProjectServiceExecutionScope(projectService));
  return { agentService, projectService, runner, root, store };
}

async function runProjectTurn(
  agentService: AgentService,
  agentId: string,
  projectId: string,
  prompt: string,
) {
  const { run } = await agentService.sendMessage(agentId, prompt, { projectId });
  return agentService.waitForRun(run.id, { timeoutMs: 5_000 });
}

describe("Shared Project collaboration", () => {
  it("writes an explicit membership tier on attach and honours an owner attach", async () => {
    const { agentService, projectService } = await makeStack(new FileWritingRunner());
    const member = await agentService.createAgent({
      name: "member",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const lead = await agentService.createAgent({
      name: "lead",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const project = await projectService.create({ name: "Roles" });

    // The default is still editor, but it is now written, not inferred by
    // three separate read-side fallbacks.
    const withDefault = await projectService.attachAgent(project.id, member.id);
    expect(
      withDefault.memberships.find((m) => m.agentId === member.id)?.role,
    ).toBe("editor");

    const withOwner = await projectService.attachAgent(
      project.id,
      lead.id,
      undefined,
      "owner",
    );
    expect(
      withOwner.memberships.find((m) => m.agentId === lead.id)?.role,
    ).toBe("owner");
  });

  it("lets a second Agent read and modify the first Agent's Project files", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({
      name: "fe",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const builder = await agentService.createAgent({
      name: "fe builder2",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);
    await projectService.attachAgent(project.id, builder.id);

    runner.nextLine = "written-by-fe";
    const first = await runProjectTurn(agentService, fe.id, project.id, "build the app");
    expect(first.status).toBe("completed");

    runner.nextLine = "written-by-builder";
    const second = await runProjectTurn(
      agentService,
      builder.id,
      project.id,
      "improve the app",
    );
    expect(second.status).toBe("completed");

    // The second Agent saw the first Agent's file before writing its own line.
    expect(second.output).toContain('read:"written-by-fe\\n"');

    const scope = projectService.projectRunScope(project.id, fe.id);
    const instructions = await readFile(
      path.join(scope.workspacePath, "AGENTS.md"),
      "utf8",
    );
    expect(instructions).toContain(
      "current response-language policy, assigned platform skills, and capability availability",
    );
    const shared = await readFile(path.join(scope.workspacePath, "app.txt"), "utf8");
    expect(shared).toBe("written-by-fe\nwritten-by-builder\n");

    // Neither Agent's private workspace received the shared artifact.
    await expect(
      readFile(path.join(agentService.getAgent(fe.id).workspacePath, "app.txt"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(agentService.getAgent(builder.id).workspacePath, "app.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("keeps private and shared Codex sessions independent", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({
      name: "fe",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);

    // A private Playground turn establishes the Agent's own thread.
    const privateRun = await agentService.sendMessage(fe.id, "private work");
    await agentService.waitForRun(privateRun.run.id, { timeoutMs: 5_000 });
    const privateThread = agentService.listConversations(fe.id)[0]?.codexThreadId;
    expect(privateThread).toBe("thread-" + fe.id);

    await runProjectTurn(agentService, fe.id, project.id, "shared work");

    // The Project turn resumed nothing and left the private thread untouched.
    expect(runner.requests[1]?.threadId).toBeNull();
    expect(agentService.listConversations(fe.id)[0]?.codexThreadId).toBe(privateThread);
    expect(projectService.projectRunScope(project.id, fe.id).codexThreadId).toBe(
      "thread-" + fe.id,
    );

    // A later Project turn resumes the shared-scope thread, not the private one.
    await runProjectTurn(agentService, fe.id, project.id, "more shared work");
    expect(runner.requests[2]?.threadId).toBe("thread-" + fe.id);
  });

  it("refuses a Project turn for an Agent that is not attached", async () => {
    const { agentService, projectService } = await makeStack();
    const fe = await agentService.createAgent({
      name: "fe",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const project = await projectService.create({ name: "Todo App" });

    await expect(
      agentService.sendMessage(fe.id, "sneak in", { projectId: project.id }),
    ).rejects.toMatchObject({ code: "PROJECT_AGENT_NOT_ATTACHED" });
    // The rejected attempt left no Run or message behind.
    expect(agentService.getRuns(fe.id)).toHaveLength(0);
    expect(agentService.getMessages(fe.id)).toHaveLength(0);
  });

  it("cancels a Project lease waiter before preparation or runner dispatch", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const holder = await agentService.createAgent({
      name: "holder",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const waiter = await agentService.createAgent({
      name: "waiter",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, holder.id);
    await projectService.attachAgent(project.id, waiter.id);
    await projectService.acquireWriteLease(project.id, holder.id, "held-run");

    const controller = new AbortController();
    const { run } = await agentService.sendMessage(waiter.id, "blocked", {
      projectId: project.id,
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(agentService.getRun(run.id).status).toBe("running"),
    );
    controller.abort();

    await expect(agentService.waitForRun(run.id, { timeoutMs: 5_000 })).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(runner.requests).toHaveLength(0);
    await projectService.releaseWriteLease(project.id, "held-run");
  });

  it("keeps committed output and blocks reuse when settled lease release fails", async () => {
    let storage!: FailingLeaseReleaseStore;
    const runner = new ReleaseFlagRunner(() => {
      storage.failReleases = true;
    });
    const { agentService, projectService } = await makeStack(runner, {
      storeFactory: (filePath) => {
        storage = new FailingLeaseReleaseStore(new JsonStore(filePath));
        return storage;
      },
    });
    const failures: ApplicationLifecycleFailure[] = [];
    projectService.setLifecycleFailureSink({
      reportLifecycleFailure: (failure) => failures.push(failure),
    });
    const agent = await agentService.createAgent({
      name: "Lease cleanup",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const project = await projectService.create({ name: "Recovery gate" });
    await projectService.attachAgent(project.id, agent.id);
    runner.nextLine = "write output before cleanup";

    const completed = await runProjectTurn(
      agentService,
      agent.id,
      project.id,
      "write output before cleanup",
    );

    expect(completed.status).toBe("completed");
    expect(completed.output).toBeTruthy();
    const scope = projectService.projectRunScope(project.id, agent.id);
    expect(await readFile(path.join(scope.workspacePath, "app.txt"), "utf8")).toBe(
      "write output before cleanup\n",
    );
    expect(failures.some((failure) => failure.code === "PROJECT_LEASE_RELEASE_FAILED"))
      .toBe(true);
    await expect(projectService.get(project.id)).resolves.toMatchObject({
      recoveryRequired: true,
    });
    await expect(
      agentService.sendMessage(agent.id, "must remain blocked", { projectId: project.id }),
    ).rejects.toMatchObject({ code: "PROJECT_RECOVERY_REQUIRED" });
    expect(agentService.getRuns(agent.id)).toHaveLength(1);
  });

  it("retains a Project lease when startup runtime cleanup is unresolved", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-reconcile-"));
    roots.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    const projectId = "project-recovery";
    const agentId = "agent-recovery";
    const runId = "run-recovery";
    await store.mutate((database) => {
      database.projectLeases.push({
        projectId,
        agentId,
        runId,
        acquiredAt: new Date().toISOString(),
      });
    });
    const coordinator = new ProjectWriteLeaseCoordinator(
      store,
      async () => undefined,
    );
    const unresolved: RuntimeReconciliationResult = {
      provider: "container",
      confirmedAgentIds: [],
      confirmedPreviewIds: [],
      unresolvedAgentIds: [agentId],
      unresolvedPreviewIds: [],
    };

    await coordinator.initialize(unresolved);

    expect(store.snapshot().projectLeases).toHaveLength(1);
    expect(coordinator.isRecoveryRequired(projectId)).toBe(true);
    expect(() => coordinator.assertProjectRecoveryClear(projectId)).toThrow(
      "operator recovery",
    );
  });

  it("rejects membership changes while archive compensation is in progress", async () => {
    const { agentService, projectService } = await makeStack();
    const original = await agentService.createAgent({
      name: "archive owner",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const newcomer = await agentService.createAgent({
      name: "late member",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const project = await projectService.create({ name: "Archive guard" });
    await projectService.attachAgent(project.id, original.id);

    let releaseArchive!: () => void;
    let archiveStarted!: () => void;
    const archivePaused = new Promise<void>((resolve) => {
      archiveStarted = resolve;
    });
    const archiveRelease = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    projectService.setProjectPreviewLifecycle({
      async stopForProject() {
        archiveStarted();
        await archiveRelease;
      },
    });

    const archive = projectService.archive(project.id);
    await archivePaused;
    await expect(projectService.attachAgent(project.id, newcomer.id)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });
    await expect(agentService.deleteAgent(original.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Another Agent is currently writing"),
    });
    await expect(projectService.get(project.id)).resolves.toMatchObject({
      agentIds: [original.id],
    });
    releaseArchive();

    await expect(archive).resolves.toMatchObject({ archivedWorkspace: expect.any(String) });
  });

  it("guards orchestration Project pointers through archive compensation", async () => {
    let storage!: FailingLeaseReleaseStore;
    const { projectService, store } = await makeStack(undefined, {
      storeFactory: (filePath) => {
        storage = new FailingLeaseReleaseStore(new JsonStore(filePath));
        return storage;
      },
    });
    const project = await projectService.create({ name: "Orchestration archive guard" });
    const orchestration = new OrchestrationService({
      store,
      agents: { listAgents: () => [] },
      projectBinding: {
        assertProjectMutationAllowed(projectId) {
          projectService.assertProjectMutationAllowed(projectId);
        },
      },
    });
    const session = await orchestration.createSession({
      name: "Archive race",
      originalPrompt: "Keep the saved conversation",
      projectId: project.id,
      participants: [
        {
          id: "participant-archive-race",
          agentId: "00000000-0000-4000-8000-000000000001",
          role: "builder",
          position: 0,
        },
      ],
      maxSteps: 1,
      perAgentTimeoutMs: 1_000,
    });
    await projectService.attachTeam(project.id, session.id);

    let releaseArchive!: () => void;
    let archiveStarted!: () => void;
    const archivePaused = new Promise<void>((resolve) => {
      archiveStarted = resolve;
    });
    const archiveRelease = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    projectService.setProjectPreviewLifecycle({
      async stopForProject() {
        archiveStarted();
        await archiveRelease;
      },
    });
    storage.failArchive = true;

    const archive = projectService.archive(project.id);
    await archivePaused;
    await expect(orchestration.deleteSession(session.id)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });
    await expect(orchestration.removeSessionsForProject(project.id)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });
    releaseArchive();

    await expect(archive).rejects.toThrow("archive persistence unavailable");
    expect(store.snapshot().projects.find((item) => item.id === project.id)).toMatchObject({
      status: "active",
      teamId: session.id,
    });
    expect(store.snapshot().orchestrations.some((item) => item.id === session.id)).toBe(true);
  });

  it("rechecks the archive guard after lease authorization yields", async () => {
    const { store } = await makeStack();
    let authorizationCalls = 0;
    let authorizationStarted!: () => void;
    const authorizationPaused = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    let releaseAuthorization!: () => void;
    const authorizationRelease = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const coordinator = new ProjectWriteLeaseCoordinator(
      store,
      async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 2) {
          authorizationStarted();
          await authorizationRelease;
        }
      },
    );

    const acquire = coordinator.acquire(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "run-archive-race",
    );
    await authorizationPaused;
    coordinator.beginArchive("00000000-0000-4000-8000-000000000002");
    releaseAuthorization();

    await expect(acquire).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    expect(store.snapshot().projectLeases).toHaveLength(0);
    coordinator.endArchive("00000000-0000-4000-8000-000000000002");
  });

  it("blocks a run when the active Project directory is missing", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const agent = await agentService.createAgent({
      name: "missing workspace",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const project = await projectService.create({ name: "Missing workspace" });
    await projectService.attachAgent(project.id, agent.id);
    const workspacePath = projectService.projectRunScope(project.id, agent.id).workspacePath;
    await rm(workspacePath, { recursive: true, force: true });

    await expect(
      agentService.sendMessage(agent.id, "must not recreate", { projectId: project.id }),
    ).rejects.toMatchObject({
      code: "PROJECT_WORKSPACE_INVALID",
      message: expect.stringContaining("operator recovery"),
    });
    expect(runner.requests).toHaveLength(0);
    await expect(lstat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fences native tool approvals before permanently deleting a Project", async () => {
    const { projectService } = await makeStack();
    const project = await projectService.create({ name: "Approval fence" });
    const invalidated: string[] = [];
    projectService.setToolApprovalInvalidator({
      async invalidateForAgent() {
        return 0;
      },
      async invalidateForProject(projectId) {
        invalidated.push(projectId);
        return 1;
      },
    });

    await projectService.deletePermanently(project.id);

    expect(invalidated).toEqual([project.id]);
  });
});
