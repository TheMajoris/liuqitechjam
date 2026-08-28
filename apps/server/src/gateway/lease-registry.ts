import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * In-memory, hash-only lease registry.
 *
 * A lease is an opaque bearer token issued to a single Run. Only the
 * SHA-256 hash of the token is retained, alongside its scope metadata. The raw
 * token is returned exactly once, from `issue`, and never logged, persisted, or
 * exposed by any other accessor.
 */

export type LeaseScopeName = "responses:create";

export type LeaseDenialCode =
  | "LEASE_INVALID"
  | "LEASE_EXPIRED"
  | "LEASE_REVOKED"
  | "LEASE_SCOPE_MISMATCH";

export interface LeaseInput {
  runId: string;
  agentId: string;
  providerId: string;
  model: string;
  scope: LeaseScopeName;
  projectId?: string;
  orchestrationId?: string;
  ttlSeconds?: number;
}

export interface Lease {
  leaseId: string;
  runId: string;
  agentId: string;
  providerId: string;
  model: string;
  scope: LeaseScopeName;
  projectId?: string;
  orchestrationId?: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
}

export interface IssuedLease {
  leaseId: string;
  token: string;
  expiresAt: string;
}

export type LeaseValidation =
  | { ok: true; lease: Lease }
  | { ok: false; code: LeaseDenialCode };

export const LEASE_TOKEN_PREFIX = "glease_";
const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 3600;
const MIN_TOKEN_LENGTH = LEASE_TOKEN_PREFIX.length + 20;

interface StoredLease {
  hash: string;
  expiresAtMs: number;
  meta: Lease;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export class LeaseRegistry {
  private readonly byHash = new Map<string, StoredLease>();
  private readonly byId = new Map<string, StoredLease>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(input: LeaseInput): IssuedLease {
    const requestedTtl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const ttlSeconds = Math.min(
      Math.max(Math.floor(requestedTtl), 1),
      MAX_TTL_SECONDS,
    );
    const nowMs = this.now();
    const expiresAtMs = nowMs + ttlSeconds * 1000;

    const leaseId = randomUUID();
    const token = LEASE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const hash = sha256Hex(token);

    const meta: Lease = {
      leaseId,
      runId: input.runId,
      agentId: input.agentId,
      providerId: input.providerId,
      model: input.model,
      scope: input.scope,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      revoked: false,
    };
    if (input.projectId !== undefined) {
      meta.projectId = input.projectId;
    }
    if (input.orchestrationId !== undefined) {
      meta.orchestrationId = input.orchestrationId;
    }

    const stored: StoredLease = { hash, expiresAtMs, meta };
    this.byHash.set(hash, stored);
    this.byId.set(leaseId, stored);

    return { leaseId, token, expiresAt: meta.expiresAt };
  }

  validate(
    token: string,
    want: { providerId: string; model: string },
  ): LeaseValidation {
    if (
      typeof token !== "string" ||
      !token.startsWith(LEASE_TOKEN_PREFIX) ||
      token.length < MIN_TOKEN_LENGTH
    ) {
      return { ok: false, code: "LEASE_INVALID" };
    }

    const stored = this.byHash.get(sha256Hex(token));
    if (!stored) {
      return { ok: false, code: "LEASE_INVALID" };
    }
    if (stored.meta.revoked) {
      return { ok: false, code: "LEASE_REVOKED" };
    }
    if (this.now() >= stored.expiresAtMs) {
      return { ok: false, code: "LEASE_EXPIRED" };
    }
    if (stored.meta.scope !== "responses:create") {
      return { ok: false, code: "LEASE_SCOPE_MISMATCH" };
    }
    if (
      !constantTimeEquals(stored.meta.providerId, want.providerId) ||
      !constantTimeEquals(stored.meta.model, want.model)
    ) {
      return { ok: false, code: "LEASE_SCOPE_MISMATCH" };
    }

    return { ok: true, lease: { ...stored.meta } };
  }

  /** Revoke by lease id or raw token. Idempotent. Returns whether it existed. */
  revoke(reference: string): boolean {
    let stored = this.byId.get(reference);
    if (
      !stored &&
      typeof reference === "string" &&
      reference.startsWith(LEASE_TOKEN_PREFIX)
    ) {
      stored = this.byHash.get(sha256Hex(reference));
    }
    if (!stored) {
      return false;
    }
    stored.meta.revoked = true;
    return true;
  }

  activeCount(): number {
    const nowMs = this.now();
    let active = 0;
    for (const stored of this.byId.values()) {
      if (!stored.meta.revoked && nowMs < stored.expiresAtMs) {
        active += 1;
      }
    }
    return active;
  }

  /** Drop leases whose expiry is at or before `now`. Returns the count removed. */
  sweepExpired(now: number = this.now()): number {
    let removed = 0;
    for (const [id, stored] of this.byId) {
      if (now >= stored.expiresAtMs) {
        this.byId.delete(id);
        this.byHash.delete(stored.hash);
        removed += 1;
      }
    }
    return removed;
  }
}
