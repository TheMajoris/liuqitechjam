import { z } from "zod";
import { AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_EVENT_TYPES } from "../audit/audit-types.js";
import { AUDIT_EXPORT_FORMATS } from "../audit/audit-export.js";
import { TOOL_APPROVAL_STATUSES } from "../tools/tool-approval-store.js";

const isoTimestamp = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");

/** Shared path/query contracts used by multiple HTTP route modules. */
export const agentIdParams = z.object({ id: z.string().uuid() });
export const runIdParams = z.object({ id: z.string().uuid() });

/** Opaque server-issued approval references used by the control-plane routes. */
export const toolApprovalIdParams = z.object({
  approvalId: z.string().trim().min(1).max(256),
});

/**
 * Human decisions are deliberately narrower than the persisted invocation.
 * Identity, scope, binding and workflow references are all server-owned and
 * therefore cannot be supplied by an HTTP caller.
 */
export const toolApprovalDecisionBody = z
  .object({
    expectedVersion: z.number().int().positive().safe(),
    approved: z.boolean(),
    reason: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

/** Bounded filters for the safe approval projection. */
export const toolApprovalListQuery = z.object({
  agentId: z.string().trim().min(1).max(256).optional(),
  projectId: z.string().trim().min(1).max(256).optional(),
  runId: z.string().trim().min(1).max(256).optional(),
  orchestrationId: z.string().trim().min(1).max(256).optional(),
  status: z.enum(TOOL_APPROVAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** Keep audit filtering bounded and limited to server-owned event fields. */
export const auditQuery = z.object({
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  turnId: z.string().trim().min(1).max(256).optional(),
  sessionId: z.string().trim().min(1).max(256).optional(),
  invocationId: z.string().trim().min(1).max(256).optional(),
  approvalId: z.string().trim().min(1).max(256).optional(),
  workflowRunId: z.string().trim().min(1).max(256).optional(),
  type: z.enum(AUDIT_EVENT_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  traceId: z.string().min(1).max(64).optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  since: isoTimestamp.optional(),
  until: isoTimestamp.optional(),
});

/** Trace listing is a bounded rollup over the same server-owned fields. */
export const auditTraceListQuery = z.object({
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  status: z.enum(["success", "failure"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const auditTraceIdParams = z.object({ traceId: z.string().min(1).max(64) });

/**
 * Historical Run listing.
 *
 * The Agent filter is deliberately not validated against the live Agent
 * directory: a deleted Agent's Runs must remain listable by its ID.
 */
export const runHistoryQuery = z.object({
  agentId: z.string().uuid().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Export reuses the audit filters but chooses a serialization format. */
export const auditExportQuery = z.object({
  format: z.enum(AUDIT_EXPORT_FORMATS).default("jsonl"),
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  turnId: z.string().trim().min(1).max(256).optional(),
  sessionId: z.string().trim().min(1).max(256).optional(),
  invocationId: z.string().trim().min(1).max(256).optional(),
  approvalId: z.string().trim().min(1).max(256).optional(),
  workflowRunId: z.string().trim().min(1).max(256).optional(),
  traceId: z.string().min(1).max(64).optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  since: isoTimestamp.optional(),
  until: isoTimestamp.optional(),
});
