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
  principalKind?: "human" | "agent" | undefined;
  principalId?: string | undefined;
  agentId?: string | undefined;
  projectId?: string | undefined;
  runId?: string | undefined;
  orchestrationId?: string | undefined;
  permitRequestId?: string | undefined;
}

/** Convert trusted server correlation IDs into bounded span attributes. */
export function correlationAttributes(
  ids: CorrelationIds,
): TelemetryAttributes {
  const attributes: TelemetryAttributes = {};
  if (ids.principalKind !== undefined) attributes["principal.kind"] = ids.principalKind;
  if (ids.principalId !== undefined) attributes["principal.id"] = ids.principalId;
  if (ids.agentId !== undefined) attributes["agent.id"] = ids.agentId;
  if (ids.projectId !== undefined) attributes["project.id"] = ids.projectId;
  if (ids.runId !== undefined) attributes["run.id"] = ids.runId;
  if (ids.orchestrationId !== undefined) {
    attributes["orchestration.id"] = ids.orchestrationId;
  }
  if (ids.permitRequestId !== undefined) {
    attributes["permit.request_id"] = ids.permitRequestId;
  }
  return attributes;
}
