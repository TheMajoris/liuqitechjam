import type { JsonStore } from "../store.js";
import type { AuditEvent } from "./audit-types.js";
import type { AuditRunReader, AuditRunSnapshot } from "./audit-timeline.js";

export const MAX_PERSISTED_AUDIT_EVENTS = 10_000;

export interface AuditStoreAdapter {
  read(): readonly AuditEvent[];
  append(event: AuditEvent): Promise<void>;
}

/** Adapter keeps JSON persistence details outside the audit interface. */
export class JsonAuditStoreAdapter implements AuditStoreAdapter, AuditRunReader {
  constructor(private readonly store: JsonStore) {}

  read(): readonly AuditEvent[] {
    return this.store.snapshot().auditEvents;
  }

  async append(event: AuditEvent): Promise<void> {
    await this.store.mutate((database) => {
      database.auditEvents.push(event);
      if (database.auditEvents.length > MAX_PERSISTED_AUDIT_EVENTS) {
        database.auditEvents.splice(
          0,
          database.auditEvents.length - MAX_PERSISTED_AUDIT_EVENTS,
        );
      }
    });
  }

  readRuns(): readonly AuditRunSnapshot[] {
    return this.store.snapshot().runs;
  }
}
