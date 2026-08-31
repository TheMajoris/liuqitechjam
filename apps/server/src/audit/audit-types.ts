import type { Principal, ResourceRef } from "../access/access-types.js";

export const AUDIT_EVENT_TYPES = [
  "authorization_decision",
  "permit_approval_transition",
  "permit_project_access_transition",
  "tool_started",
  "tool_succeeded",
  "tool_failed",
  "tool_approval_required",
  "skill_invoked",
  "model_fallback",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditEventStatus = "success" | "failure";
export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

/** Correlation identifiers are facts supplied by trusted server modules. */
export interface AuditCorrelation {
  agentId?: string;
  projectId?: string;
  runId?: string;
  orchestrationId?: string;
  permitRequestId?: string;
  approvalRequestId?: string;
  grantId?: string;
}

/** Input accepted only by server-owned modules, never by an HTTP route. */
export interface AuditEventInput extends AuditCorrelation {
  type: AuditEventType;
  status: AuditEventStatus;
  summary: string;
  principal: Principal;
  permission?: string;
  resource?: ResourceRef;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Persisted safe evidence. It contains no prompt, output, secret, or body. */
export interface AuditEvent extends AuditCorrelation {
  id: string;
  type: AuditEventType;
  status: AuditEventStatus;
  summary: string;
  createdAt: string;
  principal: Principal;
  permission?: string;
  resource?: ResourceRef;
  metadata: AuditMetadata;
}

export interface AuditQuery {
  agentId?: string | undefined;
  projectId?: string | undefined;
  runId?: string | undefined;
  type?: AuditEventType | undefined;
  limit?: number | undefined;
}

/** Small seam used by authorization, tool, skill, and approval modules. */
export interface AuditRecorder {
  record(input: AuditEventInput): Promise<AuditEvent>;
}

export interface AuditReader {
  query(filter?: AuditQuery): AuditEvent[];
  /** Optional normalized runtime projection; event queries remain compatible. */
  queryTimeline?: (filter?: AuditQuery) => import("./audit-timeline.js").AuditTimeline;
}
