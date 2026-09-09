import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrchestrationGraph } from "../../../../apps/web/src/components/orchestration/OrchestrationGraph";
import type {
  Agent,
  OrchestrationEvent,
  OrchestrationParticipant,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "../../../../apps/web/src/types";

const agents = [
  { id: "agent-p1", name: "Researcher" },
  { id: "agent-p2", name: "Writer" },
] as Agent[];

function participant(id: string, position: number): OrchestrationParticipant {
  return { id, agentId: "agent-" + id, role: "Role " + id, position };
}

function turn(overrides: Partial<OrchestrationTurn> & { id: string }): OrchestrationTurn {
  return {
    sessionId: "session-1",
    participantId: "p1",
    agentId: "agent-p1",
    runId: "run-abcdef01-" + overrides.id,
    position: 0,
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

function detail(
  overrides: Partial<OrchestrationSessionDetail> = {},
): OrchestrationSessionDetail {
  const session = {
    id: "session-1",
    name: "Session",
    originalPrompt: "Do the thing",
    participants: [participant("p1", 0), participant("p2", 1)],
    mode: "supervisor",
    projectId: null,
    completionReason: null,
    status: "completed",
    currentParticipantId: null,
    currentRunId: null,
    stepIndex: 2,
    maxSteps: 40,
    perAgentTimeoutMs: 600_000,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:05:00.000Z",
    startedAt: "2026-09-07T10:00:00.000Z",
    completedAt: "2026-09-07T10:05:00.000Z",
  } as unknown as OrchestrationSession;
  return {
    session,
    turns: [],
    events: [] as OrchestrationEvent[],
    continuationPrompts: [],
    ...overrides,
  };
}

describe("OrchestrationGraph", () => {
  it("draws one row per dispatched turn, not one card per lane", () => {
    const html = renderToStaticMarkup(
      <OrchestrationGraph
        detail={detail({
          turns: [
            turn({ id: "t1", participantId: "p1", stepIndex: 0 }),
            turn({
              id: "t2",
              participantId: "p2",
              agentId: "agent-p2",
              stepIndex: 1,
              safeInputSummary: "Write it up",
            }),
          ],
        })}
        agents={agents}
      />,
    );

    expect(html).toContain("2 turns");
    expect(html).toContain("Summarise the brief");
    expect(html).toContain("Write it up");
    // Step numbers keep the Activity log's own numbering.
    expect(html).toContain(">01<");
    expect(html).toContain(">02<");
  });

  it("keeps every row collapsed until one is opened", () => {
    const html = renderToStaticMarkup(
      <OrchestrationGraph
        detail={detail({ turns: [turn({ id: "t1", stepIndex: 0 })] })}
        agents={agents}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    // The turn detail belongs to the open state, so nothing quotes it yet.
    expect(html).not.toContain("Here is the summary");
  });

  it("marks a follow-up as its own row rather than a lane", () => {
    const html = renderToStaticMarkup(
      <OrchestrationGraph
        detail={detail({
          turns: [
            turn({
              id: "t1",
              stepIndex: 0,
              createdAt: "2026-09-07T10:00:00.000Z",
            }),
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
        })}
        agents={agents}
      />,
    );

    expect(html).toContain("Follow-up 1");
    expect(html).toContain("keep going");
  });

  it("offers a failure filter only when a turn actually failed", () => {
    const clean = renderToStaticMarkup(
      <OrchestrationGraph
        detail={detail({ turns: [turn({ id: "t1", stepIndex: 0 })] })}
        agents={agents}
      />,
    );
    expect(clean).not.toContain("Failed 1");

    const broken = renderToStaticMarkup(
      <OrchestrationGraph
        detail={detail({
          turns: [
            turn({ id: "t1", stepIndex: 0 }),
            turn({
              id: "t2",
              stepIndex: 1,
              status: "failed",
              errorCode: "RUN_FAILED",
            }),
          ],
        })}
        agents={agents}
      />,
    );
    expect(broken).toContain("Failed 1");
  });

  it("caps a long run rather than drawing every turn at once", () => {
    const turns = Array.from({ length: 60 }, (_, index) =>
      turn({ id: "t" + index, stepIndex: index }),
    );
    const html = renderToStaticMarkup(
      <OrchestrationGraph detail={detail({ turns })} agents={agents} />,
    );

    expect(html).toContain("60 turns");
    expect(html).toContain("Show 20 earlier turns");
  });

  it("labels a row with the task, not the prompt that was sent", () => {
    const html = renderToStaticMarkup(
      <OrchestrationGraph
        detail={detail({
          turns: [
            turn({
              id: "t1",
              stepIndex: 0,
              safeInputSummary: [
                "You are participating in a shared multi-Agent conversation.",
                "You are participant p1 (Agent agent-p1), in role Reviewer, at position 0.",
                "",
                "<orchestration_task>",
                "Build a to-do app",
                "</orchestration_task>",
                "",
                "Handoff safety contract:",
                "- Return only your normal participant response as ordinary output.",
              ].join("\n"),
            }),
          ],
        })}
        agents={agents}
      />,
    );

    expect(html).toContain("Build a to-do app");
    expect(html).not.toContain("orchestration_task");
    expect(html).not.toContain("Handoff safety contract");
  });

  it("says there is nothing to draw before the first turn", () => {
    const html = renderToStaticMarkup(
      <OrchestrationGraph detail={detail()} agents={agents} />,
    );

    expect(html).toContain("No turns to graph yet");
  });
});
