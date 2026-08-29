import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

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

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
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

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
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
