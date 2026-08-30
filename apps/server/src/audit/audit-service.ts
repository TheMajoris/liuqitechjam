import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuditEventInput,
  AuditQuery,
  AuditReader,
  AuditRecorder,
} from "./audit-types.js";
import { safeAuditInput } from "./audit-redaction.js";
import { queryAuditEvents } from "./audit-query.js";
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
    const event: AuditEvent = {
      id: randomUUID(),
      ...safe,
      createdAt: new Date().toISOString(),
    };
    await this.store.append(event);
    return structuredClone(event);
  }

  query(filter: AuditQuery = {}): AuditEvent[] {
    return queryAuditEvents(this.store.read(), filter);
  }

  queryTimeline(filter: AuditTimelineQuery = {}): AuditTimeline {
    return queryAuditTimeline(
      this.store.read(),
      this.runtime?.readRuns() ?? [],
      filter,
    );
  }
}

export type {
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
} from "./audit-types.js";
export { AUDIT_EVENT_TYPES } from "./audit-types.js";
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
