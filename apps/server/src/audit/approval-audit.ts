import {
  agentPrincipal,
  systemPrincipal,
} from "../access/access-types.js";
import type {
  AuditEventInput,
  NativeApprovalAuditEventType,
} from "./audit-types.js";
import {
  NATIVE_APPROVAL_AUDIT_SCHEMA_VERSION,
  NATIVE_APPROVAL_AUDIT_SOURCE,
} from "./audit-types.js";
import type {
  ToolApprovalInvocationRecord,
} from "../tools/tool-approval-store.js";

/**
 * Return the one native approval event represented by a durable transition.
 * The store invokes this only after its conditional write commits, so a
 * duplicate/idempotent call cannot produce a second event.
 */
export function approvalLifecycleEvent(
  previous: ToolApprovalInvocationRecord | null,
  next: ToolApprovalInvocationRecord,
): AuditEventInput | null {
  let type: NativeApprovalAuditEventType | null = null;

  if (previous === null) {
    if (next.status === "requested") type = "approval_requested";
    else if (next.status === "waiting") type = "approval_waiting";
  } else if (previous.status !== next.status) {
    if (previous.status === "requested" && next.status === "waiting") {
      type = "approval_waiting";
    } else if (
      (previous.status === "waiting" &&
        (next.status === "approved" || next.status === "rejected"))
    ) {
      type = "approval_decided";
    } else if (next.status === "resuming") {
      type = "approval_resumed";
    } else if (next.status === "expired") {
      type = "approval_expired";
    } else if (next.status === "cancelled") {
      type = "approval_cancelled";
    } else if (next.status === "revoked") {
      type = "approval_revoked";
    } else if (
      next.status === "failed_pre_execution" ||
      next.status === "failed" ||
      next.status === "uncertain"
    ) {
      type = "approval_failed";
    }
  } else if (
    previous.status === "executing" &&
    next.status === "executing" &&
    previous.cancellationRequestedAt === null &&
    next.cancellationRequestedAt !== null
  ) {
    // Cancellation after the executor has claimed the invocation is still a
    // lifecycle event, but it must not masquerade as a second tool failure.
    type = "approval_cancelled";
  }

  if (type === null) return null;

  // A decision is attributed to the actor that won the durable decision CAS.
  // Every other transition is runtime bookkeeping (waiting, expiry,
  // cancellation, revocation, startup fencing, and execution failures), so
  // attributing it to the Agent would falsely imply that the Agent initiated
  // or caused the lifecycle transition.
  const actor = type === "approval_decided"
    ? next.decisionActor ?? { kind: "system" as const, id: "runtime" }
    : { kind: "system" as const, id: "runtime" };
  const principal = actor.kind === "agent"
    ? agentPrincipal(actor.id)
    : actor.kind === "human"
      ? { kind: "human" as const, id: actor.id }
      : systemPrincipal();
  const metadata: Record<string, string> = {
    status: next.status,
  };
  if (previous !== null) metadata.previousStatus = previous.status;
  if (next.decision !== null) metadata.decision = next.decision;

  const traceId = next.traceRefs.traceId;
  const spanId = next.traceRefs.spanId;
  const parentSpanId = next.traceRefs.parentSpanId;
  return {
    type,
    status: type === "approval_failed" ? "failure" : "success",
    summary: "Native tool approval " + type.slice("approval_".length),
    principal,
    actorType: actor.kind,
    schemaVersion: NATIVE_APPROVAL_AUDIT_SCHEMA_VERSION,
    source: NATIVE_APPROVAL_AUDIT_SOURCE,
    agentId: next.agentId,
    ...(next.projectId === null ? {} : { projectId: next.projectId }),
    runId: next.runId,
    ...(next.orchestrationId === null ? {} : { orchestrationId: next.orchestrationId }),
    ...(next.turnId === null ? {} : { turnId: next.turnId }),
    ...(next.sessionId === null ? {} : { sessionId: next.sessionId }),
    invocationId: next.invocationId,
    approvalId: next.approvalId,
    workflowRunId: next.workflowRunId,
    resource: { kind: "tool", id: next.toolId },
    metadata,
    ...(traceId === undefined
      ? {}
      : {
          span: {
            traceId,
            ...(spanId === undefined ? {} : { spanId }),
            ...(parentSpanId === undefined ? {} : { parentSpanId }),
          },
        }),
  };
}
