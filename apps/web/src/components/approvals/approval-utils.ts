import type {
  ToolApproval,
  ToolApprovalStatus,
} from "../../types";

/** States that still represent a live approval/workflow invocation. */
export const ACTIVE_APPROVAL_STATUSES: readonly ToolApprovalStatus[] = [
  "requested",
  "waiting",
  "approved",
  "resuming",
  "executing",
];

export const TERMINAL_APPROVAL_STATUSES: readonly ToolApprovalStatus[] = [
  "succeeded",
  "rejected",
  "failed_pre_execution",
  "failed",
  "expired",
  "cancelled",
  "revoked",
  "uncertain",
];

const STATUS_LABELS: Record<ToolApprovalStatus, string> = {
  requested: "Requested",
  waiting: "Waiting for approval",
  approved: "Approved — resuming",
  resuming: "Resuming",
  executing: "Executing",
  succeeded: "Succeeded",
  rejected: "Rejected",
  failed_pre_execution: "Failed before execution",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Cancelled",
  revoked: "Revoked",
  uncertain: "Outcome uncertain",
};

const TOOL_LABELS: Record<string, string> = {
  "project.preview.restart": "Restart project preview",
  "project.preview.start": "Start project preview",
  "project.preview.stop": "Stop project preview",
};

export function approvalStatusLabel(status: ToolApprovalStatus): string {
  return STATUS_LABELS[status];
}

export function toolApprovalLabel(toolId: string): string {
  const known = TOOL_LABELS[toolId];
  if (known) return known;
  const normalized = toolId
    .replace(/[_-]+/g, " ")
    .replace(/\.+/g, " · ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
  return normalized || "Protected tool action";
}

export function shortApprovalId(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 10 ? trimmed.slice(0, 8) : trimmed || "—";
}

export function isTerminalApprovalStatus(status: ToolApprovalStatus): boolean {
  return TERMINAL_APPROVAL_STATUSES.includes(status);
}

export function isActiveApprovalStatus(status: ToolApprovalStatus): boolean {
  return ACTIVE_APPROVAL_STATUSES.includes(status);
}

/**
 * Expiry is derived only for presentation. The server remains the authority
 * and the next poll reconciles the durable status; this never extends a
 * deadline or authorizes a decision locally.
 */
export function displayApprovalStatus(
  approval: Pick<ToolApproval, "status" | "deadlineAt">,
  now = Date.now(),
): ToolApprovalStatus {
  if (
    (approval.status === "requested" || approval.status === "waiting") &&
    Number.isFinite(Date.parse(approval.deadlineAt)) &&
    now >= Date.parse(approval.deadlineAt)
  ) {
    return "expired";
  }
  return approval.status;
}

/**
 * The server is the authority for eligibility. Older approval DTOs may omit
 * the projection while the rollout is in progress; fail closed in that case
 * instead of treating visibility as permission to decide.
 */
export function approvalDecisionAllowed(
  approval: ToolApproval,
  now = Date.now(),
): boolean {
  const status = displayApprovalStatus(approval, now);
  if (status !== "requested" && status !== "waiting") return false;
  if (approval.decision !== null) return false;
  if (approval.decisionEligible !== undefined) return approval.decisionEligible;
  if (approval.canDecide !== undefined) return approval.canDecide;
  if (approval.eligible !== undefined) return approval.eligible;
  if (approval.eligibility !== undefined && approval.eligibility !== null) {
    return approval.eligibility.allowed;
  }
  return false;
}

export function approvalEligibilityReason(approval: ToolApproval): string | null {
  if (approval.eligibility && !approval.eligibility.allowed) {
    return approval.eligibility.reason?.trim() || "You are not eligible to decide this approval.";
  }
  if (approval.decisionEligible === false || approval.canDecide === false || approval.eligible === false) {
    return "You are not eligible to decide this approval.";
  }
  if (
    (approval.status === "requested" || approval.status === "waiting") &&
    approval.decision === null &&
    approval.decisionEligible === undefined &&
    approval.canDecide === undefined &&
    approval.eligible === undefined &&
    (approval.eligibility === undefined || approval.eligibility === null)
  ) {
    return "Decision eligibility is unavailable.";
  }
  return null;
}

export function boundedApprovalSummary(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  if (!compact) return "The Agent requested a protected tool action.";
  if (compact.length <= 280) return compact;
  const cut = compact.slice(0, 279).trimEnd();
  const boundary = cut.lastIndexOf(" ");
  return (boundary >= 160 ? cut.slice(0, boundary) : cut) + "…";
}

export function formatApprovalDeadline(deadlineAt: string): string {
  const parsed = Date.parse(deadlineAt);
  if (!Number.isFinite(parsed)) return "Deadline unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(parsed));
}

export function mergeToolApprovals(
  current: readonly ToolApproval[],
  incoming: readonly ToolApproval[],
): ToolApproval[] {
  const byId = new Map<string, ToolApproval>();
  for (const approval of current) {
    if (approval.approvalId) byId.set(approval.approvalId, approval);
  }
  for (const approval of incoming) {
    if (!approval.approvalId) continue;
    const previous = byId.get(approval.approvalId);
    if (!previous || approval.version > previous.version) {
      byId.set(approval.approvalId, approval);
      continue;
    }
    if (approval.version === previous.version) {
      const nextUpdated = Date.parse(approval.updatedAt);
      const previousUpdated = Date.parse(previous.updatedAt);
      if (
        !Number.isFinite(previousUpdated) ||
        (Number.isFinite(nextUpdated) && nextUpdated >= previousUpdated)
      ) {
        byId.set(approval.approvalId, approval);
      }
    }
  }
  return [...byId.values()].sort((left, right) => {
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    return updated || right.approvalId.localeCompare(left.approvalId);
  });
}
