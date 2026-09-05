import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuditEventInput,
  AuditQuery,
  AuditReader,
  AuditRecorder,
} from "./audit-types.js";
import { AUDIT_EVENT_CATEGORY } from "./audit-types.js";
import { safeAuditInput } from "./audit-redaction.js";
import { queryAuditEvents, queryAuditEventsForExport } from "./audit-query.js";
import {
  exportAuditEvents,
  type AuditExportFormat,
} from "./audit-export.js";
import { normalizeAuditEvent } from "./audit-normalize.js";
import { newSpanId, newTraceId } from "./audit-span.js";
import type { AuditEventDraft, AuditStoreAdapter } from "./audit-store.js";
import { verifyAuditChain, type AuditChainVerification } from "./audit-hash.js";
import {
  buildTraceTree,
  listTraces,
  type AuditTrace,
  type AuditTraceListQuery,
  type AuditTraceSummary,
} from "./audit-trace.js";
import {
  queryAuditTimeline,
  type AuditRunReader,
  type AuditTimeline,
  type AuditTimelineQuery,
} from "./audit-timeline.js";

/** Deep server-owned audit module with one write seam and one query seam. */
export class AuditService implements AuditRecorder, AuditReader {
  constructor(
    private readonly store: AuditStoreAdapter,
    private readonly runtime?: AuditRunReader,
  ) {}

  async record(input: AuditEventInput): Promise<AuditEvent> {
    const safe = safeAuditInput(input);
    const { span, ...rest } = safe;
    const draft: AuditEventDraft = {
      id: randomUUID(),
      ...rest,
      spanId: span?.spanId ?? newSpanId(),
      traceId: span?.traceId ?? input.orchestrationId ?? input.runId ?? newTraceId(),
      ...(span?.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
      actorType: safe.actorType ?? safe.principal.kind,
      category: safe.category ?? AUDIT_EVENT_CATEGORY[safe.type],
      createdAt: new Date().toISOString(),
    };
    try {
      const event = await this.store.append(draft);
      return structuredClone(event);
    } catch (error) {
      // Evidence must fail loudly; callers decide whether to swallow.
      console.error("audit write failed", draft.type);
      throw error;
    }
  }

  verify(): AuditChainVerification {
    return verifyAuditChain(this.store.read(), this.store.anchor()?.hash);
  }

  trace(traceId: string): AuditTrace | null {
    const events = this.readNormalized().filter((event) => event.traceId === traceId);
    return events.length === 0 ? null : buildTraceTree(events, traceId);
  }

  traces(filter: AuditTraceListQuery = {}): AuditTraceSummary[] {
    return listTraces(this.readNormalized(), filter);
  }

  /** A run belonging to an orchestration resolves to the orchestration trace. */
  runTrace(runId: string): AuditTrace | null {
    const traceId = this.readNormalized().find((event) => event.runId === runId)?.traceId;
    return traceId === undefined ? null : this.trace(traceId);
  }

  export(filter: AuditQuery = {}, format: AuditExportFormat = "jsonl"): string {
    return exportAuditEvents(
      queryAuditEventsForExport(this.readNormalized(), filter),
      format,
    );
  }

  private readNormalized(): AuditEvent[] {
    return this.store.read().map(normalizeAuditEvent);
  }

  query(filter: AuditQuery = {}): AuditEvent[] {
    return queryAuditEvents(this.store.read().map(normalizeAuditEvent), filter);
  }

  queryTimeline(filter: AuditTimelineQuery = {}): AuditTimeline {
    return queryAuditTimeline(
      this.store.read().map(normalizeAuditEvent),
      this.runtime?.readRuns() ?? [],
      filter,
    );
  }
}

export type {
  AuditActorType,
  AuditCategory,
  AuditCorrelation,
  AuditEvent,
  AuditEventInput,
  AuditEventStatus,
  AuditEventType,
  AuditMetadata,
  HashedAuditEvent,
  AuditMetadataValue,
  AuditQuery,
  AuditReader,
  AuditRecorder,
  AuditSpan,
} from "./audit-types.js";
export {
  AUDIT_ACTOR_TYPES,
  AUDIT_CATEGORIES,
  AUDIT_EVENT_CATEGORY,
  AUDIT_EVENT_TYPES,
} from "./audit-types.js";
export {
  MAX_AUDIT_ID_LENGTH,
  MAX_AUDIT_METADATA_KEYS,
  MAX_AUDIT_METADATA_VALUE_LENGTH,
  MAX_AUDIT_SUMMARY_LENGTH,
  safeAuditIdentifier,
  safeAuditInput,
  safeAuditMetadata,
  safeAuditSummary,
} from "./audit-redaction.js";
export { normalizeAuditEvent } from "./audit-normalize.js";
export { newSpanId, newTraceId } from "./audit-span.js";
export {
  MAX_AUDIT_QUERY_LIMIT,
  queryAuditEvents,
  queryAuditEventsForExport,
} from "./audit-query.js";
export {
  AUDIT_CSV_COLUMNS,
  AUDIT_EXPORT_FORMATS,
  auditExportContentType,
  auditExportFilename,
  exportAuditEvents,
  type AuditExportFormat,
} from "./audit-export.js";
export {
  buildTraceTree,
  listTraces,
  DEFAULT_AUDIT_TRACE_LIST_LIMIT,
  MAX_AUDIT_TRACE_LIST_LIMIT,
  type AuditTrace,
  type AuditTraceFailingStep,
  type AuditTraceListQuery,
  type AuditTraceNode,
  type AuditTraceSummary,
} from "./audit-trace.js";
export {
  queryAuditTimeline,
  type AuditRunReader,
  type AuditRunSnapshot,
  type AuditTimeline,
  type AuditTimelineQuery,
  type AuditTimelineSummary,
} from "./audit-timeline.js";
export {
  JsonAuditStoreAdapter,
  MAX_PERSISTED_AUDIT_EVENTS,
  type AuditEventDraft,
  type AuditStoreAdapter,
} from "./audit-store.js";
export {
  canonicalAuditEvent,
  GENESIS_HASH,
  hashAuditEvent,
  verifyAuditChain,
  type AuditChainAnchor,
  type AuditChainBreakReason,
  type AuditChainVerification,
} from "./audit-hash.js";
