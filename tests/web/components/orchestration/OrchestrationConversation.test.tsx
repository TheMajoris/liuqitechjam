import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  Agent,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationStatus,
  OrchestrationTurn,
  ToolApproval,
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

function failedTurn(): OrchestrationTurn {
  return {
    id: "turn-1",
    sessionId: "session-1",
    participantId: "p1",
    agentId: "agent-1",
    runId: "run-1",
    stepIndex: 0,
    position: 0,
    status: "failed",
    safeInputSummary: "Build the todo app",
    safeOutput: null,
    outputTruncated: false,
    errorCode: "WEB_TOOL_PERMISSION_DENIED",
    createdAt: "2026-01-01T00:00:01.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
  };
}

function webSearchApproval(): ToolApproval {
  return {
    approvalId: "approval-web-1",
    invocationId: "invocation-web-1",
    workflowRunId: "workflow-web-1",
    agentId: "agent-1",
    projectId: "project-1",
    runId: "run-web-1",
    orchestrationId: "session-1",
    turnId: "turn-1",
    sessionId: "session-1",
    toolId: "web.search",
    policyVersion: "v1",
    safeSummary: "Search the web for the requested information.",
    deadlineAt: "2999-01-01T00:00:00.000Z",
    status: "waiting",
    version: 1,
    ownerEpoch: 1,
    decision: null,
    decisionActor: null,
    decisionAt: null,
    decisionReason: null,
    traceRefs: {},
    executionStartedAt: null,
    completedAt: null,
    terminalReason: null,
    cancellationRequestedAt: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    decisionEligible: true,
  };
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

  it("places a compact Web Search approval beside the Team composer", () => {
    const html = renderToStaticMarkup(
      <OrchestrationConversation
        detail={detailFor("running")}
        agents={agents}
        approvals={[webSearchApproval()]}
        onApprovalDecision={() => undefined}
        onContinue={() => undefined}
      />,
    );

    const promptIndex = html.indexOf("tool-approval-prompt");
    const composerIndex = html.indexOf("composer-dock");
    expect(promptIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(composerIndex);
    expect(html).toContain("Web Search");
    expect(html).toContain("Approve");
    expect(html).not.toContain("Control surface");
  });

  it("offers retry from a failed turn and explains the workspace file behavior", () => {
    const detail = detailFor("failed");
    detail.turns = [failedTurn()];
    const html = renderToStaticMarkup(
      <OrchestrationConversation
        detail={detail}
        agents={agents}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(html).toContain("Retry this turn");
    // The transcript states the cause in one line; the steps that go with it
    // live in the Agent inspector's "What to try", not under every turn.
    expect(html).toContain("Web access was denied for this Agent.");
    expect(html).not.toContain("Assign this Agent a role that allows");
    // The file behaviour is spelled out rather than named: "current files"
    // was the internal term for it and meant nothing to the reader.
    expect(html).toContain("Workspace files as they are now");
    expect(html).toContain("nothing is rolled back");
    expect(html).not.toContain("current files");
    expect(html).not.toContain("continuing from the checkpoint");
  });

  it("offers a restore for a completed turn with a recoverable checkpoint", () => {
    const detail = detailFor("completed");
    detail.turns = [
      {
        ...failedTurn(),
        status: "completed",
        errorCode: null,
        safeOutput: "Done.",
        workspaceCheckpointId: "cp-9",
      },
    ];
    detail.checkpoints = [
      {
        checkpointId: "cp-9",
        projectId: "project-1",
        ordinal: 3,
        kind: "turn_success",
        state: "ready",
        orchestrationId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        stepIndex: 0,
        createdAt: "2026-01-01T00:00:06.000Z",
        fileCount: 4,
        byteCount: 100,
        excludedFileCount: 0,
        recoverable: true,
        unavailableReason: null,
      },
    ];
    const html = renderToStaticMarkup(
      <OrchestrationConversation
        detail={detail}
        agents={agents}
        onRecover={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(html).toContain("Checkpoint #3");
    expect(html).toContain("Restore after fe builder2 and resume");
    expect(html).toContain("safety checkpoint");
    expect(html).not.toContain("cp-9");
  });

  it("disables retry while the session is active or retry is pending", () => {
    const activeDetail = detailFor("running");
    activeDetail.turns = [failedTurn()];
    const activeHtml = renderToStaticMarkup(
      <OrchestrationConversation
        detail={activeDetail}
        agents={agents}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );
    expect(activeHtml).toMatch(/<button[^>]*class="orch-chat-retry-action"[^>]*disabled/);
    expect(activeHtml).toContain("Stop the conversation before retrying it.");

    const pendingDetail = detailFor("failed");
    pendingDetail.turns = [failedTurn()];
    const pendingHtml = renderToStaticMarkup(
      <OrchestrationConversation
        detail={pendingDetail}
        agents={agents}
        action="retry"
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );
    expect(pendingHtml).toContain("Retrying…");
    expect(pendingHtml).toMatch(/<button[^>]*class="orch-chat-retry-action"[^>]*disabled/);
  });

  it("states a turn failure once rather than under and after the turn", () => {
    const detail = detailFor("failed");
    detail.turns = [failedTurn()];
    detail.session.errorCode = "RUN_FAILED";

    const html = renderToStaticMarkup(
      <OrchestrationConversation
        detail={detail}
        agents={agents}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    // The failed turn's own row carries the reason; the closing line below it
    // repeated the same sentence, and the header alert says it a third time.
    const failureText = "Could not finish";
    expect(html).toContain(failureText);
    expect(html).not.toContain("orch-chat-note is-failure");
  });

  it("keeps a rate-limited turn to one line and leaves the advice elsewhere", () => {
    const detail = detailFor("failed");
    const failed = failedTurn();
    failed.errorCode = "MODEL_RATE_LIMITED";
    failed.modelId = "ep-20260830033025-z5s5c";
    detail.turns = [failed];

    const html = renderToStaticMarkup(
      <OrchestrationConversation
        detail={detail}
        agents={agents}
        onRetry={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(html).toContain(
      "model ep-20260830033025-z5s5c was rate limited by the provider.",
    );
    expect(html).not.toContain("Safe Experience Mode");
    expect(html).not.toContain("choose another model");
  });

  it("explains when supervisor routing needs another try", () => {
    const detail = detailFor("failed");
    detail.session.errorCode = "SUPERVISOR_INVALID_SELECTION";
    detail.session.errorMessage =
      "The supervisor did not select an Agent to answer this follow-up.";

    const html = renderToStaticMarkup(
      <OrchestrationConversation detail={detail} agents={agents} action={null} />,
    );

    expect(html).toContain(
      "The supervisor could not choose the next Agent. Try again or review the Team roster.",
    );
  });
});
