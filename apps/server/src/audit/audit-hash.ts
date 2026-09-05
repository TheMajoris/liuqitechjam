import { createHash } from "node:crypto";
import type { AuditEvent } from "./audit-types.js";

export const GENESIS_HASH = "0".repeat(64);

export type AuditChainBreakReason =
  | "hash_mismatch"
  | "prev_hash_mismatch"
  | "sequence_gap"
  | "unhashed_legacy";

export interface AuditChainVerification {
  ok: boolean;
  checked: number;
  brokenAtSequence?: number;
  reason?: AuditChainBreakReason;
}

export interface AuditChainAnchor {
  sequence: number;
  hash: string;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (key === "hash" || key === "prevHash") continue;
    if (source[key] === undefined) continue;
    sorted[key] = sortValue(source[key]);
  }
  return sorted;
}

/** Deterministic JSON with recursively sorted keys, excluding the chain fields. */
export function canonicalAuditEvent(event: object): string {
  return JSON.stringify(sortValue(event));
}

export function hashAuditEvent(prevHash: string, event: object): string {
  return createHash("sha256")
    .update(prevHash + canonicalAuditEvent(event))
    .digest("hex");
}

/**
 * Walk stored events in order. Legacy events written before the chain existed
 * carry no hash: they are tolerated and skipped rather than failing the chain,
 * so `checked` counts only hashed events.
 */
export function verifyAuditChain(
  events: readonly AuditEvent[],
  anchor?: string,
): AuditChainVerification {
  let checked = 0;
  let expectedPrevHash = anchor ?? GENESIS_HASH;
  let previousSequence: number | undefined;

  for (const event of events) {
    if (event.hash === undefined || event.prevHash === undefined) continue;

    if (previousSequence !== undefined && event.sequence !== previousSequence + 1) {
      return { ok: false, checked, brokenAtSequence: event.sequence, reason: "sequence_gap" };
    }
    if (event.prevHash !== expectedPrevHash) {
      return {
        ok: false,
        checked,
        brokenAtSequence: event.sequence,
        reason: "prev_hash_mismatch",
      };
    }
    if (hashAuditEvent(event.prevHash, event) !== event.hash) {
      return {
        ok: false,
        checked,
        brokenAtSequence: event.sequence,
        reason: "hash_mismatch",
      };
    }

    checked += 1;
    previousSequence = event.sequence;
    expectedPrevHash = event.hash;
  }

  return { ok: true, checked };
}
