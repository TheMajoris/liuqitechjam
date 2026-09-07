import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrchestrationTurnInspector } from "../../../../apps/web/src/components/orchestration/OrchestrationTurnInspector";
import type { GraphNode } from "../../../../apps/web/src/components/orchestration/orchestration-graph";
import type {
  Agent,
  OrchestrationEvent,
  OrchestrationTurn,
} from "../../../../apps/web/src/types";

const agents = [
  { id: "agent-p1", name: "Researcher" },
  { id: "agent-p2", name: "Writer" },
] as Agent[];

function turn(overrides: Partial<OrchestrationTurn> = {}): OrchestrationTurn {
  return {
    id: "t1",
    sessionId: "session-1",
    participantId: "p1",
    agentId: "agent-p1",
    runId: "9f8e7d6c-0000-4000-8000-000000000001",
    position: 0,
    stepIndex: 2,
    status: "completed",
    safeInputSummary: "Summarise the brief",
    safeOutput: "Here is the summary",
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

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  const base = overrides.turn ?? turn();
  return {
    kind: "turn",
    id: base.id,
    row: 2,
    column: 0,
    turn: base,
    stepNumber: 3,
    runId: base.runId,
    durationMs: 4_200,
    cycleIndex: 0,
    reason: undefined,
    events: [],
    failed: base.status === "failed" || base.status === "timed_out",
    ...overrides,
  };
}

describe("OrchestrationTurnInspector", () => {
  it("states the status, timing and Run of the selected turn", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector node={node()} agents={agents} onClose={() => {}} />,
    );

    expect(html).toContain("Step 3");
    expect(html).toContain("Researcher");
    expect(html).toContain("Replied");
    expect(html).toContain("4.2 s");
    // Run IDs are shown short, the way the Activity log shows them.
    expect(html).toContain("9f8e7d6c");
  });

  it("lists the journal entries recorded against the Run", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node({
          events: [
            event(0, "participant_dispatched", { runId: "run-a" }),
            event(1, "run_completed", { runId: "run-a" }),
          ],
        })}
        agents={agents}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Agent turn dispatched");
    expect(html).toContain("Agent turn completed");
  });

  it("says so when a Run recorded no events", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector node={node()} agents={agents} onClose={() => {}} />,
    );

    expect(html).toContain("No events recorded for this Run.");
  });

  it("offers no retry for a turn that succeeded", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node()}
        agents={agents}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).not.toContain("Retry from this turn");
  });

  it("offers a retry for a failed turn and warns that files are not rolled back", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node({ turn: turn({ status: "failed", errorCode: "RUN_FAILED" }) })}
        agents={agents}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Retry from this turn");
    expect(html).toContain("not rolled back");
    // The failure is explained in product wording, with the code kept.
    expect(html).toContain("An Agent could not complete its turn.");
    expect(html).toContain("RUN_FAILED");
  });

  it("hides the retry when the caller cannot perform one", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node({ turn: turn({ status: "failed" }) })}
        agents={agents}
        onClose={() => {}}
      />,
    );

    expect(html).not.toContain("Retry from this turn");
  });

  it("will not retry a legacy turn that has no execution step", () => {
    const legacy = turn({ status: "failed" });
    delete (legacy as { stepIndex?: number }).stepIndex;

    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node({ turn: legacy })}
        agents={agents}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).not.toContain("Retry from this turn");
  });

  it("disables the retry while the conversation is still running", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node({ turn: turn({ status: "failed" }) })}
        agents={agents}
        onRetry={() => {}}
        retryBlocked
        onClose={() => {}}
      />,
    );

    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("Stop the conversation before retrying it.");
  });

  it("shows progress while a retry is in flight", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node({ turn: turn({ status: "failed" }) })}
        agents={agents}
        onRetry={() => {}}
        retryPending
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Retrying…");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("never shows engine vocabulary from a recorded reason", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node({ reason: "Supervisor picked the next workflow node" })}
        agents={agents}
        onClose={() => {}}
      />,
    );

    expect(html).not.toContain("workflow node");
    expect(html).not.toContain("Why this Agent");
  });

  it("shows a safe routing reason when one was recorded", () => {
    const html = renderToStaticMarkup(
      <OrchestrationTurnInspector
        node={node({ reason: "The brief needed reading first" })}
        agents={agents}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("Why this Agent");
    expect(html).toContain("The brief needed reading first");
  });
});
