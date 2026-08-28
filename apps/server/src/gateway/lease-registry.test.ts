import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LeaseRegistry, type LeaseInput } from "./lease-registry.js";

const baseScope: LeaseInput = {
  runId: "run-1",
  agentId: "agent-1",
  providerId: "mock",
  model: "mock-model",
  scope: "responses:create",
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("LeaseRegistry", () => {
  it("issues a prefixed opaque token and validates the happy path", () => {
    const registry = new LeaseRegistry(() => 1_000_000);
    const issued = registry.issue({ ...baseScope, ttlSeconds: 900 });

    expect(issued.token.startsWith("glease_")).toBe(true);
    expect(issued.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(registry.activeCount()).toBe(1);

    const result = registry.validate(issued.token, {
      providerId: "mock",
      model: "mock-model",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lease.runId).toBe("run-1");
      expect(result.lease.providerId).toBe("mock");
      expect(result.lease.revoked).toBe(false);
    }
  });

  it("clamps ttl to the 3600s maximum and 900s default", () => {
    let now = 0;
    const registry = new LeaseRegistry(() => now);

    const clamped = registry.issue({ ...baseScope, ttlSeconds: 99_999 });
    expect(Date.parse(clamped.expiresAt)).toBe(3600 * 1000);

    const defaulted = registry.issue({ ...baseScope, runId: "run-2" });
    expect(Date.parse(defaulted.expiresAt)).toBe(900 * 1000);
    now = 1;
  });

  it("denies an expired lease with LEASE_EXPIRED via injected clock", () => {
    let now = 1_000;
    const registry = new LeaseRegistry(() => now);
    const issued = registry.issue({ ...baseScope, ttlSeconds: 10 });

    now = 1_000 + 10_000; // exactly at expiry
    const result = registry.validate(issued.token, {
      providerId: "mock",
      model: "mock-model",
    });
    expect(result).toEqual({ ok: false, code: "LEASE_EXPIRED" });
    expect(registry.activeCount()).toBe(0);
  });

  it("denies a revoked lease with LEASE_REVOKED", () => {
    const registry = new LeaseRegistry(() => 5_000);
    const issued = registry.issue(baseScope);

    expect(registry.revoke(issued.leaseId)).toBe(true);
    const result = registry.validate(issued.token, {
      providerId: "mock",
      model: "mock-model",
    });
    expect(result).toEqual({ ok: false, code: "LEASE_REVOKED" });
  });

  it("denies unknown or malformed tokens with LEASE_INVALID", () => {
    const registry = new LeaseRegistry(() => 5_000);
    registry.issue(baseScope);

    for (const bad of ["", "not-a-lease", "glease_short", "glease_" + "a".repeat(40)]) {
      expect(
        registry.validate(bad, { providerId: "mock", model: "mock-model" }),
      ).toEqual({ ok: false, code: "LEASE_INVALID" });
    }
  });

  it("denies provider and model mismatch with LEASE_SCOPE_MISMATCH", () => {
    const registry = new LeaseRegistry(() => 5_000);
    const issued = registry.issue(baseScope);

    expect(
      registry.validate(issued.token, { providerId: "other", model: "mock-model" }),
    ).toEqual({ ok: false, code: "LEASE_SCOPE_MISMATCH" });
    expect(
      registry.validate(issued.token, { providerId: "mock", model: "other-model" }),
    ).toEqual({ ok: false, code: "LEASE_SCOPE_MISMATCH" });
  });

  it("revokes idempotently by id or token and reports prior existence", () => {
    const registry = new LeaseRegistry(() => 5_000);
    const issued = registry.issue(baseScope);

    expect(registry.revoke(issued.leaseId)).toBe(true);
    expect(registry.revoke(issued.leaseId)).toBe(true); // still exists
    expect(registry.revoke(issued.token)).toBe(true);
    expect(registry.revoke("glease_" + "z".repeat(43))).toBe(false);
    expect(registry.revoke("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("never exposes the raw token or its hash through validate or activeCount", () => {
    const registry = new LeaseRegistry(() => 5_000);
    const issued = registry.issue(baseScope);
    const hash = sha256Hex(issued.token);

    const result = registry.validate(issued.token, {
      providerId: "mock",
      model: "mock-model",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result.lease);
      expect(serialized).not.toContain(issued.token);
      expect(serialized).not.toContain(hash);
      expect(Object.values(result.lease)).not.toContain(issued.token);
    }
    expect(typeof registry.activeCount()).toBe("number");
    expect(JSON.stringify(registry.activeCount())).not.toContain(hash);
  });

  it("sweepExpired removes only leases at or past expiry", () => {
    let now = 0;
    const registry = new LeaseRegistry(() => now);
    registry.issue({ ...baseScope, runId: "short", ttlSeconds: 10 });
    registry.issue({ ...baseScope, runId: "long", ttlSeconds: 3000 });

    now = 20_000;
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.activeCount()).toBe(1);
    expect(registry.sweepExpired()).toBe(0);
  });
});
