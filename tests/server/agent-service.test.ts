import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../apps/server/src/agent-service.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { RetryableModelError, RunCancelledError } from "../../apps/server/src/errors.js";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRecorder,
} from "../../apps/server/src/audit/audit-types.js";
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

/** Records audit inputs verbatim so span/metadata shape can be asserted. */
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
  options: {
    curatedModels?: string;
    arkModel?: string;
    audit?: AuditRecorder;
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
  );
  if (options.audit) service.setAuditRecorder(options.audit);
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

describe("Run audit spans", () => {
  it("records a direct run as one span rooted at the Run id", async () => {
    const audit = new RecordingAudit();
    const service = await makeService(new FakeRunner(), { audit });
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "trace this");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await expect.poll(() => audit.ofType("run_completed").length).toBe(1);

    const started = audit.ofType("run_started")[0];
    const completed = audit.ofType("run_completed")[0];
    expect(started?.span?.traceId).toBe(run.id);
    expect(started?.span?.parentSpanId).toBeUndefined();
    expect(started?.principal).toEqual({ kind: "agent", id: agent.id });
    expect(completed?.span?.spanId).toBe(started?.span?.spanId);
    expect(completed?.span?.traceId).toBe(run.id);
    expect(typeof completed?.durationMs).toBe("number");
    expect(completed?.metadata).toMatchObject({ exitReason: "completed" });
  });

  it("records a failing run without exposing the error text", async () => {
    const audit = new RecordingAudit();
    const runner: AgentRunner = {
      run: async () => {
        throw new Error("worker crashed reading /secret/workspace/path");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, { audit });
    const agent = await service.createAgent({ name: "Failing" });
    const { run } = await service.sendMessage(agent.id, "fail this");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    await expect.poll(() => audit.ofType("run_failed").length).toBe(1);

    const failed = audit.ofType("run_failed")[0];
    expect(failed?.status).toBe("failure");
    expect(failed?.metadata).toEqual({ exitReason: "error", errorClass: "Error" });
    expect(JSON.stringify(failed)).not.toContain("worker crashed");
  });

  it("parents runtime stream events under the same run span", async () => {
    const audit = new RecordingAudit();
    const runner: AgentRunner = {
      run: async (request) => {
        request.observer?.onEvent({
          type: "item.completed",
          item: {
            id: "item_0",
            type: "command_execution",
            command: "bash -lc 'npm test'",
            aggregated_output: "ok",
            exit_code: 0,
            status: "completed",
          },
        });
        return { output: "done", threadId: request.threadId ?? "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, { audit });
    const agent = await service.createAgent({ name: "Observed" });
    const { run } = await service.sendMessage(agent.id, "observe this");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await expect.poll(() => audit.ofType("sandbox_command").length).toBe(1);

    const started = audit.ofType("run_started")[0];
    const command = audit.ofType("sandbox_command")[0];
    expect(command?.span?.parentSpanId).toBe(started?.span?.spanId);
    expect(command?.span?.traceId).toBe(started?.span?.traceId);
    expect(command?.runId).toBe(run.id);
    expect(command?.metadata).toMatchObject({ program: "npm", exitCode: 0 });
  });

  it("records a model fallback attempt as a retry of the same run span", async () => {
    const audit = new RecordingAudit();
    let attempts = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        attempts += 1;
        if (attempts === 1) throw new RetryableModelError();
        return { output: "ok", threadId: request.threadId ?? "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, {
      audit,
      curatedModels: "ep-fallback",
    });
    const agent = await service.createAgent({
      name: "Fallback",
      fallbackModelRefs: [{ providerId: "volcengine_ark", modelId: "ep-fallback" }],
    });
    const { run } = await service.sendMessage(agent.id, "retry this");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await expect.poll(() => audit.ofType("run_retried").length).toBe(1);

    const retried = audit.ofType("run_retried")[0];
    expect(retried?.span?.spanId).toBe(audit.ofType("run_started")[0]?.span?.spanId);
    expect(retried?.metadata).toMatchObject({
      fromModel: "ep-test",
      toModel: "ep-fallback",
      attemptIndex: 1,
      retryOfRunId: run.id,
    });
  });
});
