import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolApproval, ToolApprovalStatus } from "../../types";
import {
  ACTIVE_APPROVAL_STATUSES,
  approvalDecisionAllowed,
  approvalEligibilityReason,
  approvalStatusLabel,
  boundedApprovalSummary,
  displayApprovalStatus,
  isTerminalApprovalStatus,
  shortApprovalId,
  toolApprovalLabel,
} from "./approval-utils";

export interface ToolApprovalPromptProps {
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

const WAITING_STATUSES: readonly ToolApprovalStatus[] = ["requested", "waiting"];

function fallbackAgentName(approval: ToolApproval, name?: string | null): string {
  return name?.trim() || `Agent ${shortApprovalId(approval.agentId)}`;
}

function fallbackRunLabel(approval: ToolApproval, label?: string | null): string {
  return label?.trim() || `Run ${shortApprovalId(approval.runId)}`;
}

function formatRemaining(milliseconds: number): string {
  if (milliseconds <= 0) return "Expired";
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s left`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s left`;
}

function sortNewest(left: ToolApproval, right: ToolApproval): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.approvalId.localeCompare(left.approvalId);
}

function terminalNote(status: ToolApprovalStatus, toolLabel: string): string {
  switch (status) {
    case "succeeded":
      return `${toolLabel} finished successfully.`;
    case "rejected":
      return `The Agent will not run this ${toolLabel}.`;
    case "failed_pre_execution":
      return `${toolLabel} did not start.`;
    case "failed":
      return `${toolLabel} failed after approval.`;
    case "expired":
      return "The approval expired before a decision was accepted.";
    case "cancelled":
      return "The originating conversation was cancelled.";
    case "revoked":
      return "The approval was revoked before execution.";
    case "uncertain":
      return "The outcome is uncertain; review Activity for details.";
    default:
      return "This approval is no longer awaiting a decision.";
  }
}

/**
 * A compact, composer-adjacent approval surface for live conversations.
 *
 * The larger ToolApprovalList remains useful in Activity and Run detail where
 * people are explicitly investigating history. This prompt is intentionally a
 * single live request so an approval never pushes the conversation away.
 */
export function ToolApprovalPrompt({
  approvals,
  getAgentName,
  projectName = null,
  runLabel = null,
  pendingDecisionId = null,
  pendingDecision = null,
  decisionErrors = {},
  onDecision,
  className = "",
}: ToolApprovalPromptProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(true);
  const [dismissedTerminalIds, setDismissedTerminalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousActiveId = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const activeApprovals = useMemo(
    () =>
      approvals
        .filter((approval) => ACTIVE_APPROVAL_STATUSES.includes(displayApprovalStatus(approval, now)))
        .sort(sortNewest),
    [approvals, now],
  );
  const activeApproval = activeApprovals[0] ?? null;
  const terminalApproval = useMemo(
    () =>
      approvals
        .filter(
          (approval) =>
            isTerminalApprovalStatus(displayApprovalStatus(approval, now)) &&
            !dismissedTerminalIds.has(approval.approvalId),
        )
        .sort(sortNewest)[0] ?? null,
    [approvals, dismissedTerminalIds, now],
  );

  // A waiting approval needs a local countdown. The server remains the
  // authority; the next useToolApprovals poll reconciles expiry.
  useEffect(() => {
    const candidate = activeApproval;
    if (!candidate || !WAITING_STATUSES.includes(displayApprovalStatus(candidate, now))) return;
    const deadline = Date.parse(candidate.deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeApproval, now]);

  // Make a newly-created request discoverable without stealing focus from a
  // user who is typing. The heading remains keyboard-focusable for a screen
  // reader or keyboard user who tabs into the live region.
  useEffect(() => {
    const activeId = activeApproval?.approvalId ?? null;
    if (activeId && activeId !== previousActiveId.current) {
      previousActiveId.current = activeId;
      if (document.activeElement === document.body) {
        headingRef.current?.focus({ preventScroll: true });
      }
      setCollapsed(false);
    }
    if (!activeId) previousActiveId.current = null;
  }, [activeApproval?.approvalId]);

  if (!activeApproval && !terminalApproval) return null;

  if (!activeApproval && terminalApproval) {
    const status = displayApprovalStatus(terminalApproval, now);
    const statusLabel = approvalStatusLabel(status);
    const toolLabel = toolApprovalLabel(terminalApproval.toolId);
    const terminalId = `tool-approval-prompt-${terminalApproval.approvalId}`;
    const headingId = `${terminalId}-heading`;
    const expanded = !terminalCollapsed;
    return (
      <section
        className={`tool-approval-prompt tool-approval-prompt-terminal${className ? ` ${className}` : ""}`}
        aria-labelledby={expanded ? headingId : undefined}
        aria-label={!expanded ? `Tool approval: ${toolLabel}` : undefined}
        aria-live="polite"
        aria-atomic="true"
        data-approval-id={terminalApproval.approvalId}
        data-status={status}
      >
        <div className="tool-approval-prompt-bar">
          <span className={`tool-approval-prompt-status tool-approval-prompt-status-${status}`} role="status">
            <span className="tool-approval-status-dot" aria-hidden="true" />
            {toolLabel} {statusLabel.toLowerCase()}
          </span>
          <div className="tool-approval-prompt-terminal-actions">
            <button
              type="button"
              className="tool-approval-prompt-link"
              aria-expanded={expanded}
              aria-controls={`${terminalId}-details`}
              onClick={() => setTerminalCollapsed((value) => !value)}
            >
              {expanded ? "Hide details" : "Show details"}
            </button>
            <button
              type="button"
              className="tool-approval-prompt-link"
              onClick={() =>
                setDismissedTerminalIds((current) => {
                  const next = new Set(current);
                  next.add(terminalApproval.approvalId);
                  return next;
                })
              }
            >
              Dismiss
            </button>
          </div>
        </div>
        {expanded && (
          <div id={`${terminalId}-details`} className="tool-approval-prompt-terminal-details">
            <h3 id={headingId}>{toolLabel}</h3>
            <p>{terminalNote(status, toolLabel)}</p>
          </div>
        )}
      </section>
    );
  }

  // The branch above guarantees this value for TypeScript and for the render
  // below, while keeping the no-approval path a true null render.
  const approval = activeApproval as ToolApproval;
  const status = displayApprovalStatus(approval, now);
  const statusLabel = approvalStatusLabel(status);
  const waiting = WAITING_STATUSES.includes(status);
  const canDecide = Boolean(onDecision) && approvalDecisionAllowed(approval, now);
  const eligibilityReason = approvalEligibilityReason(approval);
  const deadline = Date.parse(approval.deadlineAt);
  const remaining = Number.isFinite(deadline) ? formatRemaining(deadline - now) : "Deadline unavailable";
  const headingId = `tool-approval-prompt-${approval.approvalId}-heading`;
  const summaryId = `tool-approval-prompt-${approval.approvalId}-summary`;
  const statusId = `tool-approval-prompt-${approval.approvalId}-status`;
  const agent = fallbackAgentName(approval, getAgentName?.(approval.agentId));
  const waitingCount = activeApprovals.filter((item) =>
    WAITING_STATUSES.includes(displayApprovalStatus(item, now)),
  ).length - (waiting ? 1 : 0);
  const decisionError = decisionErrors[approval.approvalId] ?? null;
  const isSubmitting = pendingDecisionId !== null;

  return (
    <section
      className={`tool-approval-prompt tool-approval-prompt-${status}${collapsed ? " is-collapsed" : ""}${className ? ` ${className}` : ""}`}
      aria-labelledby={headingId}
      aria-describedby={!collapsed ? `${summaryId} ${statusId}` : statusId}
      aria-live="polite"
      aria-atomic="false"
      data-approval-id={approval.approvalId}
      data-status={status}
    >
      <div className="tool-approval-prompt-bar">
        <div className="tool-approval-prompt-identity">
          <span className="tool-approval-prompt-icon" aria-hidden="true">!</span>
          <div>
            <span className="tool-approval-eyebrow">Approval needed</span>
            <h3 id={headingId} ref={headingRef} tabIndex={-1}>{toolApprovalLabel(approval.toolId)}</h3>
          </div>
        </div>
        <div className="tool-approval-prompt-meta">
          <span
            id={statusId}
            className={`tool-approval-prompt-status tool-approval-prompt-status-${status}`}
            role="status"
            aria-label={`Approval status: ${statusLabel}`}
          >
            <span className="tool-approval-status-dot" aria-hidden="true" />
            {waiting ? remaining : statusLabel}
          </span>
          <button
            type="button"
            className="tool-approval-prompt-collapse"
            aria-expanded={!collapsed}
            aria-controls={`${headingId}-details`}
            aria-label={collapsed ? "Expand approval request" : "Collapse approval request"}
            onClick={() => setCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{collapsed ? "⌄" : "⌃"}</span>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div id={`${headingId}-details`} className="tool-approval-prompt-details">
          <p id={summaryId} className="tool-approval-prompt-summary">
            {boundedApprovalSummary(approval.safeSummary)}
          </p>
          <p className="tool-approval-prompt-context">
            Requested by <strong>{agent}</strong>
            {projectName?.trim() ? <> · {projectName.trim()}</> : null}
            {runLabel?.trim() ? <> · {fallbackRunLabel(approval, runLabel)}</> : null}
          </p>

          {waitingCount > 0 && (
            <p className="tool-approval-prompt-queue" role="status">
              {waitingCount} more approval {waitingCount === 1 ? "request is" : "requests are"} waiting.
            </p>
          )}

          {decisionError && (
            <p className="tool-approval-error" role="alert">{decisionError}</p>
          )}

          {canDecide ? (
            <div className="tool-approval-prompt-actions" aria-label="Approval decision">
              <button
                type="button"
                className="tool-approval-prompt-action tool-approval-prompt-approve"
                disabled={isSubmitting}
                aria-describedby={summaryId}
                onClick={() => onDecision?.(approval.approvalId, true)}
              >
                {pendingDecisionId === approval.approvalId && pendingDecision === "approve"
                  ? "Approving…"
                  : "Approve"}
              </button>
              <button
                type="button"
                className="tool-approval-prompt-action tool-approval-prompt-reject"
                disabled={isSubmitting}
                aria-describedby={summaryId}
                onClick={() => onDecision?.(approval.approvalId, false)}
              >
                {pendingDecisionId === approval.approvalId && pendingDecision === "reject"
                  ? "Rejecting…"
                  : "Reject"}
              </button>
            </div>
          ) : (
            <p className="tool-approval-prompt-note" role="status">
              {eligibilityReason ??
                (waiting ? "This approval is waiting for an eligible decision." : statusLabel)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
