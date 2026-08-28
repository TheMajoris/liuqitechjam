import { randomUUID } from "node:crypto";

import type { JsonStore } from "../../store.js";
import type {
  OrchestrationStage,
  RunUsage,
  SpanKind,
  SpanStatus,
  TelemetryRecord,
} from "../../types.js";
import { redactPreview, redactValue } from "./redactor.js";

/** Maximum redacted preview size persisted per record (2 KiB). */
const MAX_PREVIEW_BYTES = 2048;

/** Hard cap on telemetry records retained per Run. */
const MAX_RECORDS_PER_RUN = 500;

export interface TelemetryDraft {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  projectId?: string;
  orchestrationId?: string;
  runId?: string;
  agentId?: string;
  stage?: OrchestrationStage;
  attempt?: number;
  code?: string;
  /** Raw structured payload; the ledger redacts and caps it before persistence. */
  preview?: unknown;
  usage?: RunUsage;
}

export interface RunObservabilityView {
  runId: string;
  /** Records for this Run, ordered by `(startedAt, sequence)` ascending. */
  spans: TelemetryRecord[];
  /** Token usage summed across `provider.responses` spans. */
  usage: RunUsage;
  counts: { total: number; errors: number; denied: number };
  /** True when the per-Run cap dropped records for this Run. */
  truncated: boolean;
}

export interface TelemetryLedgerDeps {
  store: JsonStore;
  /** Configured secret values, pulled fresh from config on every append. */
  secretValues: () => string[];
  /** Injectable clock; only used as a fallback when a draft omits `startedAt`. */
  now?: () => string;
}

export class TelemetryLedger {
  private readonly store: JsonStore;
  private readonly secretValues: () => string[];
  private readonly now: () => string;

  constructor(deps: TelemetryLedgerDeps) {
    this.store = deps.store;
    this.secretValues = deps.secretValues;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async append(draft: TelemetryDraft): Promise<void> {
    const secretValues = this.secretValues().filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );

    // Redaction happens outside the mutation: it is pure and must never be the
    // path by which a raw lease or secret reaches the store.
    const preview =
      draft.preview === undefined
        ? undefined
        : redactPreview(draft.preview, {
            secretValues,
            maxBytes: MAX_PREVIEW_BYTES,
          });
    const safeName = String(redactValue(draft.name, { secretValues }));
    const safeCode =
      draft.code === undefined
        ? undefined
        : String(redactValue(draft.code, { secretValues }));
    const startedAt = draft.startedAt || this.now();

    await this.store.mutate((database) => {
      const { runId } = draft;

      if (runId !== undefined) {
        let existingForRun = 0;
        for (const record of database.telemetry) {
          if (record.runId === runId) {
            existingForRun += 1;
          }
        }
        if (existingForRun >= MAX_RECORDS_PER_RUN) {
          // Drop silently. `inspectRun` reports `truncated: true` for this Run.
          return;
        }
      }

      let maxSequence = 0;
      for (const record of database.telemetry) {
        if (record.sequence > maxSequence) {
          maxSequence = record.sequence;
        }
      }

      const record: TelemetryRecord = {
        id: randomUUID(),
        traceId: draft.traceId,
        spanId: draft.spanId,
        parentSpanId: draft.parentSpanId ?? null,
        kind: draft.kind,
        name: safeName,
        status: draft.status,
        startedAt,
        endedAt: draft.endedAt ?? null,
        durationMs: draft.durationMs ?? null,
        sequence: maxSequence + 1,
      };

      if (draft.projectId !== undefined) record.projectId = draft.projectId;
      if (draft.orchestrationId !== undefined) {
        record.orchestrationId = draft.orchestrationId;
      }
      if (runId !== undefined) record.runId = runId;
      if (draft.agentId !== undefined) record.agentId = draft.agentId;
      if (draft.stage !== undefined) record.stage = draft.stage;
      if (draft.attempt !== undefined) record.attempt = draft.attempt;
      if (safeCode !== undefined) record.code = safeCode;
      if (preview !== undefined) record.preview = preview;
      if (draft.usage !== undefined) record.usage = draft.usage;

      database.telemetry.push(record);
    });
  }

  async inspectRun(runId: string): Promise<RunObservabilityView> {
    const database = this.store.snapshot();
    const forRun = database.telemetry.filter((record) => record.runId === runId);

    const spans = [...forRun].sort((a, b) => {
      if (a.startedAt < b.startedAt) return -1;
      if (a.startedAt > b.startedAt) return 1;
      return a.sequence - b.sequence;
    });

    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    for (const span of spans) {
      if (span.kind !== "provider.responses" || !span.usage) {
        continue;
      }
      if (typeof span.usage.inputTokens === "number") {
        inputTokens += span.usage.inputTokens;
      }
      if (typeof span.usage.cachedInputTokens === "number") {
        cachedInputTokens += span.usage.cachedInputTokens;
      }
      if (typeof span.usage.outputTokens === "number") {
        outputTokens += span.usage.outputTokens;
      }
    }

    const usage: RunUsage = {};
    if (inputTokens > 0) usage.inputTokens = inputTokens;
    if (cachedInputTokens > 0) usage.cachedInputTokens = cachedInputTokens;
    if (outputTokens > 0) usage.outputTokens = outputTokens;

    let errors = 0;
    let denied = 0;
    for (const span of spans) {
      if (span.status === "error") errors += 1;
      if (span.kind === "security.deny") denied += 1;
    }

    return {
      runId,
      spans,
      usage,
      counts: { total: spans.length, errors, denied },
      truncated: forRun.length >= MAX_RECORDS_PER_RUN,
    };
  }
}
