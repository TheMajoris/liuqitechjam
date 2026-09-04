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
import { queryAuditEvents } from "./audit-query.js";
import { normalizeAuditEvent } from "./audit-normalize.js";
import { newSpanId, newTraceId } from "./audit-span.js";
import type { AuditStoreAdapter } from "./audit-store.js";
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
    const existing = this.store.read();
    const lastSequence = existing.length === 0 ? 0 : (existing[existing.length - 1]?.sequence ?? existing.length);
    const event: AuditEvent = {
      id: randomUUID(),
      ...rest,
      spanId: span?.spanId ?? newSpanId(),
      traceId: span?.traceId ?? input.orchestrationId ?? input.runId ?? newTraceId(),
      ...(span?.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
      sequence: lastSequence + 1,
      actorType: safe.actorType ?? safe.principal.kind,
      category: safe.category ?? AUDIT_EVENT_CATEGORY[safe.type],
      createdAt: new Date().toISOString(),
    };
    await this.store.append(event);
    return structuredClone(event);
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
export { MAX_AUDIT_QUERY_LIMIT, queryAuditEvents } from "./audit-query.js";
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
  type AuditStoreAdapter,
} from "./audit-store.js";
