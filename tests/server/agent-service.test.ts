import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../apps/server/src/agent-service.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { RunCancelledError } from "../../apps/server/src/errors.js";
import { JsonStore } from "../../apps/server/src/store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../apps/server/src/types.js";
import { WorkspaceManager } from "../../apps/server/src/workspace.js";

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
  options: { curatedModels?: string; arkModel?: string } = {},
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
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
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

  it("writes the default response language policy to the Agent workspace", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "English default" });
    const instructions = await readFile(
      path.join(agent.workspacePath, "AGENTS.md"),
      "utf8",
    );

    expect(instructions).toContain(
      "Respond in English by default. Use another language only when the user explicitly requests it.",
    );
  });

  it("deletes an Agent when its workspace was removed externally", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Orphaned" });
    const { rm } = await import("node:fs/promises");
    await rm(agent.workspacePath, { recursive: true, force: true });

    const result = await service.deleteAgent(agent.id);

    expect(result.archivedWorkspace).toBeNull();
    expect(service.listAgents()).toHaveLength(0);
    expect(() => service.getAgent(agent.id)).toThrow(/Agent not found/);
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
});
