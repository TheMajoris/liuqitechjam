import { describe, expect, it } from "vitest";
import {
  buildCheckpointResumeState,
  buildInitialResumeState,
  buildRecoveryExecutionInput,
  checkResumeBudget,
  CheckpointResumeStateSchema,
  contextFromAcceptedCheckpoint,
  rosterMatches,
  type CheckpointResumeState,
} from "../../../apps/server/src/orchestration/checkpoint-resume-state.js";

const agentIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

const participants = agentIds.map((agentId, position) => ({
  id: "participant-" + String(position),
  agentId,
  role: ["Planner", "Builder", "Reviewer"][position]!,
  position,
}));

function turn(position: number, output: string) {
  return {
    participantId: "participant-" + String(position),
    agentId: agentIds[position]!,
    runId: "run-" + String(position),
    position,
    stepIndex: position,
    output,
    outputTruncated: false,
  };
}

function settings(mode: CheckpointResumeState["mode"] = "sequential", maxSteps = 3) {
  return {
    sourceCycleId: "cycle-1",
    mode,
    originalPrompt: "Ship it",
    cycleIndex: 0,
    participants,
    clarifyFirst: false,
    perAgentTimeoutMs: 5_000,
    maxSteps,
  };
}

describe("checkpoint resume state", () => {
  it("records the exact engine prefix after each accepted turn", () => {
    const baseline = buildInitialResumeState(settings(), {
      startEngineStepIndex: 0,
      contextTurns: [],
      parentCheckpointId: null,
    });
    expect(baseline.nextEngineStepIndex).toBe(0);
    expect(baseline.turns).toEqual([]);

    const afterA = buildCheckpointResumeState(baseline, {
      nextEngineStepIndex: 1,
      lastRunId: "run-0",
      lastOutput: "plan",
      turns: [turn(0, "plan")],
      parentCheckpointId: "cp-baseline",
    });
    const afterB = buildCheckpointResumeState(afterA, {
      nextEngineStepIndex: 2,
      lastRunId: "run-1",
      lastOutput: "built",
      turns: [turn(0, "plan"), turn(1, "built")],
      parentCheckpointId: "cp-a",
    });

    // Sequential C2: next participant is C, B's output is the handoff.
    const input = buildRecoveryExecutionInput("session-1", afterB);
    expect(input.stepIndex).toBe(2);
    expect(input.lastRunId).toBe("run-1");
    expect(input.lastOutput).toBe("built");
    expect(input.turns?.map((item) => item.runId)).toEqual(["run-0", "run-1"]);
    expect(input.participants).toHaveLength(3);
    expect(CheckpointResumeStateSchema.safeParse(afterB).success).toBe(true);
    // Deep copies: mutating the input never changes the recorded state.
    input.turns?.pop();
    expect(afterB.turns).toHaveLength(2);
  });

  it("keeps the round-robin engine cursor rather than a roster position", () => {
    const state = buildInitialResumeState(settings("round_robin", 9), {
      startEngineStepIndex: 5,
      contextTurns: [],
      parentCheckpointId: null,
      turns: [turn(0, "a"), turn(1, "b"), turn(2, "c"), turn(0, "d"), turn(1, "e")],
      lastRunId: "run-1",
      lastOutput: "e",
    });
    expect(buildRecoveryExecutionInput("s", state).stepIndex).toBe(5);
    expect(checkResumeBudget(state)).toEqual({ ok: true });
  });

  it("refuses to resume when no budget or roster work remains", () => {
    const exhaustedSequential = buildInitialResumeState(settings("sequential", 5), {
      startEngineStepIndex: 3,
      contextTurns: [],
      parentCheckpointId: null,
    });
    expect(checkResumeBudget(exhaustedSequential)).toEqual({ ok: false, reason: "roster_exhausted" });
    const exhaustedBudget = buildInitialResumeState(settings("supervisor", 2), {
      startEngineStepIndex: 2,
      contextTurns: [],
      parentCheckpointId: null,
    });
    expect(checkResumeBudget(exhaustedBudget)).toEqual({ ok: false, reason: "no_remaining_steps" });
    // A supervisor may still legitimately decide to complete at once.
    const supervisor = buildInitialResumeState(settings("supervisor", 4), {
      startEngineStepIndex: 3,
      contextTurns: [],
      parentCheckpointId: null,
    });
    expect(checkResumeBudget(supervisor)).toEqual({ ok: true });
  });

  it("requires the recorded roster occurrences to still be configured", () => {
    expect(rosterMatches(participants, participants)).toBe(true);
    expect(rosterMatches(participants, participants.slice(0, 2))).toBe(false);
    expect(
      rosterMatches(participants, [
        participants[0]!,
        { ...participants[1]!, agentId: agentIds[2]! },
        participants[2]!,
      ]),
    ).toBe(false);
  });

  it("derives later context from the accepted lineage only", () => {
    const state = buildInitialResumeState(settings(), {
      startEngineStepIndex: 2,
      contextTurns: [
        {
          participantId: "participant-9",
          agentId: agentIds[0]!,
          runId: "run-old",
          position: 0,
          stepIndex: 0,
          output: "older cycle",
          outputTruncated: false,
        },
      ],
      parentCheckpointId: null,
      turns: [turn(0, "plan"), turn(1, "built")],
    });
    const context = contextFromAcceptedCheckpoint(state, (runId) =>
      runId === "run-1" ? 7 : runId === "run-0" ? 6 : undefined,
    );
    expect(context.map((item) => [item.runId, item.stepIndex, item.output])).toEqual([
      ["run-old", 0, "older cycle"],
      ["run-0", 6, "plan"],
      ["run-1", 7, "built"],
    ]);
    expect(contextFromAcceptedCheckpoint(state, () => undefined, 2)).toHaveLength(2);
  });

  it("rejects a continuation whose prefix exceeds the step budget", () => {
    const state = buildInitialResumeState(settings("sequential", 1), {
      startEngineStepIndex: 2,
      contextTurns: [],
      parentCheckpointId: null,
      turns: [turn(0, "a"), turn(1, "b")],
    });
    const parsed = CheckpointResumeStateSchema.safeParse(state);
    expect(parsed.success).toBe(false);
  });
});
