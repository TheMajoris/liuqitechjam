import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../../../apps/server/src/types.js";
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
} from "../../../apps/server/src/orchestration/types.js";

const agentIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function makeAgent(id: string): Agent {
  const timestamp = "2026-09-07T00:00:00.000Z";
  return {
    id,
    name: `Agent ${id.slice(0, 4)}`,
    description: "Test Agent",
    instructions: "Do the assigned work.",
    modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    status: "ready",
    workspacePath: `/tmp/launchpad-${id}`,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeInput(): CreateOrchestrationInput {
  const participants = agentIds.map((agentId, position) => ({
    id: `participant-${position}`,
    agentId,
    role: `Role ${position}`,
    position,
  }));
  return {
    name: "Release pipeline",
    originalPrompt: "Ship the requested change safely.",
    participants,
    maxSteps: participants.length,
    perAgentTimeoutMs: 1_000,
  };
}

async function makeStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-retry-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

function makeAgentsAccess(agents: Agent[]): OrchestrationAgentAccess {
  return { listAgents: () => agents };
}

async function waitForTerminal(
  service: OrchestrationService,
  id: string,
): Promise<OrchestrationSession> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
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

/** Succeeds every turn, recording the prompt each participant received. */
class ImmediateInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  private count = 0;

  async invoke(input: PlatformAgentInvokerInput) {
    this.calls.push(input);
    this.count += 1;
    const runId = `00000000-0000-4000-8000-${String(this.count).padStart(12, "0")}`;
    await input.onRunAccepted?.(runId);
    return { runId, output: `result-${this.count}` };
  }

  async cancel(): Promise<void> {}
}

/** Fails only on the nth dispatch, so a mid-run failure can be retried. */
class FailOnceInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  private count = 0;

  constructor(private readonly failOnCall: number) {}

  async invoke(input: PlatformAgentInvokerInput) {
    this.calls.push(input);
    this.count += 1;
    const runId = `00000000-0000-4000-8000-${String(this.count).padStart(12, "0")}`;
    await input.onRunAccepted?.(runId);
    if (this.count === this.failOnCall) {
      throw new Error("Agent could not finish its turn");
    }
    return { runId, output: `result-${this.count}` };
  }

  async cancel(): Promise<void> {}
}

describe("OrchestrationService.retryFromStep", () => {
  it("re-runs the failed step and the roster positions after it", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    // Fail the second of three participants.
    const invoker = new FailOnceInvoker(2);
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession(makeInput());
    await service.startSession(created.id);
    const failed = await waitForTerminal(service, created.id);
    expect(failed.status).toBe("failed");

    const before = await service.getSession(created.id);
    const failedTurn = before.turns.find((turn) => turn.status === "failed");
    expect(failedTurn?.stepIndex).toBe(1);

    await service.retryFromStep(created.id, 1);
    const retried = await waitForTerminal(service, created.id);

    expect(retried.status).toBe("completed");
    // Participants at positions 1 and 2 ran again; position 0 did not.
    const detail = await service.getSession(created.id);
    const retriedRoles = detail.turns
      .filter((turn) => (turn.stepIndex ?? 0) > 1)
      .map((turn) => turn.participantId);
    expect(retriedRoles).toEqual(["participant-1", "participant-2"]);
  });

  it("appends history instead of rewriting it", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new FailOnceInvoker(2);
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession(makeInput());
    await service.startSession(created.id);
    await waitForTerminal(service, created.id);
    const beforeTurns = (await service.getSession(created.id)).turns;

    await service.retryFromStep(created.id, 1);
    await waitForTerminal(service, created.id);
    const afterTurns = (await service.getSession(created.id)).turns;

    // Every original turn survives, including the abandoned failed one.
    for (const original of beforeTurns) {
      expect(afterTurns.some((turn) => turn.id === original.id)).toBe(true);
    }
    expect(afterTurns.length).toBeGreaterThan(beforeTurns.length);
    // New steps take indexes above every recorded one, never reusing them.
    const indexes = afterTurns.map((turn) => turn.stepIndex ?? -1);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it("offers the retried turn only the work that preceded it", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new FailOnceInvoker(3);
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession(makeInput());
    await service.startSession(created.id);
    await waitForTerminal(service, created.id);

    invoker.calls.length = 0;
    await service.retryFromStep(created.id, 2);
    await waitForTerminal(service, created.id);

    const retryPrompt = invoker.calls[0]?.prompt ?? "";
    // Step 1 preceded the retried step and is still context.
    expect(retryPrompt).toContain("result-2");
    // Step 2 is the turn being retried, so its own failed output is absent.
    expect(retryPrompt).not.toContain("result-3");
  });

  it("records a retry event naming the step it resumed from", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      new ImmediateInvoker(),
    );
    const created = await service.createSession(makeInput());
    await service.startSession(created.id);
    await waitForTerminal(service, created.id);

    await service.retryFromStep(created.id, 1);
    await waitForTerminal(service, created.id);

    const events = (await service.getSession(created.id)).events;
    const retry = events.filter((event) => event.type === "orchestration_retried");
    expect(retry).toHaveLength(1);
    expect(retry[0]?.participantId).toBe("participant-1");
    expect(retry[0]?.safeSummary).toContain("step 2");
  });

  it("refuses a step that was never recorded", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      new ImmediateInvoker(),
    );
    const created = await service.createSession(makeInput());
    await service.startSession(created.id);
    await waitForTerminal(service, created.id);

    await expect(service.retryFromStep(created.id, 99)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("refuses a retry while the conversation is still active", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      new ImmediateInvoker(),
    );
    const created = await service.createSession(makeInput());

    // A draft has never run, so it has no step to resume from either.
    await expect(service.retryFromStep(created.id, 0)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rejects a negative or non-integer step", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      new ImmediateInvoker(),
    );
    const created = await service.createSession(makeInput());
    await service.startSession(created.id);
    await waitForTerminal(service, created.id);

    await expect(service.retryFromStep(created.id, -1)).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(service.retryFromStep(created.id, 1.5)).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});
