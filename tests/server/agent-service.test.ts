import { mkdtemp, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../apps/server/src/agent-service.js";
import type {
  AuthorizationRequest,
  AuthorizationService,
} from "../../apps/server/src/access/authorization-service.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { RunCancelledError } from "../../apps/server/src/errors.js";
import { JsonStore } from "../../apps/server/src/store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../apps/server/src/types.js";
import { WorkspaceManager } from "../../apps/server/src/workspace.js";
import type { PreviewLifecycleCleanup } from "../../apps/server/src/preview/preview-service.js";
import type {
  AgentPreviewContext,
  PreviewContextProvider,
} from "../../apps/server/src/preview/preview-context-provider.js";
import { createBuiltInSkillRegistry, SkillService } from "../../apps/server/src/skills/index.js";
import type { ToolCapabilitiesView } from "../../apps/server/src/tools/tool-types.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class CapturingRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "captured-thread",
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

class DeferredRunner implements AgentRunner {
  private resolveRun: ((result: RunnerResult) => void) | null = null;
  private rejectRun: ((error: unknown) => void) | null = null;
  cancelCalls = 0;

  run(): Promise<RunnerResult> {
    return new Promise<RunnerResult>((resolve, reject) => {
      this.resolveRun = resolve;
      this.rejectRun = reject;
    });
  }

  resolve(result: RunnerResult): void {
    this.resolveRun?.(result);
  }

  reject(error: unknown): void {
    this.rejectRun?.(error);
  }

  async cancel(): Promise<boolean> {
    this.cancelCalls += 1;
    this.reject(new RunCancelledError());
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];
/** Lets a test rewind the store to a pre-conversation shape. */
const serviceStores = new WeakMap<AgentService, JsonStore>();

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  options: {
    curatedModels?: string;
    arkModel?: string;
    previewLifecycle?: PreviewLifecycleCleanup;
    previewContext?: PreviewContextProvider;
    skillService?: SkillService;
  } = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: options.arkModel ?? "ep-test",
    WORKER_CURATED_MODELS: options.curatedModels ?? "",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    undefined,
    options.previewLifecycle,
    options.previewContext,
    options.skillService,
  );
  await service.initialize();
  serviceStores.set(service, store);
  return service;
}

describe("Agent lifecycle", () => {
  it("accepts an optional global role and allows it to be cleared", async () => {
    const service = await makeService();
    const store = serviceStores.get(service)!;
    await store.mutate((database) => {
      database.roles.push({
        id: "global-role",
        name: "Global role",
        description: "",
        skillIds: [],
        toolIds: [],
        permissionIds: [],
        source: "user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    const agent = await service.createAgent({ name: "Roleful", globalRoleId: "global-role" });
    expect(agent.globalRoleId).toBe("global-role");
    await expect(
      service.createAgent({ name: "Unknown role", globalRoleId: "missing-role" }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });

    const cleared = await service.updateAgent(agent.id, { globalRoleId: null });
    expect(cleared).not.toHaveProperty("globalRoleId");
  });

  it("assigns the configured default model to a new Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Defaulted" });

    expect(agent.modelRef).toEqual({
      providerId: "volcengine_ark",
      modelId: "ep-test",
    });
  });

  it("persists an explicit model assignment and forwards it per run", async () => {
    const runner = new CapturingRunner();
    const service = await makeService(runner, { curatedModels: "ep-worker-b" });
    const agent = await service.createAgent({
      name: "Assigned",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-worker-b" },
    });

    expect(agent.modelRef).toEqual({
      providerId: "volcengine_ark",
      modelId: "ep-worker-b",
    });
    const { run } = await service.sendMessage(agent.id, "use the assignment");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(runner.requests[0]?.model).toEqual({
      providerId: "volcengine_ark",
      modelId: "ep-worker-b",
      codexModel: "ep-worker-b",
      usesDefaultModel: false,
    });
  });

  it("resets only the active thread when the worker model changes", async () => {
    const runner = new CapturingRunner();
    const service = await makeService(runner, { curatedModels: "ep-worker-b" });
    const agent = await service.createAgent({
      name: "Session reset",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-worker-b" },
    });
    const first = await service.sendMessage(agent.id, "first model");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    expect(service.listConversations(agent.id)[0]?.codexThreadId).toBe("captured-thread");

    const updated = await service.updateAgent(agent.id, {
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    expect(updated.codexThreadId).toBeNull();
    // A model change invalidates every private conversation session too.
    expect(service.listConversations(agent.id)[0]?.codexThreadId).toBeNull();
    expect(service.getRuns(agent.id)).toHaveLength(1);
    expect(service.getMessages(agent.id)).toHaveLength(2);

    const second = await service.sendMessage(agent.id, "second model");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(runner.requests.at(-1)?.threadId).toBeNull();
    expect(runner.requests.at(-1)?.model?.modelId).toBe("ep-test");
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("authorizes every affected skill resource and leaves assignment unchanged on denial", async () => {
    const requests: AuthorizationRequest[] = [];
    let denyCodeReview = false;
    const authorization: AuthorizationService = {
      decide: async () => ({ result: "allow", reason: "test" }),
      require: async (request) => {
        requests.push(request);
        if (
          denyCodeReview &&
          request.resource?.kind === "skill" &&
          request.resource.id === "code-review"
        ) {
          throw new Error("skill denied");
        }
      },
    };
    const skillService = new SkillService(
      createBuiltInSkillRegistry(),
      {
        listMetadata: () => [],
        listCapabilities: async (): Promise<ToolCapabilitiesView> => ({
          agentId: "agent",
          projectId: null,
          tools: [],
        }),
      },
      authorization,
    );
    const service = await makeService(new FakeRunner(), { skillService });
    const agent = await service.createAgent({ name: "Skill owner" });
    await service.updateAgent(agent.id, { skillIds: ["research"] });

    requests.length = 0;
    denyCodeReview = true;
    await expect(
      service.updateAgent(agent.id, { skillIds: ["code-review"] }),
    ).rejects.toThrow("skill denied");

    expect(requests.map((request) => request.resource)).toEqual([
      { kind: "skill", id: "research" },
      { kind: "skill", id: "code-review" },
    ]);
    expect(service.getAgent(agent.id).skillIds).toEqual(["research"]);
  });

  it("removes Project attachments and stale leases when deleting an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Project builder" });
    const store = serviceStores.get(service)!;
    await store.mutate((database) => {
      database.projectAgents.push({
        projectId: "project-1",
        agentId: agent.id,
        codexThreadId: null,
        attachedAt: agent.createdAt,
        role: "editor",
        toolGrants: [],
        updatedAt: agent.updatedAt,
      });
      database.projectLeases.push({
        projectId: "project-1",
        agentId: agent.id,
        runId: "run-1",
        acquiredAt: agent.createdAt,
      });
    });

    await service.deleteAgent(agent.id);

    expect(store.snapshot().projectAgents).toEqual([]);
    expect(store.snapshot().projectLeases).toEqual([]);
  });

  it("closes the preview start gate before stop and delete cleanup", async () => {
    let service!: AgentService;
    const statusesAtCleanup: string[] = [];
    service = await makeService(new FakeRunner(), {
      previewLifecycle: {
        stopForAgent: async (agentId) => {
          statusesAtCleanup.push(service.getAgent(agentId).status);
        },
      },
    });
    const agent = await service.createAgent({ name: "Preview owner" });

    await service.stopAgent(agent.id);
    await service.startAgent(agent.id);
    await service.deleteAgent(agent.id);

    expect(statusesAtCleanup).toEqual(["stopped", "stopped"]);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.listConversations(agent.id)[0]?.codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("waits for a Run to reach a terminal state and returns its final output", async () => {
    const runner = new DeferredRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Waiter" });
    const { run } = await service.sendMessage(agent.id, "wait for me");

    await expect.poll(() => service.getRun(run.id).status).toBe("running");
    const waiting = service.waitForRun(run.id, { timeoutMs: 1_000 });
    runner.resolve({ output: "finished", threadId: "thread", usage: null });

    await expect(waiting).resolves.toMatchObject({
      id: run.id,
      status: "completed",
      output: "finished",
    });
  });

  it("resolves failed and cancelled terminal Runs instead of hiding their status", async () => {
    const failedService = await makeService({
      run: async () => {
        throw new Error("runner failed");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const failedAgent = await failedService.createAgent({ name: "Failure" });
    const failed = await failedService.sendMessage(failedAgent.id, "fail");
    await expect
      .poll(() => failedService.getRun(failed.run.id).status)
      .toBe("failed");
    await expect(failedService.waitForRun(failed.run.id, { timeoutMs: 1_000 })).resolves.toMatchObject({
      status: "failed",
      error: "runner failed",
    });

    const cancelledRunner = new DeferredRunner();
    const cancelledService = await makeService(cancelledRunner);
    const cancelledAgent = await cancelledService.createAgent({ name: "Cancelled" });
    const cancelled = await cancelledService.sendMessage(cancelledAgent.id, "cancel");
    await expect.poll(() => cancelledService.getRun(cancelled.run.id).status).toBe("running");
    await cancelledService.cancelRun(cancelled.run.id);
    await expect(cancelledService.waitForRun(cancelled.run.id, { timeoutMs: 1_000 })).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("persists only a safe runtime error when a runner returns raw diagnostics", async () => {
    const service = await makeService({
      run: async () => {
        throw new Error(
          'Codex exited with code 1: stderr: {"token":"secret-value","cwd":"/Users/private/workspace"}',
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Safe failure" });
    const failed = await service.sendMessage(agent.id, "fail safely");

    await expect.poll(() => service.getRun(failed.run.id).status).toBe("failed");
    expect(service.getRun(failed.run.id).error).toBe("Agent runtime failed");
    expect(service.getAgent(agent.id).lastError).toBe("Agent runtime failed");
  });

  it("rejects a wait on timeout and abort while cleaning up the poll", async () => {
    const runner = new DeferredRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Wait controls" });
    const { run } = await service.sendMessage(agent.id, "keep waiting");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");

    await expect(service.waitForRun(run.id, { timeoutMs: 20 })).rejects.toMatchObject({
      name: "TimeoutError",
    });

    const controller = new AbortController();
    const aborted = service.waitForRun(run.id, {
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    await service.cancelRun(run.id);
  });

  it("cancels only the selected Run, leaves the Agent ready, and is idempotent", async () => {
    const runner = new DeferredRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Cancelable" });
    const { run } = await service.sendMessage(agent.id, "cancel this");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");

    const cancelled = await service.cancelRun(run.id);
    expect(cancelled).toMatchObject({ id: run.id, status: "cancelled" });
    expect(service.getAgent(agent.id).status).toBe("ready");
    expect(runner.cancelCalls).toBe(1);

    const repeated = await service.cancelRun(run.id);
    expect(repeated).toMatchObject({ id: run.id, status: "cancelled" });
    expect(runner.cancelCalls).toBe(1);
  });

  it("does not turn a naturally completed Run into a cancellation", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Race" });
    const { run } = await service.sendMessage(agent.id, "finish first");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const result = await service.cancelRun(run.id);
    expect(result).toMatchObject({ id: run.id, status: "completed" });
  });
});

class StubPreviewContextProvider implements PreviewContextProvider {
  readonly requestedAgentIds: string[] = [];

  constructor(private readonly context: AgentPreviewContext) {}

  async getForAgent(agentId: string): Promise<AgentPreviewContext> {
    this.requestedAgentIds.push(agentId);
    return this.context;
  }
}

describe("Agent Preview awareness", () => {
  it("gives the worker trusted Preview state while a Preview is running", async () => {
    const runner = new CapturingRunner();
    const previewContext = new StubPreviewContextProvider({ status: "running" });
    const service = await makeService(runner, { previewContext });
    const agent = await service.createAgent({ name: "Aware" });

    const { run } = await service.sendMessage(agent.id, 'Change the heading to "My Tasks".');
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const executed = runner.requests[0]?.prompt ?? "";
    expect(previewContext.requestedAgentIds).toEqual([agent.id]);
    expect(executed).toContain('preview.status = "running"');
    expect(executed).toContain("<platform_runtime_context>");
    expect(executed).toContain('<user_request>\nChange the heading to "My Tasks".\n</user_request>');
  });

  it("reports a stopped Preview when no Preview server is up", async () => {
    const runner = new CapturingRunner();
    const service = await makeService(runner, {
      previewContext: new StubPreviewContextProvider({ status: "not_started" }),
    });
    const agent = await service.createAgent({ name: "Stopped" });

    const { run } = await service.sendMessage(agent.id, "add a button");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(runner.requests[0]?.prompt).toContain('preview.status = "not_started"');
  });

  it("persists the user message exactly as typed", async () => {
    const runner = new CapturingRunner();
    const service = await makeService(runner, {
      previewContext: new StubPreviewContextProvider({ status: "running" }),
    });
    const agent = await service.createAgent({ name: "History" });

    const { run } = await service.sendMessage(agent.id, "Change the heading.");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const messages = service.getMessages(agent.id);
    expect(messages[0]).toMatchObject({ role: "user", content: "Change the heading." });
    expect(service.getRun(run.id).prompt).toBe("Change the heading.");
  });

  it("sends the untouched prompt when no Preview context provider is attached", async () => {
    const runner = new CapturingRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Unaware" });

    const { run } = await service.sendMessage(agent.id, "plain prompt");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(runner.requests[0]?.prompt).toBe("plain prompt");
  });

  it("falls back to the untouched prompt when the provider fails", async () => {
    const runner = new CapturingRunner();
    const service = await makeService(runner, {
      previewContext: {
        async getForAgent(): Promise<AgentPreviewContext> {
          throw new Error("store unavailable");
        },
      },
    });
    const agent = await service.createAgent({ name: "Degraded" });

    const { run } = await service.sendMessage(agent.id, "still works");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(runner.requests[0]?.prompt).toBe("still works");
  });
});

describe("Private Agent conversations", () => {
  it("gives each conversation its own Codex thread over one shared workspace", async () => {
    const runner = new CapturingRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Coder" });

    const first = await service.sendMessage(agent.id, "create hello.txt");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const conversationA = service.listConversations(agent.id)[0]!;

    const conversationB = await service.createConversation(agent.id);
    const second = await service.sendMessage(agent.id, "read hello.txt", {
      conversationId: conversationB.id,
    });
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");

    // B started a fresh session rather than resuming A.
    expect(runner.requests[0]?.threadId).toBeNull();
    expect(runner.requests[1]?.threadId).toBeNull();
    // Both ran against the one Agent workspace; a conversation is not a sandbox.
    expect(runner.requests[0]?.workspacePath).toBe(agent.workspacePath);
    expect(runner.requests[1]?.workspacePath).toBe(agent.workspacePath);
    expect(runner.requests.every((request) => request.projectId === undefined)).toBe(true);

    // Returning to A resumes A's thread, not B's.
    const third = await service.sendMessage(agent.id, "keep going", {
      conversationId: conversationA.id,
    });
    await expect.poll(() => service.getRun(third.run.id).status).toBe("completed");
    expect(runner.requests[2]?.threadId).toBe("captured-thread");

    expect(service.getMessages(agent.id, { conversationId: conversationA.id })).toHaveLength(4);
    expect(service.getMessages(agent.id, { conversationId: conversationB.id })).toHaveLength(2);
  });

  it("titles a conversation from its first message and allows rename", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });

    const created = await service.createConversation(agent.id);
    expect(created.title).toBe("New conversation");

    await service.sendMessage(agent.id, "Debug the Todo API timeouts", {
      conversationId: created.id,
    });
    expect(service.getConversation(agent.id, created.id).title).toBe(
      "Debug the Todo API timeouts",
    );

    const renamed = await service.renameConversation(agent.id, created.id, "Todo API debugging");
    expect(renamed.title).toBe("Todo API debugging");
  });

  it("deletes one conversation while keeping the Agent, its files, and the rest", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const first = await service.sendMessage(agent.id, "first task");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const keep = service.listConversations(agent.id)[0]!;
    const doomed = await service.createConversation(agent.id, "Throwaway");
    await service.sendMessage(agent.id, "second task", { conversationId: doomed.id });

    await service.deleteConversation(agent.id, doomed.id);

    expect(service.listConversations(agent.id).map((item) => item.id)).toEqual([keep.id]);
    expect(service.getMessages(agent.id, { conversationId: keep.id })).toHaveLength(2);
    expect(service.getAgent(agent.id).workspacePath).toBe(agent.workspacePath);
    expect(await stat(agent.workspacePath).then((entry) => entry.isDirectory())).toBe(true);
  });

  it("adopts pre-conversation direct history into a default conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Legacy" });
    const { run } = await service.sendMessage(agent.id, "Build a landing page");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    // Rewind the store to the pre-conversation shape, then reinitialize.
    const store = serviceStores.get(service)!;
    await store.mutate((database) => {
      const conversationId = database.agentConversations[0]!.id;
      database.agentConversations = [];
      for (const message of database.messages) {
        if (message.conversationId === conversationId) delete message.conversationId;
      }
      for (const item of database.runs) delete item.conversationId;
      database.agents[0]!.codexThreadId = "legacy-thread";
    });
    await service.initialize();

    const conversations = service.listConversations(agent.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe("Build a landing page");
    // The Agent-level session moved rather than being shared with Team turns.
    expect(conversations[0]?.codexThreadId).toBe("legacy-thread");
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
    expect(service.getMessages(agent.id, { conversationId: conversations[0]!.id })).toHaveLength(2);
  });

  it("keeps Team turns out of every private conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const direct = await service.sendMessage(agent.id, "direct work");
    await expect.poll(() => service.getRun(direct.run.id).status).toBe("completed");
    const conversation = service.listConversations(agent.id)[0]!;

    const team = await service.sendMessage(agent.id, "orchestrator prompt", {
      origin: "orchestration",
    });
    await expect.poll(() => service.getRun(team.run.id).status).toBe("completed");

    expect(service.getMessages(agent.id, { conversationId: conversation.id })).toHaveLength(2);
    expect(service.getMessages(agent.id)).toHaveLength(2);
    expect(service.getMessages(agent.id, { origin: "all" })).toHaveLength(4);
    // The Team turn kept the Agent-level session, separate from the conversation.
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });
});
