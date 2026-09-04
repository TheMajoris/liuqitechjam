import { z } from "zod";
import { AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_EVENT_TYPES } from "../audit/audit-types.js";

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
});
