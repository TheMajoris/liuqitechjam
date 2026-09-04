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
  "orchestration_started",
  "orchestration_stopped",
  "orchestration_continued",
  "orchestration_completed",
  "orchestration_failed",
  "participant_dispatched",
  "supervisor_decision",
  "handoff_applied",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_retried",
  "model_turn",
  "mcp_tool_call",
  "sandbox_started",
  "sandbox_exited",
  "sandbox_command",
  "sandbox_cleanup_failed",
  "workspace_file_change",
  "project_lease_acquired",
  "project_lease_released",
  "approval_decided",
  "mcp_session_issued",
  "mcp_session_rejected",
  "mcp_session_expired",
  "audit_write_failed",
  "telemetry_export_failed",
  "agent_started",
  "agent_stopped",
  "project_role_changed",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditEventStatus = "success" | "failure";
export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export const AUDIT_CATEGORIES = [
  "orchestration",
  "model_call",
  "tool_call",
  "sandbox_execution",
  "workspace",
  "policy_decision",
  "human_approval",
  "session",
  "system",
  "cloud_operation",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_ACTOR_TYPES = ["human", "agent", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Every event type maps to exactly one category; keep in sync with AUDIT_EVENT_TYPES. */
export const AUDIT_EVENT_CATEGORY: Record<AuditEventType, AuditCategory> = {
  orchestration_started: "orchestration",
  orchestration_stopped: "orchestration",
  orchestration_continued: "orchestration",
  orchestration_completed: "orchestration",
  orchestration_failed: "orchestration",
  participant_dispatched: "orchestration",
  supervisor_decision: "orchestration",
  handoff_applied: "orchestration",
  agent_started: "orchestration",
  agent_stopped: "orchestration",
  project_role_changed: "orchestration",
  run_started: "model_call",
  run_completed: "model_call",
  run_failed: "model_call",
  run_cancelled: "model_call",
  run_retried: "model_call",
  model_fallback: "model_call",
  model_turn: "model_call",
  tool_started: "tool_call",
  tool_succeeded: "tool_call",
  tool_failed: "tool_call",
  tool_approval_required: "tool_call",
  mcp_tool_call: "tool_call",
  skill_invoked: "tool_call",
  sandbox_started: "sandbox_execution",
  sandbox_exited: "sandbox_execution",
  sandbox_command: "sandbox_execution",
  sandbox_cleanup_failed: "sandbox_execution",
  workspace_file_change: "workspace",
  project_lease_acquired: "workspace",
  project_lease_released: "workspace",
  authorization_decision: "policy_decision",
  permit_project_access_transition: "policy_decision",
  permit_approval_transition: "human_approval",
  approval_decided: "human_approval",
  mcp_session_issued: "session",
  mcp_session_rejected: "session",
  mcp_session_expired: "session",
  audit_write_failed: "system",
  telemetry_export_failed: "system",
};

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

/** A trace/span identity for correlating events across a distributed flow. */
export interface AuditSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
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
  span?: Partial<AuditSpan>;
  durationMs?: number;
  agentVersion?: string;
  /** Overrides the actor type otherwise derived from principal.kind. */
  actorType?: AuditActorType;
  /** Overrides the category otherwise derived from AUDIT_EVENT_CATEGORY. */
  category?: AuditCategory;
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
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sequence: number;
  actorType: AuditActorType;
  category: AuditCategory;
  durationMs?: number;
  agentVersion?: string;
}

export interface AuditQuery {
  agentId?: string | undefined;
  projectId?: string | undefined;
  runId?: string | undefined;
  type?: AuditEventType | undefined;
  limit?: number | undefined;
  traceId?: string | undefined;
  category?: AuditCategory | undefined;
  actorType?: AuditActorType | undefined;
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
