import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditService } from "../../../apps/server/src/audit/audit-service.js";
import {
  canonicalAuditEvent,
  GENESIS_HASH,
  hashAuditEvent,
  verifyAuditChain,
} from "../../../apps/server/src/audit/audit-hash.js";
import {
  JsonAuditStoreAdapter,
  MAX_PERSISTED_AUDIT_EVENTS,
  type AuditEventDraft,
  type AuditStoreAdapter,
} from "../../../apps/server/src/audit/audit-store.js";
import type {
  AuditEvent,
  HashedAuditEvent,
} from "../../../apps/server/src/audit/audit-types.js";
import { agentPrincipal } from "../../../apps/server/src/access/principal.js";
import { JsonStore } from "../../../apps/server/src/store.js";

class InMemoryAuditStoreAdapter implements AuditStoreAdapter {
  events: AuditEvent[] = [];

  read(): readonly AuditEvent[] {
    return this.events;
  }

  anchor(): null {
    return null;
  }

  async append(event: AuditEventDraft): Promise<HashedAuditEvent> {
    const last = this.events[this.events.length - 1];
    const prevHash = last?.hash ?? GENESIS_HASH;
    const sequence = (last?.sequence ?? 0) + 1;
    const chained: HashedAuditEvent = {
      ...event,
      sequence,
      prevHash,
      hash: hashAuditEvent(prevHash, { ...event, sequence }),
    };
    this.events.push(chained);
    return chained;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function recordThree(): Promise<InMemoryAuditStoreAdapter> {
  const store = new InMemoryAuditStoreAdapter();
  const service = new AuditService(store);
  for (const summary of ["first", "second", "third"]) {
    await service.record({
      type: "tool_started",
      status: "success",
      summary,
      principal: agentPrincipal("agent-1"),
    });
  }
  return store;
}

describe("canonicalAuditEvent", () => {
  it("is independent of key order and excludes the chain fields", () => {
    const a = canonicalAuditEvent({
      b: 1,
      a: { z: [1, { y: 2, x: 3 }], w: "v" },
      hash: "aaa",
      prevHash: "bbb",
    });
    const b = canonicalAuditEvent({
      prevHash: "ccc",
      a: { w: "v", z: [1, { x: 3, y: 2 }] },
      hash: "ddd",
      b: 1,
    });
    expect(a).toBe(b);
    expect(a).not.toContain("hash");
  });
});

describe("verifyAuditChain", () => {
  it("verifies a chain of three appended events", async () => {
    const store = await recordThree();
    expect(store.events[0]?.prevHash).toBe(GENESIS_HASH);
    expect(verifyAuditChain(store.events)).toEqual({ ok: true, checked: 3 });
  });

  it("detects a mutated event body", async () => {
    const store = await recordThree();
    const target = store.events[1] as HashedAuditEvent;
    target.summary = "tampered";
    expect(verifyAuditChain(store.events)).toEqual({
      ok: false,
      checked: 1,
      brokenAtSequence: 2,
      reason: "hash_mismatch",
    });
  });

  it("detects a deleted event as a sequence gap", async () => {
    const store = await recordThree();
    store.events.splice(1, 1);
    const result = verifyAuditChain(store.events);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sequence_gap");
    expect(result.brokenAtSequence).toBe(3);
  });

  it("detects a rewritten prevHash link", async () => {
    const store = await recordThree();
    const target = store.events[1] as HashedAuditEvent;
    target.prevHash = GENESIS_HASH;
    target.hash = hashAuditEvent(target.prevHash, target);
    expect(verifyAuditChain(store.events)).toMatchObject({
      ok: false,
      reason: "prev_hash_mismatch",
      brokenAtSequence: 2,
    });
  });

  it("tolerates legacy unhashed events and counts only hashed ones", async () => {
    const store = await recordThree();
    store.events.unshift({
      id: "legacy-1",
      type: "tool_started",
      status: "success",
      summary: "legacy",
      createdAt: "2026-01-01T00:00:00.000Z",
      principal: agentPrincipal("agent-1"),
      metadata: {},
      traceId: "trace-legacy",
      spanId: "span-legacy",
      sequence: 0,
      actorType: "agent",
      category: "tool_call",
    });
    expect(verifyAuditChain(store.events)).toEqual({ ok: true, checked: 3 });
  });
});

describe("JsonAuditStoreAdapter chain", () => {
  it("keeps verification valid across ring-buffer truncation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-audit-hash-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");

    // Seed a store already at the ring-buffer limit so the next append trims.
    const seeded: AuditEvent[] = [];
    let prevHash = GENESIS_HASH;
    for (let index = 0; index < MAX_PERSISTED_AUDIT_EVENTS; index += 1) {
      const sequence = index + 1;
      const event = {
        id: `seed-${sequence}`,
        type: "tool_started" as const,
        status: "success" as const,
        summary: `seed ${sequence}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        principal: agentPrincipal("agent-1"),
        metadata: {},
        traceId: "trace-seed",
        spanId: "span-seed",
        sequence,
        actorType: "agent" as const,
        category: "tool_call" as const,
        prevHash,
      };
      const hash = hashAuditEvent(prevHash, event);
      seeded.push({ ...event, hash });
      prevHash = hash;
    }
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [],
        auditEvents: seeded,
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();
    const adapter = new JsonAuditStoreAdapter(store);
    const service = new AuditService(adapter);

    expect(adapter.anchor()).toBeNull();
    expect(service.verify()).toEqual({ ok: true, checked: MAX_PERSISTED_AUDIT_EVENTS });

    await service.record({
      type: "tool_succeeded",
      status: "success",
      summary: "after the limit",
      principal: agentPrincipal("agent-1"),
    });

    expect(adapter.read()).toHaveLength(MAX_PERSISTED_AUDIT_EVENTS);
    expect(adapter.anchor()).toEqual({ sequence: 1, hash: seeded[0]?.hash });
    expect(service.verify()).toEqual({ ok: true, checked: MAX_PERSISTED_AUDIT_EVENTS });
  });
});
