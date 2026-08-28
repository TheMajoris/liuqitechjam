import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../../types.js";
import { JsonStore } from "../../store.js";
import {
  OrchestrationService,
  type OrchestrationAgentAccess,
} from "../orchestration-service.js";
import type {
  OrchestrationExecutionResult,
  Orchestrator,
} from "../orchestrator.js";
import type {
  CreateOrchestrationInput,
  OrchestrationTurn,
} from "../types.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const runIds = [
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

function makeAgent(): Agent {
  return {
    id: agentId,
    name: "Worker",
    description: "A test worker",
    instructions: "Complete the assigned task.",
    status: "ready",
    workspacePath: "/tmp/worker",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function makeInput(): CreateOrchestrationInput {
  return {
    name: "Team chat",
    originalPrompt: "Plan the release.",
    participants: [
      {
        id: "worker",
        agentId,
        role: "Release worker",
        position: 0,
      },
    ],
    mode: "sequential",
    maxSteps: 1,
    perAgentTimeoutMs: 1_000,
  };
}

async function makeStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-lifecycle-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

async function waitForTerminal(
  service: OrchestrationService,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = (await service.getSession(sessionId)).session.status;
    if (["completed", "failed", "stopped", "interrupted"].includes(status)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for orchestration");
}

function makeOrchestrator(
  observedInputs: Array<{
    originalPrompt: string;
    contextTurns: unknown[] | undefined;
  }>,
): Orchestrator {
  let invocation = 0;
  return {
    async run(input, options): Promise<OrchestrationExecutionResult> {
      observedInputs.push({
        originalPrompt: input.originalPrompt,
        contextTurns: input.contextTurns === undefined
          ? undefined
          : [...input.contextTurns],
      });
      const participant = input.participants[0]!;
      const runId = runIds[invocation++]!;
      const prompt = input.originalPrompt;
      await options.hooks?.onBeforeDispatch?.({
        participant,
        prompt,
        stepIndex: input.stepIndex ?? 0,
      });
      await options.hooks?.onRunAccepted?.({
        participant,
        prompt,
        runId,
        stepIndex: input.stepIndex ?? 0,
      });
      const createdAt = new Date().toISOString();
      const turn: OrchestrationTurn = {
        id: "44444444-4444-4444-8444-444444444444",
        sessionId: input.sessionId,
        participantId: participant.id,
        agentId: participant.agentId,
        runId,
        position: participant.position,
        stepIndex: input.stepIndex ?? 0,
        status: "completed",
        safeInputSummary: prompt,
        safeOutput: "worker result",
        outputTruncated: false,
        errorCode: null,
        createdAt,
        completedAt: createdAt,
      };
      const envelope = {
        sourceParticipantId: participant.id,
        sourceAgentId: participant.agentId,
        sourceRunId: runId,
        content: "worker result",
        truncated: false,
      };
      await options.hooks?.onHandoffApplied?.({
        participant,
        envelope,
        stepIndex: input.stepIndex ?? 0,
      });
      await options.hooks?.onRunCompleted?.({
        participant,
        prompt,
        runId,
        output: "worker result",
        envelope,
        turn,
        stepIndex: input.stepIndex ?? 0,
      });
      return {
        sessionId: input.sessionId,
        originalPrompt: input.originalPrompt,
        participants: input.participants,
        mode: input.mode,
        completionReason: "roster_exhausted",
        stepIndex: (input.stepIndex ?? 0) + 1,
        maxSteps: input.maxSteps,
        lastRunId: runId,
        lastOutput: "worker result",
        turns: [],
        status: "completed",
        errorCode: null,
      };
    },
  };
}

function makeService(
  store: JsonStore,
  orchestrator: Orchestrator,
  agents: Agent[] = [makeAgent()],
): OrchestrationService {
  const access: OrchestrationAgentAccess = { listAgents: () => agents };
  return new OrchestrationService({
    store,
    agents: access,
    orchestrator,
    invoker: {
      async invoke() {
        return { runId: runIds[0]!, output: "unused" };
      },
      async cancel() {
        return undefined;
      },
    },
  });
}

describe("OrchestrationService conversation lifecycle", () => {
  it("continues one visible session with a fresh cycle and global persisted indexes", async () => {
    const store = await makeStore();
    const observedInputs: Array<{
      originalPrompt: string;
      contextTurns: unknown[] | undefined;
    }> = [];
    const service = makeService(store, makeOrchestrator(observedInputs));
    const created = await service.createSession(makeInput());

    await service.startSession(created.id);
    await waitForTerminal(service, created.id);
    const continued = await service.continueSession(
      created.id,
      "Now turn that plan into three concrete actions.",
    );
    expect(continued.id).toBe(created.id);
    expect(continued.status).toBe("queued");
    await waitForTerminal(service, created.id);

    const detail = await service.getSession(created.id);
    expect(detail.continuationPrompts).toHaveLength(1);
    expect(detail.continuationPrompts?.[0]).toMatchObject({
      sessionId: created.id,
      cycleIndex: 1,
      prompt: "Now turn that plan into three concrete actions.",
    });
    expect(detail.turns.map((turn) => turn.stepIndex)).toEqual([0, 1]);
    expect(observedInputs.map((input) => input.originalPrompt)).toEqual([
      "Plan the release.",
      "Now turn that plan into three concrete actions.",
    ]);
    expect(observedInputs[1]?.contextTurns).toHaveLength(1);
    expect((observedInputs[1]?.contextTurns?.[0] as { output: string }).output).toBe(
      "worker result",
    );
  });

  it("rejects continuation while active and atomically deletes only Team records", async () => {
    const store = await makeStore();
    const service = makeService(store, makeOrchestrator([]));
    const created = await service.createSession(makeInput());

    await service.startSession(created.id);
    await expect(
      service.continueSession(created.id, "Too early"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await waitForTerminal(service, created.id);

    await store.mutate((database) => {
      database.agents.push(makeAgent());
      database.messages.push({
        id: "55555555-5555-4555-8555-555555555555",
        agentId,
        runId: runIds[0]!,
        role: "user",
        content: "private Agent message",
        createdAt: new Date().toISOString(),
      });
      database.runs.push({
        id: runIds[0]!,
        agentId,
        status: "completed",
        prompt: "private Agent prompt",
        output: "private Agent output",
        error: null,
        usage: null,
        startedAt: null,
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    });
    await service.continueSession(created.id, "Persist this prompt");
    await waitForTerminal(service, created.id);

    const deleted = await service.deleteSession(created.id);
    expect(deleted).toEqual({ deleted: true });
    const snapshot = store.snapshot();
    expect(snapshot.orchestrations).toHaveLength(0);
    expect(snapshot.orchestrationTurns).toHaveLength(0);
    expect(snapshot.orchestrationEvents).toHaveLength(0);
    expect(snapshot.orchestrationContinuationPrompts).toHaveLength(0);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);
    await expect(service.getSession(created.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("does not delete an active session even when its persisted status races", async () => {
    const store = await makeStore();
    const service = makeService(store, makeOrchestrator([]));
    const created = await service.createSession(makeInput());
    await store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === created.id)!;
      session.status = "running";
    });

    await expect(service.deleteSession(created.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(store.snapshot().orchestrations).toHaveLength(1);
  });
});
