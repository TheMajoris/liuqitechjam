import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolApproval } from "../../../../apps/web/src/types";
import {
  ToolApprovalCard,
  ToolApprovalList,
} from "../../../../apps/web/src/components/approvals/ToolApprovalCard";
import { mergeToolApprovals } from "../../../../apps/web/src/components/approvals/approval-utils";

function approval(overrides: Partial<ToolApproval> = {}): ToolApproval {
  return {
    approvalId: "approval-1",
    invocationId: "invocation-1",
    workflowRunId: "workflow-1",
    agentId: "agent-1",
    projectId: "project-1",
    runId: "run-direct-1",
    orchestrationId: null,
    turnId: null,
    sessionId: null,
    toolId: "project.preview.restart",
    policyVersion: "v1",
    safeSummary: "Restart the project preview after the Agent changes files.",
    deadlineAt: "2999-01-01T00:00:00.000Z",
    status: "waiting",
    version: 2,
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

describe("ToolApprovalCard", () => {
  it("keeps direct Run context visible, disables an in-flight decision, reconciles stale data, and labels terminal state", () => {
    const waiting = approval();
    const stale = mergeToolApprovals([waiting], [approval({ version: 1, updatedAt: "2026-09-08T00:00:00.000Z" })]);
    expect(stale[0]?.version).toBe(2);

    const pendingHtml = renderToStaticMarkup(
      <ToolApprovalCard
        approval={waiting}
        agentName="Direct Agent"
        runLabel="Direct Run run-dire"
        submitting
        submittingAction="approve"
        onDecision={() => undefined}
      />,
    );
    expect(pendingHtml).toContain("Direct Agent");
    expect(pendingHtml).toContain("Direct Run run-dire");
    expect(pendingHtml).toContain("Approving…");
    expect(pendingHtml).toMatch(/<button[^>]*disabled/);

    const terminalHtml = renderToStaticMarkup(
      <ToolApprovalCard
        approval={approval({ status: "succeeded", decision: "approved" })}
        agentName="Direct Agent"
        onDecision={() => undefined}
      />,
    );
    expect(terminalHtml).toContain("Succeeded");
    expect(terminalHtml).toContain("finished successfully");
    expect(terminalHtml).not.toContain(">Approve<");
  });

  it("projects an expired waiting approval as expired without exposing raw input", () => {
    const html = renderToStaticMarkup(
      <ToolApprovalCard
        approval={approval({
          safeSummary: "Restart the preview for the current workspace.",
          deadlineAt: "2020-01-01T00:00:00.000Z",
        })}
        onDecision={() => undefined}
      />,
    );
    expect(html).toContain("Expired");
    expect(html).toContain("deadline passed");
    expect(html).toContain("Restart the preview for the current workspace.");
  });

  it("fails closed when the server omits eligibility", () => {
    const html = renderToStaticMarkup(
      <ToolApprovalCard
        approval={approval({ decisionEligible: undefined })}
        onDecision={() => undefined}
      />,
    );

    expect(html).not.toContain(">Approve<");
    expect(html).toContain("Decision eligibility is unavailable.");
  });

  it("uses explicit server eligibility to gate the decision controls", () => {
    const ineligible = renderToStaticMarkup(
      <ToolApprovalCard
        approval={approval({ decisionEligible: false })}
        onDecision={() => undefined}
      />,
    );
    expect(ineligible).not.toContain(">Approve<");
    expect(ineligible).toContain("not eligible to decide");
  });

  it("disables every approval while the shared decision guard is busy", () => {
    const html = renderToStaticMarkup(
      <ToolApprovalList
        approvals={[approval(), approval({ approvalId: "approval-2", invocationId: "invocation-2" })]}
        pendingDecisionId="approval-1"
        pendingDecision="approve"
        onDecision={() => undefined}
      />,
    );

    expect((html.match(/tool-approval-action-(?:approve|reject)/g) ?? []).length).toBe(4);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(4);
  });
});
