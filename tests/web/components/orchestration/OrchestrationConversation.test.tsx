import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  Agent,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationStatus,
} from "../../../../apps/web/src/types";
import { OrchestrationConversation } from "../../../../apps/web/src/components/orchestration/OrchestrationConversation";

const agents: Agent[] = [
  {
    id: "agent-1",
    name: "fe builder2",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/agents/agent-1",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function detailFor(status: OrchestrationStatus): OrchestrationSessionDetail {
  const session: OrchestrationSession = {
    id: "session-1",
    name: "Build the todo app",
    originalPrompt: "Build a todo app.",
    projectId: "project-1",
    participants: [{ id: "p1", agentId: "agent-1", role: "builder", position: 0 }],
    mode: "supervisor",
    status,
    currentParticipantId: status === "running" ? "p1" : null,
    currentRunId: null,
    stepIndex: 0,
    maxSteps: 6,
    perAgentTimeoutMs: 300_000,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
  return { session, turns: [], events: [], continuationPrompts: [] };
}

function render(status: OrchestrationStatus) {
  return renderToStaticMarkup(
    <OrchestrationConversation
      detail={detailFor(status)}
      agents={agents}
      action={null}
      onContinue={() => undefined}
    />,
  );
}

describe("Team conversation composer", () => {
  it("renders the shared StickyComposer in the Team conversation", () => {
    const html = render("completed");

    expect(html).toContain("composer-dock");
    expect(html).toContain("composer-input");
    // Scrolling belongs to the message region, not the whole panel.
    expect(html).toContain("orch-chat-scroll");
    // The input itself accepts a follow-up; only the send button gates on text.
    expect(html).toMatch(/<textarea class="composer-input"(?![^>]*disabled)/);
    expect(html).toContain("Enter to send");
  });

  it("keeps the composer visible but locked while an Agent is executing", () => {
    const html = render("running");

    expect(html).toMatch(/<textarea class="composer-input"[^>]*disabled=""/);
    expect(html).toContain("fe builder2 is working…");
  });

  it("keeps the first-message composer enabled for a draft", () => {
    const detail = detailFor("draft");
    detail.session.originalPrompt = "";
    const html = renderToStaticMarkup(
      <OrchestrationConversation
        detail={detail}
        agents={agents}
        action={null}
        onContinue={() => undefined}
      />,
    );

    expect(html).toContain("Type the first task to start this conversation…");
    expect(html).toMatch(/<textarea class="composer-input"(?![^>]*disabled)/);
    expect(html).not.toContain("orch-chat-item-user");
  });
});
