import { z } from "zod";
import { AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_EVENT_TYPES } from "../audit/audit-types.js";
import { AUDIT_EXPORT_FORMATS } from "../audit/audit-export.js";

const isoTimestamp = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");

/** Shared path/query contracts used by multiple HTTP route modules. */
export const agentIdParams = z.object({ id: z.string().uuid() });
export const runIdParams = z.object({ id: z.string().uuid() });

/** Keep audit filtering bounded and limited to server-owned event fields. */
export const auditQuery = z.object({
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
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

/** Export reuses the audit filters but chooses a serialization format. */
export const auditExportQuery = z.object({
  format: z.enum(AUDIT_EXPORT_FORMATS).default("jsonl"),
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  traceId: z.string().min(1).max(64).optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  since: isoTimestamp.optional(),
  until: isoTimestamp.optional(),
});
