import type { PreviewOwnerRef } from "../preview/preview-types.js";

/** The one human identity used by the local/demo control plane. */
export const DEMO_HUMAN_PRINCIPAL = {
  kind: "human",
  id: "demo-owner",
} as const;

export type HumanPrincipal = {
  kind: "human";
  id: "demo-owner";
};

export type AgentPrincipal = {
  kind: "agent";
  id: string;
};

/** A trusted actor. HTTP callers never get to provide this object. */
export type Principal = HumanPrincipal | AgentPrincipal;

export function principalKey(principal: Principal): string {
  return principal.kind + ":" + principal.id;
}

export function agentPrincipal(id: string): AgentPrincipal {
  return { kind: "agent", id };
}

export function humanPrincipal(): HumanPrincipal {
  return DEMO_HUMAN_PRINCIPAL;
}

export type ResourceRef =
  | { kind: "project"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "preview"; owner: PreviewOwnerRef }
  | { kind: "tool"; id: string }
  | { kind: "skill"; id: string };

export type AuthorizationDecision =
  | { result: "allow"; reason: string }
  | { result: "deny"; reason: string; errorCode: "PERMISSION_DENIED" }
  | {
      result: "approval_required";
      reason: string;
      approvalRequestId: string;
    };

export type AuthorizationContext = {
  projectId?: string;
  agentId?: string;
  runId?: string;
  orchestrationId?: string;
  toolId?: string;
};

export interface ApprovalRequest {
  id: string;
  agentId: string;
  projectId?: string;
  /** The run that first requested this approval; used for idempotence/audit. */
  runId?: string;
  toolId: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "revoked";
  reason: string;
  createdAt: string;
  expiresAt: string;
}

export interface CapabilityGrant {
  id: string;
  agentId: string;
  projectId: string;
  toolId: string;
  scope: "once" | "project";
  usesRemaining: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * Permit-owned approval correlation.  This is deliberately only a UX/audit
 * projection: it never contains enough state to authorize a tool call.
 */
export type PermitApprovalKind = "operation_approval" | "access_request";
export type PermitApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed"
  | "revoked"
  | "unknown";

export interface PermitApprovalCorrelation {
  permitRequestId: string;
  kind: PermitApprovalKind;
  agentId: string;
  projectId: string | null;
  runId: string | null;
  toolId: string;
  safeSummary: string;
  lastKnownStatus: PermitApprovalStatus;
  createdAt: string;
  updatedAt: string;
}

/** Kept as a compatibility export for callers that historically imported
 * audit records from the access module. The implementation lives in audit/. */
export type { AuditEvent } from "../audit/audit-types.js";

export type ProjectRole = "owner" | "editor" | "viewer";
