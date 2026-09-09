import type { ToolApproval, ToolApprovalStatus } from "../../types";
import {
  approvalDecisionAllowed,
  approvalEligibilityReason,
  approvalStatusLabel,
  boundedApprovalSummary,
  displayApprovalStatus,
  formatApprovalDeadline,
  isTerminalApprovalStatus,
  shortApprovalId,
  toolApprovalLabel,
} from "./approval-utils";

export interface ToolApprovalCardProps {
  approval: ToolApproval;
  /** Agent name is a display hint; the approval's server-owned ID remains visible. */
  agentName?: string | null;
  projectName?: string | null;
  /** Label for the surrounding direct Run or Team conversation. */
  runLabel?: string | null;
  submitting?: boolean;
  submittingAction?: "approve" | "reject" | null;
  decisionError?: string | null;
  onDecision?: (approved: boolean) => void;
}

const TERMINAL_NOTES: Partial<Record<ToolApprovalStatus, string>> = {
  succeeded: "The protected action finished successfully.",
  rejected: "The Agent will not execute this protected action.",
  failed_pre_execution: "The protected action did not start.",
  failed: "The protected action failed after approval.",
  expired: "The deadline passed before a decision was accepted.",
  cancelled: "The originating Run or session was cancelled.",
  revoked: "The approval was invalidated before execution.",
  uncertain: "The outcome could not be confirmed. Review the Run activity before retrying.",
};

function fallbackAgentName(approval: ToolApproval, agentName?: string | null): string {
  return agentName?.trim() || `Agent ${shortApprovalId(approval.agentId)}`;
}

function fallbackProjectName(approval: ToolApproval, projectName?: string | null): string | null {
  if (projectName?.trim()) return projectName.trim();
  return approval.projectId ? `Workspace ${shortApprovalId(approval.projectId)}` : null;
}

function fallbackRunLabel(approval: ToolApproval, runLabel?: string | null): string {
  return runLabel?.trim() || `Run ${shortApprovalId(approval.runId)}`;
}

function statusNote(status: ToolApprovalStatus): string | null {
  if (status === "approved") return "Approval accepted; the Agent is resuming the Run.";
  if (status === "resuming") return "Approval accepted; the protected action is resuming.";
  if (status === "executing") return "The protected action is executing.";
  return TERMINAL_NOTES[status] ?? null;
}

export function ToolApprovalCard({
  approval,
  agentName,
  projectName,
  runLabel,
  submitting = false,
  submittingAction = null,
  decisionError = null,
  onDecision,
}: ToolApprovalCardProps) {
  const status = displayApprovalStatus(approval);
  const statusLabel = approvalStatusLabel(status);
  const canDecide =
    onDecision !== undefined &&
    approvalDecisionAllowed(approval) &&
    !isTerminalApprovalStatus(status);
  const eligibilityReason = approvalEligibilityReason(approval);
  const headingId = `tool-approval-${approval.approvalId}-heading`;
  const summaryId = `tool-approval-${approval.approvalId}-summary`;
  const statusId = `tool-approval-${approval.approvalId}-status`;
  const agent = fallbackAgentName(approval, agentName);
  const project = fallbackProjectName(approval, projectName);
  const run = fallbackRunLabel(approval, runLabel);

  return (
    <article
      className={`tool-approval-card tool-approval-card-${status}`}
      data-approval-id={approval.approvalId}
      data-status={status}
      aria-labelledby={headingId}
      aria-describedby={`${summaryId} ${statusId}`}
    >
      <div className="tool-approval-card-heading">
        <div className="tool-approval-card-title">
          <span className="tool-approval-eyebrow">Approval request</span>
          <h3 id={headingId}>{toolApprovalLabel(approval.toolId)}</h3>
        </div>
        <span
          id={statusId}
          className={`tool-approval-status tool-approval-status-${status}`}
          role="status"
          aria-label={`Approval status: ${statusLabel}`}
        >
          <span className="tool-approval-status-dot" aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

      <p id={summaryId} className="tool-approval-summary">
        {boundedApprovalSummary(approval.safeSummary)}
      </p>

      <dl className="tool-approval-facts">
        <div>
          <dt>Agent</dt>
          <dd>{agent}</dd>
        </div>
        {project && (
          <div>
            <dt>Workspace</dt>
            <dd>{project}</dd>
          </div>
        )}
        <div>
          <dt>Run</dt>
          <dd title={approval.runId}>{run}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd title={approval.deadlineAt}>{formatApprovalDeadline(approval.deadlineAt)}</dd>
        </div>
      </dl>

      {decisionError && (
        <p className="tool-approval-error" role="alert">
          {decisionError}
        </p>
      )}

      {canDecide ? (
        <div className="tool-approval-actions" aria-label="Approval decision">
          <button
            type="button"
            className="tool-approval-action tool-approval-action-approve"
            disabled={submitting}
            aria-describedby={summaryId}
            onClick={() => onDecision?.(true)}
          >
            {submitting && submittingAction === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            className="tool-approval-action tool-approval-action-reject"
            disabled={submitting}
            aria-describedby={summaryId}
            onClick={() => onDecision?.(false)}
          >
            {submitting && submittingAction === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      ) : (
        <p className="tool-approval-note" role="status">
          {eligibilityReason ?? statusNote(status) ?? "This approval is no longer awaiting a decision."}
        </p>
      )}
    </article>
  );
}

export interface ToolApprovalListProps {
  approvals: readonly ToolApproval[];
  getAgentName?: (agentId: string) => string | null | undefined;
  projectName?: string | null;
  runLabel?: string | null;
  pendingDecisionId?: string | null;
  pendingDecision?: "approve" | "reject" | null;
  decisionErrors?: Readonly<Record<string, string>>;
  onDecision?: (approvalId: string, approved: boolean) => void;
  className?: string;
}

/** Reusable list used by direct Run, Team, and participant detail surfaces. */
export function ToolApprovalList({
  approvals,
  getAgentName,
  projectName = null,
  runLabel = null,
  pendingDecisionId = null,
  pendingDecision = null,
  decisionErrors = {},
  onDecision,
  className = "",
}: ToolApprovalListProps) {
  if (approvals.length === 0) return null;
  return (
    <section
      className={`tool-approval-list${className ? ` ${className}` : ""}`}
      aria-label="Tool approval requests"
    >
      <div className="tool-approval-list-heading">
        <div>
          <span className="tool-approval-eyebrow">Control surface</span>
          <h2>Approvals</h2>
        </div>
        <span className="tool-approval-list-count">
          {approvals.length} {approvals.length === 1 ? "request" : "requests"}
        </span>
      </div>
      <div className="tool-approval-list-items">
        {approvals.map((approval) => (
          <ToolApprovalCard
            key={approval.approvalId}
            approval={approval}
            agentName={getAgentName?.(approval.agentId)}
            projectName={projectName}
            runLabel={runLabel}
            // The hook deliberately permits only one decision request at a
            // time. Disable every card while that single-flight request is
            // pending so the affordances cannot imply that another click can
            // be accepted concurrently.
            submitting={pendingDecisionId !== null}
            submittingAction={pendingDecisionId === approval.approvalId ? pendingDecision : null}
            decisionError={decisionErrors[approval.approvalId] ?? null}
            onDecision={
              onDecision
                ? (approved) => onDecision(approval.approvalId, approved)
                : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}
