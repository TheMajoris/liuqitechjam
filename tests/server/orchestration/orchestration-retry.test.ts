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
import type { OrchestrationParticipantSelector } from "../../../apps/server/src/orchestration/orchestrator.js";

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

/** Emits one typed model-limit failure, then succeeds on a user retry. */
class ModelLimitOnceInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  private count = 0;

  async invoke(input: PlatformAgentInvokerInput) {
    this.calls.push(input);
    this.count += 1;
    const runId = `00000000-0000-4000-8000-${String(this.count).padStart(12, "0")}`;
    await input.onRunAccepted?.(runId);
    if (this.count === 1) {
      const error = new Error("provider model limit reached");
      Object.assign(error, {
        orchestrationErrorCode: "MODEL_INFERENCE_LIMIT_EXCEEDED",
      });
      throw error;
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

  it("lets an explicit retry recover the errored checkpoint Agent", async () => {
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

    // A normal runtime failure leaves the Agent in its legacy error state.
    // The retry button is the explicit recovery action for this checkpoint;
    // the user should not have to open a separate private chat first.
    agents[1]!.status = "error";
    agents[1]!.lastError = "previous runtime failure";
    await service.retryFromStep(created.id, 1);

    expect((await waitForTerminal(service, created.id)).status).toBe("completed");
    expect(invoker.calls.map((call) => call.agentId)).toEqual([
      agentIds[0],
      agentIds[1],
      agentIds[1],
      agentIds[2],
    ]);
  });

  it("preserves a typed model-limit failure on the failed checkpoint", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ModelLimitOnceInvoker();
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession(makeInput());
    await service.startSession(created.id);

    const failed = await waitForTerminal(service, created.id);
    expect(failed.errorCode).toBe("MODEL_INFERENCE_LIMIT_EXCEEDED");
    expect(failed.errorMessage).toContain("inference limit");
    const failedTurn = (await service.getSession(created.id)).turns.find(
      (turn) => turn.status === "failed",
    );
    expect(failedTurn?.errorCode).toBe("MODEL_INFERENCE_LIMIT_EXCEEDED");

    await service.retryFromStep(created.id, failedTurn!.stepIndex!);
    expect((await waitForTerminal(service, created.id)).status).toBe("completed");
    const detail = await service.getSession(created.id);
    expect(detail.turns.find((turn) => turn.status === "failed")?.errorCode).toBe(
      "MODEL_INFERENCE_LIMIT_EXCEEDED",
    );
  });

  it("pins the first supervisor retry dispatch to the failed participant", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new FailOnceInvoker(1);
    const selectionSteps: number[] = [];
    const selector: OrchestrationParticipantSelector = async (input) => {
      selectionSteps.push(input.stepIndex);
      if (selectionSteps.length === 1) {
        const participant = input.participants[1]!;
        return {
          kind: "invoke",
          participant: { ...participant },
          stepIndex: input.stepIndex,
        };
      }
      // The normal supervisor decision after the pinned retry completes the
      // cycle. Before the fix this decision ran at step 0 during the retry and
      // ended the cycle before the failed participant was invoked again.
      return { kind: "end", reason: "supervisor_completed" };
    };
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    };
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker,
      selectNextParticipant: selector,
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
      }),
    });
    const created = await service.createSession({
      ...makeInput(),
      mode: "supervisor",
      maxSteps: 4,
    });

    await service.startSession(created.id);
    const failed = await waitForTerminal(service, created.id);
    expect(failed.status).toBe("failed");
    const failedTurn = (await service.getSession(created.id)).turns.find(
      (turn) => turn.status === "failed",
    );
    expect(failedTurn?.participantId).toBe("participant-1");
    expect(failedTurn?.stepIndex).toBe(0);

    invoker.calls.length = 0;
    await service.retryFromStep(created.id, failedTurn!.stepIndex!);
    const retried = await waitForTerminal(service, created.id);

    expect(retried.status).toBe("completed");
    expect(invoker.calls.map((call) => call.agentId)).toEqual([agentIds[1]]);
    // The checkpoint dispatch is pinned without consulting the normal
    // supervisor; the next decision sees the incremented retry step.
    expect(selectionSteps).toEqual([0, 1]);
    const detail = await service.getSession(created.id);
    expect(
      detail.turns
        .filter((turn) => (turn.stepIndex ?? 0) > 0)
        .map((turn) => turn.participantId),
    ).toEqual(["participant-1"]);
  });

  it("gives a supervisor follow-up one corrective dispatch after a premature completion", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ImmediateInvoker();
    const selectionInputs: Parameters<OrchestrationParticipantSelector>[0][] = [];
    let selectionCount = 0;
    const selector: OrchestrationParticipantSelector = async (input) => {
      selectionInputs.push(input);
      if (selectionCount === 0) {
        selectionCount += 1;
        return {
          kind: "invoke",
          participant: { ...input.participants[0]! },
          stepIndex: input.stepIndex,
        };
      }
      if (selectionCount === 1) {
        selectionCount += 1;
        return { kind: "end", reason: "supervisor_completed" };
      }
      if (input.requireCurrentCycleDispatch) {
        selectionCount += 1;
        return {
          kind: "invoke",
          participant: { ...input.participants[1]! },
          stepIndex: input.stepIndex,
        };
      }
      selectionCount += 1;
      return { kind: "end", reason: "supervisor_completed" };
    };
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    };
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker,
      selectNextParticipant: selector,
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
      }),
    });
    const created = await service.createSession({
      ...makeInput(),
      mode: "supervisor",
    });

    await service.startSession(created.id);
    expect((await waitForTerminal(service, created.id)).status).toBe("completed");

    await service.continueSession(created.id, "Builder, check the latest request.");
    const continued = await waitForTerminal(service, created.id);

    expect(continued.status).toBe("completed");
    expect((await service.getSession(created.id)).turns).toHaveLength(2);
    expect(invoker.calls.map((call) => call.agentId)).toEqual([
      agentIds[0],
      agentIds[1],
    ]);
    expect(selectionInputs.slice(2)).toMatchObject([
      {
        cycleIndex: 1,
        currentCycleTurnCount: 0,
        priorCycleTurnCount: 1,
      },
      {
        cycleIndex: 1,
        currentCycleTurnCount: 0,
        priorCycleTurnCount: 1,
        requireCurrentCycleDispatch: true,
      },
      {
        cycleIndex: 1,
        currentCycleTurnCount: 1,
        priorCycleTurnCount: 1,
      },
    ]);
  });

  it("fails a follow-up explicitly when corrective supervisor routing still completes", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ImmediateInvoker();
    const selectionInputs: Parameters<OrchestrationParticipantSelector>[0][] = [];
    const selector: OrchestrationParticipantSelector = async (input) => {
      selectionInputs.push(input);
      if ((input.cycleIndex ?? 0) === 0) {
        return input.currentCycleTurnCount === 0
          ? {
              kind: "invoke",
              participant: { ...input.participants[0]! },
              stepIndex: input.stepIndex,
            }
          : { kind: "end", reason: "supervisor_completed" };
      }
      return { kind: "end", reason: "supervisor_completed" };
    };
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    };
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker,
      selectNextParticipant: selector,
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
      }),
    });
    const created = await service.createSession({
      ...makeInput(),
      mode: "supervisor",
    });

    await service.startSession(created.id);
    expect((await waitForTerminal(service, created.id)).status).toBe("completed");

    await service.continueSession(created.id, "Check the latest request.");
    const failed = await waitForTerminal(service, created.id);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("SUPERVISOR_INVALID_SELECTION");
    expect(failed.errorMessage).toContain("answer this follow-up");
    expect(failed.errorMessage).toContain("Retry the follow-up");
    expect(invoker.calls).toHaveLength(1);
    expect(selectionInputs).toHaveLength(4);
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
