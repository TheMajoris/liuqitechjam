import { describe, expect, it } from "vitest";
import { advanceSequence, type SequenceParticipant } from "../sequence.js";

const participants: SequenceParticipant[] = [
  { id: "p2", agentId: "agent-2", role: "Builder", position: 2 },
  { id: "p0", agentId: "agent-0", role: "Planner", position: 0 },
  { id: "p1", agentId: "agent-1", role: "Reviewer", position: 1 },
];

describe("advanceSequence", () => {
  it("selects each participant exactly once in position order", () => {
    const selected = [0, 1, 2].map((stepIndex) => {
      const decision = advanceSequence({
        participants,
        stepIndex,
        maxSteps: 10,
      });
      expect(decision.kind).toBe("invoke");
      if (decision.kind !== "invoke") throw new Error("expected invocation");
      return decision.participant.id;
    });

    expect(selected).toEqual(["p0", "p1", "p2"]);
  });

  it("ends when the roster is exhausted", () => {
    expect(
      advanceSequence({ participants, stepIndex: participants.length, maxSteps: 10 }),
    ).toEqual({ kind: "end", reason: "roster_exhausted" });
    expect(
      advanceSequence({
        participants,
        stepIndex: participants.length,
        maxSteps: participants.length,
      }),
    ).toEqual({ kind: "end", reason: "roster_exhausted" });
  });

  it("ends before dispatch when maxSteps is reached", () => {
    expect(
      advanceSequence({ participants, stepIndex: 2, maxSteps: 2 }),
    ).toEqual({ kind: "end", reason: "max_steps_reached" });
  });

  it("cycles the ordered roster in round-robin mode until maxSteps", () => {
    const selected = [0, 1, 2, 3, 4].map((stepIndex) => {
      const decision = advanceSequence({
        participants,
        stepIndex,
        maxSteps: 5,
        mode: "round_robin",
      });
      expect(decision.kind).toBe("invoke");
      if (decision.kind !== "invoke") throw new Error("expected invocation");
      return decision.participant.id;
    });

    expect(selected).toEqual(["p0", "p1", "p2", "p0", "p1"]);
    expect(
      advanceSequence({
        participants,
        stepIndex: 5,
        maxSteps: 5,
        mode: "round_robin",
      }),
    ).toEqual({ kind: "end", reason: "max_steps_reached" });
  });

  it("ends deterministically for malformed sequence state", () => {
    expect(
      advanceSequence({ participants, stepIndex: -1, maxSteps: 10 }),
    ).toEqual({ kind: "end", reason: "invalid_state" });
    expect(
      advanceSequence({ participants, stepIndex: 0, maxSteps: 0 }),
    ).toEqual({ kind: "end", reason: "invalid_state" });
  });

  it("ends deterministically for duplicate or malformed positions", () => {
    const malformed = [
      participants[0],
      { ...participants[1], position: participants[0].position },
    ];
    expect(
      advanceSequence({ participants: malformed, stepIndex: 0, maxSteps: 10 }),
    ).toEqual({ kind: "end", reason: "invalid_roster" });
  });

  it("does not dispatch after a terminal graph status", () => {
    expect(
      advanceSequence({
        participants,
        stepIndex: 0,
        maxSteps: 10,
        status: "completed",
      }),
    ).toEqual({ kind: "end", reason: "terminal_state" });
  });
});
