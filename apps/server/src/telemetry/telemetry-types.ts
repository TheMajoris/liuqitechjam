import type { Context } from "@opentelemetry/api";

/** Attributes accepted by the runtime telemetry boundary. */
export type TelemetryAttributes = Record<string, string | number | boolean>;

/** W3C propagation carrier accepted at process and HTTP seams. */
export type TelemetryCarrier = Record<string, string | string[] | undefined>;

export interface TelemetrySpan {
  setAttribute(name: string, value: string | number | boolean): void;
  setAttributes(attributes: TelemetryAttributes): void;
  setStatus(status: "ok" | "error"): void;
  end(): void;
}

/**
 * Small application-owned observability seam. The rest of the server does not
 * depend on an exporter, SDK provider, or vendor-specific client.
 */
export interface RuntimeTelemetry {
  readonly enabled: boolean;
  startSpan(
    name: string,
    attributes?: TelemetryAttributes,
    parent?: Context,
  ): TelemetrySpan;
  withSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    operation: (span: TelemetrySpan) => Promise<T> | T,
    parent?: Context,
  ): Promise<T>;
  inject(carrier: Record<string, string>): void;
  extract(carrier: TelemetryCarrier): Context;
  shutdown(): Promise<void>;
}

export interface CorrelationIds {
  principalKind?: "human" | "agent" | "system" | undefined;
  principalId?: string | undefined;
  agentId?: string | undefined;
  projectId?: string | undefined;
  runId?: string | undefined;
  orchestrationId?: string | undefined;
  turnId?: string | undefined;
  sessionId?: string | undefined;
  invocationId?: string | undefined;
  approvalId?: string | undefined;
  workflowRunId?: string | undefined;
}

export const MAX_CORRELATION_ID_LENGTH = 160;

function safeCorrelationId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  if (normalized.length === 0 || normalized.length > MAX_CORRELATION_ID_LENGTH) return undefined;
  return normalized;
}

/** Convert trusted server correlation IDs into bounded span attributes. */
export function correlationAttributes(
  ids: CorrelationIds,
): TelemetryAttributes {
  const attributes: TelemetryAttributes = {};
  const principalId = safeCorrelationId(ids.principalId);
  const agentId = safeCorrelationId(ids.agentId);
  const projectId = safeCorrelationId(ids.projectId);
  const runId = safeCorrelationId(ids.runId);
  const orchestrationId = safeCorrelationId(ids.orchestrationId);
  const turnId = safeCorrelationId(ids.turnId);
  const sessionId = safeCorrelationId(ids.sessionId);
  const invocationId = safeCorrelationId(ids.invocationId);
  const approvalId = safeCorrelationId(ids.approvalId);
  const workflowRunId = safeCorrelationId(ids.workflowRunId);
  if (ids.principalKind !== undefined) attributes["principal.kind"] = ids.principalKind;
  if (principalId !== undefined) attributes["principal.id"] = principalId;
  if (agentId !== undefined) attributes["agent.id"] = agentId;
  if (projectId !== undefined) attributes["project.id"] = projectId;
  if (runId !== undefined) attributes["run.id"] = runId;
  if (orchestrationId !== undefined) attributes["orchestration.id"] = orchestrationId;
  if (turnId !== undefined) attributes["turn.id"] = turnId;
  if (sessionId !== undefined) attributes["session.id"] = sessionId;
  if (invocationId !== undefined) attributes["invocation.id"] = invocationId;
  if (approvalId !== undefined) attributes["approval.id"] = approvalId;
  if (workflowRunId !== undefined) attributes["workflow.run.id"] = workflowRunId;
  return attributes;
}
