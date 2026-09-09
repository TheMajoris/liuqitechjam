import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolApproval } from "../../../../apps/web/src/types";
import { ToolApprovalPrompt } from "../../../../apps/web/src/components/approvals/ToolApprovalPrompt";

function approval(overrides: Partial<ToolApproval> = {}): ToolApproval {
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
    safeSummary: "Search the web for the latest information about the requested topic.",
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
    ...overrides,
  };
}

describe("ToolApprovalPrompt", () => {
  it("renders a compact, accessible Web Search decision beside a composer", () => {
    const html = renderToStaticMarkup(
      <ToolApprovalPrompt
        approvals={[approval()]}
        getAgentName={() => "Research Agent"}
        runLabel="Search the latest docs"
        onDecision={() => undefined}
      />,
    );

    expect(html).toContain('class="tool-approval-prompt tool-approval-prompt-waiting"');
    expect(html).toContain("Web Search");
    expect(html).toContain("Search the web for the latest information");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).toContain("left");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("aria-label=\"Approval decision\"");
    expect(html).not.toContain("Control surface");
  });

  it("collapses terminal state and offers an explicit dismiss action", () => {
    const html = renderToStaticMarkup(
      <ToolApprovalPrompt
        approvals={[approval({ status: "succeeded", decision: "approved" })]}
        onDecision={() => undefined}
      />,
    );

    expect(html).toContain("Web Search succeeded");
    expect(html).toContain("Show details");
    expect(html).toContain("Dismiss");
    expect(html).toContain('aria-label="Tool approval: Web Search"');
    expect(html).not.toContain('aria-labelledby="tool-approval-prompt-approval-web-1-heading"');
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("finished successfully");
  });
});
