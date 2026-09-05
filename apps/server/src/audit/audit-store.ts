import type { JsonStore } from "../store.js";
import { GENESIS_HASH, hashAuditEvent, type AuditChainAnchor } from "./audit-hash.js";
import type { AuditEvent, HashedAuditEvent } from "./audit-types.js";
import type { AuditRunReader, AuditRunSnapshot } from "./audit-timeline.js";

export const MAX_PERSISTED_AUDIT_EVENTS = 10_000;

/** What a caller supplies; sequence and chain fields belong to the store. */
export type AuditEventDraft = Omit<AuditEvent, "sequence" | "prevHash" | "hash">;

export interface AuditStoreAdapter {
  read(): readonly AuditEvent[];
  /** Assigns sequence and chain fields atomically with the append. */
  append(event: AuditEventDraft): Promise<HashedAuditEvent>;
  anchor(): AuditChainAnchor | null;
}

/** Adapter keeps JSON persistence details outside the audit interface. */
export class JsonAuditStoreAdapter implements AuditStoreAdapter, AuditRunReader {
  constructor(private readonly store: JsonStore) {}

  read(): readonly AuditEvent[] {
    return this.store.snapshot().auditEvents;
  }

  anchor(): AuditChainAnchor | null {
    return this.store.snapshot().auditChainAnchor ?? null;
  }

  async append(event: AuditEventDraft): Promise<HashedAuditEvent> {
    return this.store.mutate((database) => {
      const last = database.auditEvents[database.auditEvents.length - 1];
      const anchor = database.auditChainAnchor ?? null;
      const prevHash = last?.hash ?? anchor?.hash ?? GENESIS_HASH;
      const sequence = (last?.sequence ?? anchor?.sequence ?? 0) + 1;
      const chained: HashedAuditEvent = {
        ...event,
        sequence,
        prevHash,
        hash: hashAuditEvent(prevHash, { ...event, sequence }),
      };
      database.auditEvents.push(chained);

      const overflow = database.auditEvents.length - MAX_PERSISTED_AUDIT_EVENTS;
      if (overflow > 0) {
        const dropped = database.auditEvents.splice(0, overflow);
        // Keep the last dropped event's chain state so verification of the
        // remaining window still has a valid starting point.
        const lastDropped = dropped[dropped.length - 1];
        if (lastDropped !== undefined) {
          database.auditChainAnchor = {
            sequence: lastDropped.sequence,
            hash: lastDropped.hash ?? GENESIS_HASH,
          };
        }
      }
      return chained;
    });
  }

  readRuns(): readonly AuditRunSnapshot[] {
    return this.store.snapshot().runs;
  }
}
