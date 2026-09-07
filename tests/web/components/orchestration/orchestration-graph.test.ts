import { describe, expect, it } from "vitest";
import {
  buildOrchestrationGraph,
  toFlowElements,
  FLOW_LANE_GAP,
  FLOW_ROW_GAP,
} from "../../../../apps/web/src/components/orchestration/orchestration-graph";
import type {
  OrchestrationContinuationPrompt,
  OrchestrationEvent,
  OrchestrationParticipant,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "../../../../apps/web/src/types";

function participant(
  id: string,
  position: number,
  agentId = "agent-" + id,
): OrchestrationParticipant {
  return { id, agentId, role: "Role " + id, position };
}

function turn(overrides: Partial<OrchestrationTurn> & { id: string }): OrchestrationTurn {
  return {
    sessionId: "session-1",
    participantId: "p1",
    agentId: "agent-p1",
    runId: "run-" + overrides.id,
    position: 0,
    status: "completed",
    safeInputSummary: "input",
    safeOutput: "output",
    outputTruncated: false,
    errorCode: null,
    createdAt: "2026-09-07T10:00:00.000Z",
    completedAt: "2026-09-07T10:00:05.000Z",
    ...overrides,
  };
}

function event(
  sequence: number,
  type: OrchestrationEvent["type"],
  overrides: Partial<OrchestrationEvent> = {},
): OrchestrationEvent {
  return {
    id: "event-" + sequence,
    sessionId: "session-1",
    sequence,
    type,
    status: "running",
    createdAt: "2026-09-07T10:00:00.000Z",
    ...overrides,
  };
}

function detail(
  overrides: Partial<OrchestrationSessionDetail> & {
    participants?: OrchestrationParticipant[];
  } = {},
): OrchestrationSessionDetail {
  const { participants, ...rest } = overrides;
  const session = {
    id: "session-1",
    name: "Session",
    originalPrompt: "Do the thing",
    participants: participants ?? [participant("p1", 0), participant("p2", 1)],
    mode: "sequential",
    status: "completed",
    currentParticipantId: null,
    currentRunId: null,
    stepIndex: 0,
    maxSteps: 10,
    perAgentTimeoutMs: 60_000,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-09-07T09:59:00.000Z",
    updatedAt: "2026-09-07T10:01:00.000Z",
    startedAt: "2026-09-07T10:00:00.000Z",
    completedAt: "2026-09-07T10:01:00.000Z",
  } satisfies OrchestrationSession;
  return {
    session,
    turns: [],
    events: [],
    continuationPrompts: [],
    ...rest,
  };
}

describe("buildOrchestrationGraph", () => {
  it("returns an empty model for a missing session or a session with no turns", () => {
    expect(buildOrchestrationGraph(null).rowCount).toBe(0);
    expect(buildOrchestrationGraph(detail()).rowCount).toBe(0);
    expect(buildOrchestrationGraph(detail()).lanes).toEqual([]);
  });

  it("gives each roster occurrence a lane column ordered by declared position", () => {
    const graph = buildOrchestrationGraph(
      detail({
        participants: [participant("late", 2), participant("first", 0), participant("mid", 1)],
        turns: [turn({ id: "t1", participantId: "first" })],
      }),
    );

    expect(graph.lanes.map((lane) => lane.participantId)).toEqual(["first", "mid", "late"]);
    expect(graph.lanes.map((lane) => lane.column)).toEqual([0, 1, 2]);
  });

  it("places each turn in its participant lane, in execution order", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t2", participantId: "p2", stepIndex: 1 }),
          turn({ id: "t1", participantId: "p1", stepIndex: 0 }),
        ],
      }),
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(["t1", "t2"]);
    expect(graph.nodes.map((node) => node.row)).toEqual([0, 1]);
    expect(graph.nodes.map((node) => node.column)).toEqual([0, 1]);
    expect(graph.nodes.map((node) => node.stepNumber)).toEqual([1, 2]);
  });

  it("revisits the same lane when round robin returns to a participant", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", participantId: "p1", stepIndex: 0 }),
          turn({ id: "t2", participantId: "p2", stepIndex: 1 }),
          turn({ id: "t3", participantId: "p1", stepIndex: 2 }),
        ],
      }),
    );

    expect(graph.nodes.map((node) => node.column)).toEqual([0, 1, 0]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[1]).toMatchObject({ fromColumn: 1, toColumn: 0 });
  });

  it("gives a turn whose participant left the roster its own trailing lane", () => {
    const graph = buildOrchestrationGraph(
      detail({
        participants: [participant("p1", 0)],
        turns: [
          turn({ id: "t1", participantId: "p1", stepIndex: 0 }),
          turn({ id: "t2", participantId: "ghost", stepIndex: 1 }),
        ],
      }),
    );

    expect(graph.lanes).toHaveLength(2);
    expect(graph.lanes[1]).toMatchObject({ participantId: "ghost", column: 1 });
    expect(graph.nodes[1]?.column).toBe(1);
  });

  it("falls back to array order for legacy turns without a step index", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", createdAt: "2026-09-07T10:00:00.000Z" }),
          turn({ id: "t2", createdAt: "2026-09-07T10:00:10.000Z" }),
        ],
      }),
    );

    expect(graph.nodes.map((node) => node.stepNumber)).toEqual([1, 2]);
  });

  it("attaches the recorded duration to the turn that earned it", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", runId: "run-a", stepIndex: 0 }),
          turn({ id: "t2", runId: "run-b", stepIndex: 1 }),
        ],
        events: [
          event(0, "run_completed", { runId: "run-a", durationMs: 4_200 }),
          event(1, "run_completed", { runId: "run-b", durationMs: 11_800 }),
        ],
      }),
    );

    expect(graph.nodes.map((node) => node.durationMs)).toEqual([4_200, 11_800]);
  });

  it("binds a routing reason to the turn dispatched after that decision", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", participantId: "p1", runId: "run-a", stepIndex: 0 }),
          turn({ id: "t2", participantId: "p2", runId: "run-b", stepIndex: 1 }),
        ],
        events: [
          event(0, "supervisor_decision", {
            participantId: "p1",
            safeSummary: "Needs research first",
          }),
          event(1, "participant_dispatched", { participantId: "p1", runId: "run-a" }),
          event(2, "run_completed", { runId: "run-a" }),
          event(3, "supervisor_decision", {
            participantId: "p2",
            safeSummary: "Draft the copy",
          }),
          event(4, "participant_dispatched", { participantId: "p2", runId: "run-b" }),
        ],
      }),
    );

    expect(graph.nodes[0]?.reason).toBe("Needs research first");
    expect(graph.nodes[1]?.reason).toBe("Draft the copy");
  });

  it("ignores a completion decision, which selects no participant", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [turn({ id: "t1", runId: "run-a", stepIndex: 0 })],
        events: [
          event(0, "supervisor_decision", {
            completionReason: "supervisor_completed",
            safeSummary: "Conversation completed",
          }),
          event(1, "participant_dispatched", { participantId: "p1", runId: "run-a" }),
        ],
      }),
    );

    expect(graph.nodes[0]?.reason).toBeUndefined();
  });

  it("marks an edge as a handoff only when one was applied to the receiving turn", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", participantId: "p1", runId: "run-a", stepIndex: 0 }),
          turn({ id: "t2", participantId: "p2", runId: "run-b", stepIndex: 1 }),
        ],
        events: [
          event(0, "participant_dispatched", { participantId: "p1", runId: "run-a" }),
          event(1, "run_completed", { runId: "run-a" }),
          event(2, "handoff_applied", { participantId: "p2" }),
          event(3, "participant_dispatched", { participantId: "p2", runId: "run-b" }),
        ],
      }),
    );

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.handoff).toBe(true);
  });

  it("does not credit a handoff to a turn it was not applied to", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", participantId: "p1", runId: "run-a", stepIndex: 0 }),
          turn({ id: "t2", participantId: "p2", runId: "run-b", stepIndex: 1 }),
        ],
        events: [
          event(0, "handoff_applied", { participantId: "someone-else" }),
          event(1, "participant_dispatched", { participantId: "p1", runId: "run-a" }),
          event(2, "participant_dispatched", { participantId: "p2", runId: "run-b" }),
        ],
      }),
    );

    expect(graph.edges[0]?.handoff).toBe(false);
  });

  it("reads the journal in sequence order regardless of array order", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [turn({ id: "t1", runId: "run-a", stepIndex: 0 })],
        events: [
          event(2, "run_completed", { runId: "run-a", durationMs: 900 }),
          event(1, "participant_dispatched", { participantId: "p1", runId: "run-a" }),
          event(0, "supervisor_decision", { participantId: "p1", safeSummary: "Start here" }),
        ],
      }),
    );

    expect(graph.nodes[0]?.reason).toBe("Start here");
    expect(graph.nodes[0]?.durationMs).toBe(900);
  });

  it("breaks the graph into cycles at each follow-up prompt", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", stepIndex: 0, createdAt: "2026-09-07T10:00:00.000Z" }),
          turn({ id: "t2", stepIndex: 1, createdAt: "2026-09-07T10:05:00.000Z" }),
        ],
        continuationPrompts: [
          {
            id: "prompt-1",
            sessionId: "session-1",
            cycleIndex: 1,
            prompt: "now add citations",
            createdAt: "2026-09-07T10:02:00.000Z",
          } satisfies OrchestrationContinuationPrompt,
        ],
      }),
    );

    expect(graph.rows.map((row) => row.kind)).toEqual(["turn", "cycle", "turn"]);
    expect(graph.rowCount).toBe(3);
    expect(graph.nodes.map((node) => node.cycleIndex)).toEqual([0, 1]);
    expect(graph.markers[0]).toMatchObject({ row: 1, cycleIndex: 1 });
  });

  it("marks the edge that spans a follow-up boundary", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", stepIndex: 0, createdAt: "2026-09-07T10:00:00.000Z" }),
          turn({ id: "t2", stepIndex: 1, createdAt: "2026-09-07T10:05:00.000Z" }),
          turn({ id: "t3", stepIndex: 2, createdAt: "2026-09-07T10:06:00.000Z" }),
        ],
        continuationPrompts: [
          {
            id: "prompt-1",
            sessionId: "session-1",
            cycleIndex: 1,
            prompt: "keep going",
            createdAt: "2026-09-07T10:02:00.000Z",
          },
        ],
      }),
    );

    expect(graph.edges.map((edge) => edge.crossCycle)).toEqual([true, false]);
  });

  it("keeps a follow-up that has not dispatched a turn yet", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [turn({ id: "t1", stepIndex: 0, createdAt: "2026-09-07T10:00:00.000Z" })],
        continuationPrompts: [
          {
            id: "prompt-1",
            sessionId: "session-1",
            cycleIndex: 1,
            prompt: "queued but not started",
            createdAt: "2026-09-07T10:09:00.000Z",
          },
        ],
      }),
    );

    expect(graph.rows.map((row) => row.kind)).toEqual(["turn", "cycle"]);
    expect(graph.markers[0]?.row).toBe(1);
  });

  it("keeps a follow-up recorded after a run that never dispatched a turn", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [],
        continuationPrompts: [
          {
            id: "prompt-1",
            sessionId: "session-1",
            cycleIndex: 1,
            prompt: "try again please",
            createdAt: "2026-09-07T10:02:00.000Z",
          },
        ],
      }),
    );

    expect(graph.rows.map((row) => row.kind)).toEqual(["cycle"]);
    expect(graph.nodes).toHaveLength(0);
    // The roster is still known, so its lanes are still worth drawing.
    expect(graph.lanes).toHaveLength(2);
  });

  it("does not carry a handoff past the failed turn it was applied to", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", participantId: "p1", runId: "run-a", stepIndex: 0 }),
          turn({ id: "t2", participantId: "p1", runId: "run-b", stepIndex: 1 }),
        ],
        events: [
          event(0, "participant_dispatched", { participantId: "p1", runId: "run-a" }),
          event(1, "run_completed", { runId: "run-a" }),
          // A handoff was recorded, then the dispatch it belonged to failed.
          event(2, "handoff_applied", { participantId: "p1" }),
          event(3, "participant_failed", { participantId: "p1", errorCode: "AGENT_BUSY" }),
          event(4, "orchestration_continued"),
          event(5, "participant_dispatched", { participantId: "p1", runId: "run-b" }),
        ],
      }),
    );

    expect(graph.edges[0]?.handoff).toBe(false);
  });

  it("does not carry a routing reason past a turn that failed to dispatch", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [turn({ id: "t1", participantId: "p1", runId: "run-b", stepIndex: 0 })],
        events: [
          event(0, "supervisor_decision", {
            participantId: "p1",
            safeSummary: "Reason for the turn that never ran",
          }),
          event(1, "participant_failed", { participantId: "p1", errorCode: "AGENT_BUSY" }),
          event(2, "participant_dispatched", { participantId: "p1", runId: "run-b" }),
        ],
      }),
    );

    expect(graph.nodes[0]?.reason).toBeUndefined();
  });

  it("tolerates a detail response with no continuation prompts field", () => {
    const withoutPrompts = detail({ turns: [turn({ id: "t1", stepIndex: 0 })] });
    delete (withoutPrompts as { continuationPrompts?: unknown }).continuationPrompts;

    expect(buildOrchestrationGraph(withoutPrompts).nodes).toHaveLength(1);
  });

  it("carries the journal entries for a turn onto its node", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [turn({ id: "t1", runId: "run-a", stepIndex: 0 })],
        events: [
          event(0, "participant_dispatched", { participantId: "p1", runId: "run-a" }),
          event(1, "run_completed", { runId: "run-a", durationMs: 300 }),
          // Belongs to another Run and must not leak onto this node.
          event(2, "participant_dispatched", { participantId: "p2", runId: "run-z" }),
          // Carries no Run, so it is summarized onto the node instead.
          event(3, "handoff_applied", { participantId: "p1" }),
        ],
      }),
    );

    expect(graph.nodes[0]?.events.map((item) => item.type)).toEqual([
      "participant_dispatched",
      "run_completed",
    ]);
  });

  it("marks a failed or timed out turn as failed, and no others", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", stepIndex: 0, status: "completed" }),
          turn({ id: "t2", stepIndex: 1, status: "failed" }),
          turn({ id: "t3", stepIndex: 2, status: "timed_out" }),
          turn({ id: "t4", stepIndex: 3, status: "cancelled" }),
          turn({ id: "t5", stepIndex: 4, status: "dispatched" }),
        ],
      }),
    );

    expect(graph.nodes.map((node) => node.failed)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  it("assigns every row a unique consecutive index", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", stepIndex: 0, createdAt: "2026-09-07T10:00:00.000Z" }),
          turn({ id: "t2", stepIndex: 1, createdAt: "2026-09-07T10:05:00.000Z" }),
        ],
        continuationPrompts: [
          {
            id: "prompt-1",
            sessionId: "session-1",
            cycleIndex: 1,
            prompt: "again",
            createdAt: "2026-09-07T10:02:00.000Z",
          },
        ],
      }),
    );

    expect(graph.rows.map((row) => row.row)).toEqual([0, 1, 2]);
  });
});

describe("toFlowElements", () => {
  it("puts lanes on the x axis and execution steps on the y axis", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "t1", participantId: "p1", stepIndex: 0 }),
          turn({ id: "t2", participantId: "p2", stepIndex: 1 }),
        ],
      }),
    );

    const flow = toFlowElements(graph);

    expect(flow.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(flow.nodes[1]?.position).toEqual({
      x: FLOW_LANE_GAP,
      y: FLOW_ROW_GAP,
    });
  });

  it("connects edges by turn identity rather than by parsing an edge id", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [
          turn({ id: "turn-with->arrow", participantId: "p1", stepIndex: 0 }),
          turn({ id: "t2", participantId: "p2", stepIndex: 1 }),
        ],
      }),
    );

    const flow = toFlowElements(graph);

    expect(flow.edges[0]?.source).toBe("turn-with->arrow");
    expect(flow.edges[0]?.target).toBe("t2");
  });

  it("resolves an Agent label through the injected resolver", () => {
    const graph = buildOrchestrationGraph(
      detail({ turns: [turn({ id: "t1", agentId: "agent-p1", stepIndex: 0 })] }),
    );

    const flow = toFlowElements(graph, () => "Researcher");

    expect(flow.nodes[0]?.data).toMatchObject({ label: "Researcher" });
  });

  it("makes turns selectable and follow-up markers inert", () => {
    const graph = buildOrchestrationGraph(
      detail({
        turns: [turn({ id: "t1", stepIndex: 0, createdAt: "2026-09-07T10:00:00.000Z" })],
        continuationPrompts: [
          {
            id: "prompt-1",
            sessionId: "session-1",
            cycleIndex: 1,
            prompt: "keep going",
            createdAt: "2026-09-07T10:02:00.000Z",
          },
        ],
      }),
    );

    const flow = toFlowElements(graph);

    expect(flow.nodes.map((node) => [node.type, node.selectable])).toEqual([
      ["turn", true],
      ["cycle", false],
    ]);
    // A follow-up spans the run, so it does not sit in a lane.
    expect(flow.nodes[1]?.position.x).toBe(0);
  });

  it("returns nothing to draw for an empty model", () => {
    const flow = toFlowElements(buildOrchestrationGraph(null));

    expect(flow.nodes).toEqual([]);
    expect(flow.edges).toEqual([]);
  });
});
