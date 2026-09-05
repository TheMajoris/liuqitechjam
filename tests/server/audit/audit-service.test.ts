import { describe, expect, it } from "vitest";
import { AuditService } from "../../../apps/server/src/audit/audit-service.js";
import type { AuditEvent, HashedAuditEvent } from "../../../apps/server/src/audit/audit-types.js";
import {
  GENESIS_HASH,
  hashAuditEvent,
  type AuditChainAnchor,
} from "../../../apps/server/src/audit/audit-hash.js";
import type {
  AuditEventDraft,
  AuditStoreAdapter,
} from "../../../apps/server/src/audit/audit-store.js";
import { agentPrincipal, humanPrincipal, systemPrincipal } from "../../../apps/server/src/access/principal.js";

class InMemoryAuditStoreAdapter implements AuditStoreAdapter {
  events: AuditEvent[] = [];
  anchorState: AuditChainAnchor | null = null;

  read(): readonly AuditEvent[] {
    return this.events;
  }

  anchor(): AuditChainAnchor | null {
    return this.anchorState;
  }

  async append(event: AuditEventDraft): Promise<HashedAuditEvent> {
    const last = this.events[this.events.length - 1];
    const prevHash = last?.hash ?? this.anchorState?.hash ?? GENESIS_HASH;
    const sequence = (last?.sequence ?? this.anchorState?.sequence ?? 0) + 1;
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

function makeService() {
  const store = new InMemoryAuditStoreAdapter();
  const service = new AuditService(store);
  return { store, service };
}

describe("AuditService.record", () => {
  it("generates a hex traceId/spanId and increments sequence", async () => {
    const { service } = makeService();
    const first = await service.record({
      type: "tool_started",
      status: "success",
      summary: "first",
      principal: agentPrincipal("agent-1"),
    });
    const second = await service.record({
      type: "tool_succeeded",
      status: "success",
      summary: "second",
      principal: agentPrincipal("agent-1"),
    });
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(second.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(first.spanId).not.toBe(second.spanId);
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });

  it("honours a provided span and keeps parentSpanId", async () => {
    const { service } = makeService();
    const event = await service.record({
      type: "tool_started",
      status: "success",
      summary: "spanned",
      principal: agentPrincipal("agent-1"),
      span: { traceId: "trace-abc", spanId: "span-abc", parentSpanId: "parent-abc" },
    });
    expect(event.traceId).toBe("trace-abc");
    expect(event.spanId).toBe("span-abc");
    expect(event.parentSpanId).toBe("parent-abc");
  });

  it("defaults actorType from principal kind, including system", async () => {
    const { service } = makeService();
    const human = await service.record({
      type: "tool_started",
      status: "success",
      summary: "human",
      principal: humanPrincipal(),
    });
    const agent = await service.record({
      type: "tool_started",
      status: "success",
      summary: "agent",
      principal: agentPrincipal("agent-1"),
    });
    const system = await service.record({
      type: "audit_write_failed",
      status: "failure",
      summary: "system",
      principal: systemPrincipal(),
    });
    expect(human.actorType).toBe("human");
    expect(agent.actorType).toBe("agent");
    expect(system.actorType).toBe("system");
  });

  it("defaults category from the event type mapping and accepts an override", async () => {
    const { service } = makeService();
    const defaulted = await service.record({
      type: "sandbox_started",
      status: "success",
      summary: "sandbox",
      principal: systemPrincipal(),
    });
    const overridden = await service.record({
      type: "sandbox_started",
      status: "success",
      summary: "sandbox override",
      principal: systemPrincipal(),
      category: "system",
    });
    expect(defaulted.category).toBe("sandbox_execution");
    expect(overridden.category).toBe("system");
  });

  it("drops unsafe span ids and regenerates them", async () => {
    const { service } = makeService();
    const event = await service.record({
      type: "tool_started",
      status: "success",
      summary: "unsafe span",
      principal: agentPrincipal("agent-1"),
      span: { traceId: "bad trace!!", spanId: "bad span!!" },
    });
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(event.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("AuditService.query", () => {
  it("back-fills legacy fields and derives trace ID fallbacks", async () => {
    const { store, service } = makeService();
    store.events.push({
      id: "legacy-1",
      type: "tool_started",
      status: "success",
      summary: "legacy event",
      createdAt: "2026-01-01T00:00:00.000Z",
      principal: agentPrincipal("agent-1"),
      metadata: {},
      orchestrationId: "orch-1",
      runId: "run-1",
    } as unknown as AuditEvent);
    store.events.push({
      id: "legacy-2",
      type: "tool_started",
      status: "success",
      summary: "legacy without orchestration",
      createdAt: "2026-01-01T00:00:00.000Z",
      principal: humanPrincipal(),
      metadata: {},
      runId: "run-2",
    } as unknown as AuditEvent);
    store.events.push({
      id: "legacy-3",
      type: "tool_started",
      status: "success",
      summary: "legacy without anything",
      createdAt: "2026-01-01T00:00:00.000Z",
      principal: humanPrincipal(),
      metadata: {},
    } as unknown as AuditEvent);

    const events = service.query();
    const byId = Object.fromEntries(events.map((event) => [event.id, event]));
    expect(byId["legacy-1"]).toBeDefined();
    expect(byId["legacy-1"]?.traceId).toBe("orch-1");
    expect(byId["legacy-1"]?.spanId).toBe("legacy1");
    expect(byId["legacy-1"]?.sequence).toBe(1);
    expect(byId["legacy-1"]?.actorType).toBe("agent");
    expect(byId["legacy-1"]?.category).toBe("tool_call");
    expect(byId["legacy-2"]?.traceId).toBe("run-2");
    expect(byId["legacy-3"]?.traceId).toBe("legacy-3");
  });

  it("filters by traceId and category", async () => {
    const { service } = makeService();
    const a = await service.record({
      type: "tool_started",
      status: "success",
      summary: "a",
      principal: agentPrincipal("agent-1"),
      span: { traceId: "trace-a", spanId: "span-a" },
    });
    await service.record({
      type: "sandbox_started",
      status: "success",
      summary: "b",
      principal: systemPrincipal(),
      span: { traceId: "trace-b", spanId: "span-b" },
    });

    const byTrace = service.query({ traceId: "trace-a" });
    expect(byTrace).toHaveLength(1);
    expect(byTrace[0]?.id).toBe(a.id);

    const byCategory = service.query({ category: "sandbox_execution" });
    expect(byCategory).toHaveLength(1);
    expect(byCategory[0]?.summary).toBe("b");
  });
});

describe("safeAuditMetadata allow-list", () => {
  it("keeps numeric usage counters whose names match the deny-list", async () => {
    const { safeAuditMetadata } = await import("../../../apps/server/src/audit/audit-redaction.js");
    const result = safeAuditMetadata({
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 7,
      bearerToken: "abc",
      rawOutput: "x",
    });
    expect(result).toEqual({ inputTokens: 12, cachedInputTokens: 3, outputTokens: 7 });
  });
});
