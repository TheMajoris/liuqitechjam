import type { Storage } from "../store.js";
import { GENESIS_HASH, hashAuditEvent, type AuditChainAnchor } from "./audit-hash.js";
import { normalizeAuditEvent } from "./audit-normalize.js";
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

/**
 * Storage-backed adapter for the application audit contract.
 *
 * The adapter deliberately owns the chain mechanics while `Storage` owns the
 * durable backend. That lets JSON and PostgreSQL share the same redaction,
 * hashing, verification, and trace semantics.
 */
export class StorageAuditStoreAdapter implements AuditStoreAdapter, AuditRunReader {
  constructor(protected readonly store: Storage) {}

  read(): readonly AuditEvent[] {
    return this.store.snapshot().auditEvents;
  }

  anchor(): AuditChainAnchor | null {
    return this.store.snapshot().auditChainAnchor ?? null;
  }

  async append(event: AuditEventDraft): Promise<HashedAuditEvent> {
    return this.store.mutate((database) => {
      const last = database.auditEvents[database.auditEvents.length - 1];
      const normalizedLast = last === undefined
        ? undefined
        : normalizeAuditEvent(last, database.auditEvents.length - 1);
      const anchor = database.auditChainAnchor ?? null;
      const prevHash = last?.hash ?? anchor?.hash ?? GENESIS_HASH;
      // Preserve the legacy precedence: an anchor describes rows trimmed from
      // the front of a bounded log, so it remains the sequence base whenever
      // the current tail itself predates persisted sequence fields.
      const sequence = (last?.sequence ?? anchor?.sequence ?? normalizedLast?.sequence ?? 0) + 1;
      const chained: HashedAuditEvent = {
        ...event,
        sequence,
        prevHash,
        hash: hashAuditEvent(prevHash, { ...event, sequence }),
      };
      database.auditEvents.push(chained);

      const overflow = database.auditEvents.length - MAX_PERSISTED_AUDIT_EVENTS;
      if (this.store.auditRetention !== "append-only" && overflow > 0) {
        const dropped = database.auditEvents.splice(0, overflow);
        // Keep the last dropped event's chain state so verification of the
        // remaining window still has a valid starting point.
        const lastDropped = dropped[dropped.length - 1];
        if (lastDropped !== undefined) {
          const droppedSequence = lastDropped.sequence === undefined
            ? normalizeAuditEvent(lastDropped, overflow - 1).sequence
            : lastDropped.sequence;
          database.auditChainAnchor = {
            sequence: droppedSequence,
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

/**
 * Backwards-compatible name for callers and tests that explicitly use the
 * legacy JSON adapter. The implementation is backend-neutral.
 */
export class JsonAuditStoreAdapter extends StorageAuditStoreAdapter {}
