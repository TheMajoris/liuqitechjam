import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExportResultCode } from "@opentelemetry/core";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ConsoleSpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import type { AppConfig } from "../config.js";
import {
  correlationAttributes,
  type RuntimeTelemetry,
  type TelemetryAttributes,
  type TelemetryCarrier,
  type TelemetrySpan,
} from "./telemetry-types.js";

const TRACER_NAME = "launchpad.server";
const MAX_ATTRIBUTE_TEXT = 160;
const MAX_ATTRIBUTE_KEY = 80;

function safeAttributeKey(value: string): string | null {
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value)) return null;
  return value;
}

function safeAttributeValue(value: string | number | boolean): string | number | boolean | null {
  if (typeof value === "string") {
    const bounded = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ATTRIBUTE_TEXT);
    return bounded.length > 0 ? bounded : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}

function safeAttributes(attributes: TelemetryAttributes | undefined): TelemetryAttributes {
  const result: TelemetryAttributes = {};
  if (!attributes) return result;
  for (const [key, value] of Object.entries(attributes)) {
    const safeKey = safeAttributeKey(key);
    const safeValue = safeAttributeValue(value);
    if (safeKey !== null && safeValue !== null) result[safeKey] = safeValue;
  }
  return result;
}

function safeErrorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)
    ? name.slice(0, MAX_ATTRIBUTE_KEY)
    : "Error";
}

class NoopSpan implements TelemetrySpan {
  setAttribute(): void {}
  setAttributes(): void {}
  setStatus(): void {}
  end(): void {}
}

const NOOP_SPAN = new NoopSpan();

class SafeTelemetrySpan implements TelemetrySpan {
  constructor(private readonly span: Span) {}

  setAttribute(name: string, value: string | number | boolean): void {
    try {
      const safeKey = safeAttributeKey(name);
      const safeValue = safeAttributeValue(value);
      if (safeKey !== null && safeValue !== null) this.span.setAttribute(safeKey, safeValue);
    } catch {
      // Observability must never affect the operation being observed.
    }
  }

  setAttributes(attributes: TelemetryAttributes): void {
    try {
      this.span.setAttributes(safeAttributes(attributes));
    } catch {
      // Observability must never affect the operation being observed.
    }
  }

  setStatus(status: "ok" | "error"): void {
    try {
      this.span.setStatus({
        code: status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      });
    } catch {
      // Observability must never affect the operation being observed.
    }
  }

  end(): void {
    try {
      this.span.end();
    } catch {
      // Observability must never affect the operation being observed.
    }
  }
}

/** Wrap exporters so SDK/exporter errors remain outside the business path. */
export class FailSafeSpanExporter implements SpanExporter {
  constructor(private readonly exporter: SpanExporter) {}

  export(spans: ReadableSpan[], callback: (result: { code: ExportResultCode }) => void): void {
    const done = (result: { code: ExportResultCode }) => {
      try {
        callback(result);
      } catch {
        // SDK callbacks are not application work.
      }
    };
    try {
      this.exporter.export(spans, done);
    } catch {
      done({ code: ExportResultCode.FAILED });
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.exporter.shutdown();
    } catch {
      // Exporter shutdown is best effort during process termination.
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.exporter.forceFlush?.();
    } catch {
      // Exporter flush is best effort.
    }
  }
}

class NoopRuntimeTelemetry implements RuntimeTelemetry {
  readonly enabled = false;

  startSpan(): TelemetrySpan {
    return NOOP_SPAN;
  }

  async withSpan<T>(
    _name: string,
    _attributes: TelemetryAttributes,
    operation: (span: TelemetrySpan) => Promise<T> | T,
  ): Promise<T> {
    return operation(NOOP_SPAN);
  }

  inject(): void {}

  extract(): Context {
    return context.active();
  }

  async shutdown(): Promise<void> {}
}

class OtlpRuntimeTelemetry implements RuntimeTelemetry {
  readonly enabled = true;
  private readonly tracer = trace.getTracer(TRACER_NAME);

  constructor(private readonly sdk: NodeSDK) {}

  startSpan(
    name: string,
    attributes: TelemetryAttributes = {},
    parent?: Context,
  ): TelemetrySpan {
    const span = this.createSpan(name, attributes, parent);
    return span === null ? NOOP_SPAN : new SafeTelemetrySpan(span);
  }

  async withSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    operation: (span: TelemetrySpan) => Promise<T> | T,
    parent?: Context,
  ): Promise<T> {
    const rawSpan = this.createSpan(name, attributes, parent);
    const span = rawSpan === null ? NOOP_SPAN : new SafeTelemetrySpan(rawSpan);
    const active = rawSpan === null
      ? parent ?? context.active()
      : trace.setSpan(parent ?? context.active(), rawSpan);
    try {
      return await context.with(active, () => operation(span));
    } catch (error) {
      span.setAttribute("error.type", safeErrorType(error));
      span.setStatus("error");
      throw error;
    } finally {
      span.end();
    }
  }

  private createSpan(
    name: string,
    attributes: TelemetryAttributes,
    parent?: Context,
  ): Span | null {
    try {
      return this.tracer.startSpan(
        name,
        { attributes: safeAttributes(attributes) },
        parent ?? context.active(),
      );
    } catch {
      return null;
    }
  }

  inject(carrier: Record<string, string>): void {
    try {
      propagation.inject(context.active(), carrier, {
        set(target, key, value) {
          if (typeof value === "string" && value.length <= MAX_ATTRIBUTE_TEXT) target[key] = value;
        },
      });
    } catch {
      // A missing trace header must not block a worker or network request.
    }
  }

  extract(carrier: TelemetryCarrier): Context {
    try {
      return propagation.extract(context.active(), carrier, {
        get(target, key) {
          const value = target[key];
          return Array.isArray(value) ? value[0] : value;
        },
        keys(target) {
          return Object.keys(target);
        },
      });
    } catch {
      return context.active();
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.sdk.shutdown();
    } catch {
      // Telemetry shutdown is explicitly fail-open.
    }
  }
}

function exporterFor(config: AppConfig): SpanExporter | null {
  if (config.telemetryExporter === "console") return new ConsoleSpanExporter();
  if (config.telemetryExporter !== "otlp" || !config.telemetryEndpoint) return null;
  return new OTLPTraceExporter({ url: config.telemetryEndpoint });
}

export function createRuntimeTelemetry(config: AppConfig): RuntimeTelemetry {
  let exporter: SpanExporter | null;
  try {
    exporter = exporterFor(config);
  } catch {
    exporter = null;
  }
  if (!exporter) return new NoopRuntimeTelemetry();
  try {
    const sdk = new NodeSDK({
      autoDetectResources: false,
      instrumentations: [],
      serviceName: config.telemetryServiceName,
      traceExporter: new FailSafeSpanExporter(exporter),
    });
    sdk.start();
    return new OtlpRuntimeTelemetry(sdk);
  } catch {
    return new NoopRuntimeTelemetry();
  }
}

export { correlationAttributes };
