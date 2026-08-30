import { redactSensitiveText } from "../orchestration/handoff.js";
import type {
  PermitApprovalCorrelation,
  PermitApprovalRequest,
  PermitApprovalRecord,
  PermitApprovalStatus,
  PermitExternalApproval,
} from "./permit-approval-types.js";
import { PermitApprovalError } from "./permit-approval-types.js";
import { permitResourceKey, permitUserKey } from "./permit-policy.js";

export const MAX_ID_LENGTH = 256;
export const MAX_SUMMARY_LENGTH = 512;
export const MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_PAGE_SIZE = 100;
export const HUMAN_OWNER_ID = "human:demo-owner";

export function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !/[\0\r\n\\/]/.test(value)
  );
}

export function safeId(value: string): string {
  if (!validId(value)) throw new PermitApprovalError("Invalid approval identity", 422);
  return value;
}

export function safeSummary(value: string | undefined, fallback: string): string {
  const redacted = redactSensitiveText(value?.trim() || fallback).trim();
  if (redacted.length <= MAX_SUMMARY_LENGTH) return redacted;
  return redacted.slice(0, MAX_SUMMARY_LENGTH - 14).trimEnd() + " [TRUNCATED]";
}

export function statusFromExternal(value: unknown): PermitApprovalStatus {
  if (value === null || value === undefined || value === "" || value === "pending") {
    return "pending";
  }
  if (typeof value !== "string") return "unknown";
  switch (value.toLowerCase()) {
    case "approved":
    case "approve":
      return "approved";
    case "denied":
    case "deny":
    case "rejected":
      return "denied";
    case "expired":
      return "expired";
    case "consumed":
      return "consumed";
    case "revoked":
    case "cancel":
    case "cancelled":
      return "revoked";
    default:
      return "unknown";
  }
}

/**
 * Permit keeps an approval `approved` after the application removes its
 * temporary role. Preserve local terminal projections for UX only; callers
 * must not use them as authorization inputs.
 */
export function projectedStatus(
  correlation: PermitApprovalCorrelation,
  external: PermitApprovalStatus,
): PermitApprovalStatus {
  if (correlation.lastKnownStatus === "consumed" || correlation.lastKnownStatus === "revoked") {
    return correlation.lastKnownStatus;
  }
  return external;
}

export function validDate(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

export function externalApproval(value: unknown, fallbackId?: string): PermitExternalApproval {
  if (!value || typeof value !== "object") throw new PermitApprovalError();
  const record = value as Record<string, unknown>;
  const idValue = record.id ?? record.request_id ?? record.approval_id ??
    record.operation_approval_id ?? record.access_request_id ?? fallbackId;
  if (!validId(idValue)) throw new PermitApprovalError();
  const now = new Date().toISOString();
  return {
    id: idValue,
    status: statusFromExternal(record.status),
    createdAt: validDate(record.created_at ?? record.createdAt, now),
    updatedAt: validDate(record.updated_at ?? record.updatedAt, now),
  };
}

export function correlationKey(input: {
  kind: PermitApprovalCorrelation["kind"];
  agentId: string;
  projectId: string | null;
  runId: string | null;
  toolId: string;
}): string {
  return [input.kind, input.agentId, input.projectId ?? "", input.runId ?? "", input.toolId].join("\u0000");
}

export function correlationToRecord(
  correlation: PermitApprovalCorrelation,
  status = correlation.lastKnownStatus,
): PermitApprovalRecord {
  return {
    id: correlation.permitRequestId,
    kind: correlation.kind,
    scope: correlation.kind === "access_request" ? "project" : "once",
    agentId: correlation.agentId,
    projectId: correlation.projectId,
    runId: correlation.runId,
    toolId: correlation.toolId,
    safeSummary: correlation.safeSummary,
    status,
    createdAt: correlation.createdAt,
    updatedAt: correlation.updatedAt,
  };
}

export function requestDetails(input: PermitApprovalRequest, tenantKey: string): {
  userId: string;
  tenantId: string;
  resource: string;
  resourceInstance: string;
  reason: string;
} {
  const agentId = safeId(input.agentId);
  const toolId = safeId(input.toolId);
  const projectId = input.projectId === undefined ? undefined : safeId(input.projectId);
  const runId = input.runId === undefined ? undefined : safeId(input.runId);
  const resource = projectId === undefined ? "tool" : "project";
  const resourceInstance = projectId === undefined
    ? permitResourceKey("tool", toolId)
    : permitResourceKey("project", projectId);
  return {
    userId: permitUserKey({ kind: "agent", id: agentId }),
    tenantId: safeId(tenantKey),
    resource,
    resourceInstance,
    reason: safeSummary(
      input.safeSummary,
      "Agent " + agentId + " requested approval for " + toolId +
        (projectId === undefined ? "" : " in Project " + projectId) +
        (runId === undefined ? "" : " (run " + runId + ")"),
    ),
  };
}

export function defaultProjectAccessRole(toolId: string): string {
  const normalized = safeId(toolId).replace(/[^A-Za-z0-9_.-]/g, "_");
  return "tool.execute." + normalized;
}
