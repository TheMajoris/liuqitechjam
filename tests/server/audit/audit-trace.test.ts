import { describe, expect, it } from "vitest";
import { AuditService } from "../../../apps/server/src/audit/audit-service.js";
import {
  buildTraceTree,
  listTraces,
  type AuditTraceNode,
} from "../../../apps/server/src/audit/audit-trace.js";
import { GENESIS_HASH } from "../../../apps/server/src/audit/audit-hash.js";
import type {
  AuditEventDraft,
  AuditStoreAdapter,
} from "../../../apps/server/src/audit/audit-store.js";
import {
  AUDIT_EVENT_CATEGORY,
  type AuditEvent,
  type AuditEventType,
  type HashedAuditEvent,
} from "../../../apps/server/src/audit/audit-types.js";
import { agentPrincipal } from "../../../apps/server/src/access/principal.js";
import { createApp } from "../../../apps/server/src/app.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import type { AgentService } from "../../../apps/server/src/agent-service.js";
import type { McpRouteDependencies } from "../../../apps/server/src/mcp-server.js";

const TRACE_ID = "orch-1";

interface EventSeed {
  id: string;
  type: AuditEventType;
  spanId: string;
  parentSpanId?: string;
  minute: number;
  sequence: number;
  status?: AuditEvent["status"];
  traceId?: string;
  agentId?: string;
  projectId?: string;
  runId?: string;
  durationMs?: number;
}

function makeEvent(seed: EventSeed): AuditEvent {
  return {
    id: seed.id,
    type: seed.type,
    status: seed.status ?? "success",
    summary: `${seed.type} ${seed.id}`,
    createdAt: `2026-02-01T00:0${seed.minute}:00.000Z`,
    principal: agentPrincipal(seed.agentId ?? "agent-1"),
    metadata: {},
    traceId: seed.traceId ?? TRACE_ID,
    spanId: seed.spanId,
    ...(seed.parentSpanId === undefined ? {} : { parentSpanId: seed.parentSpanId }),
    sequence: seed.sequence,
    actorType: "agent",
    category: AUDIT_EVENT_CATEGORY[seed.type],
    ...(seed.durationMs === undefined ? {} : { durationMs: seed.durationMs }),
    ...(seed.agentId === undefined ? {} : { agentId: seed.agentId }),
    ...(seed.projectId === undefined ? {} : { projectId: seed.projectId }),
    ...(seed.runId === undefined ? {} : { runId: seed.runId }),
  };
}

/** root(orchestration) -> participant -> run -> sandbox_command. */
function orchestrationEvents(): AuditEvent[] {
  return [
    makeEvent({
      id: "e1",
      type: "orchestration_started",
      spanId: "s-root",
      minute: 0,
      sequence: 1,
      agentId: "agent-1",
      projectId: "project-1",
    }),
    makeEvent({
      id: "e2",
      type: "participant_dispatched",
      spanId: "s-part",
      parentSpanId: "s-root",
      minute: 1,
      sequence: 2,
      agentId: "agent-1",
    }),
    makeEvent({
      id: "e3",
      type: "run_started",
      spanId: "s-run",
      parentSpanId: "s-part",
      minute: 2,
      sequence: 3,
      agentId: "agent-1",
      runId: "run-1",
    }),
    makeEvent({
      id: "e4",
      type: "sandbox_command",
      spanId: "s-sandbox",
      parentSpanId: "s-run",
      minute: 3,
      sequence: 4,
      agentId: "agent-1",
      runId: "run-1",
    }),
    makeEvent({
      id: "e5",
      type: "run_completed",
      spanId: "s-run",
      parentSpanId: "s-part",
      minute: 4,
      sequence: 5,
      agentId: "agent-1",
      runId: "run-1",
    }),
    makeEvent({
      id: "e6",
      type: "orchestration_completed",
      spanId: "s-root",
      minute: 5,
      sequence: 6,
      agentId: "agent-1",
      projectId: "project-1",
    }),
  ];
}

function onlyChild(node: AuditTraceNode): AuditTraceNode {
  expect(node.children).toHaveLength(1);
  return node.children[0] as AuditTraceNode;
}

class InMemoryAuditStoreAdapter implements AuditStoreAdapter {
  constructor(public events: AuditEvent[] = []) {}

  read(): readonly AuditEvent[] {
    return this.events;
  }

  anchor(): null {
    return null;
  }

  async append(event: AuditEventDraft): Promise<HashedAuditEvent> {
    const chained: HashedAuditEvent = {
      ...event,
      sequence: this.events.length + 1,
      prevHash: GENESIS_HASH,
      hash: GENESIS_HASH,
    };
    this.events.push(chained);
    return chained;
  }
}

describe("buildTraceTree", () => {
  it("nests root -> participant -> run -> sandbox and groups multi-event spans", () => {
    const trace = buildTraceTree(orchestrationEvents(), TRACE_ID);

    expect(trace.root?.event.id).toBe("e1");
    expect(trace.root?.events.map((event) => event.id)).toEqual(["e1", "e6"]);
    const participant = onlyChild(trace.root as AuditTraceNode);
    expect(participant.event.type).toBe("participant_dispatched");
    const run = onlyChild(participant);
    expect(run.event.type).toBe("run_started");
    expect(run.events.map((event) => event.id)).toEqual(["e3", "e5"]);
    const sandbox = onlyChild(run);
    expect(sandbox.event.type).toBe("sandbox_command");
    expect(sandbox.children).toEqual([]);
    expect(trace.orphans).toEqual([]);
    expect(trace.eventCount).toBe(6);
    expect(trace.status).toBe("success");
    expect(trace.startedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(trace.endedAt).toBe("2026-02-01T00:05:00.000Z");
    expect(trace.durationMs).toBe(300_000);
    expect(trace.agentIds).toEqual(["agent-1"]);
    expect(trace.runIds).toEqual(["run-1"]);
  });

  it("counts every category with a zero default", () => {
    const trace = buildTraceTree(orchestrationEvents(), TRACE_ID);
    expect(trace.countsByCategory).toEqual({
      orchestration: 3,
      model_call: 2,
      tool_call: 0,
      sandbox_execution: 1,
      workspace: 0,
      policy_decision: 0,
      human_approval: 0,
      session: 0,
      system: 0,
      cloud_operation: 0,
    });
  });

  it("attaches an event with a missing parent to the root", () => {
    const events = [
      ...orchestrationEvents(),
      makeEvent({
        id: "e7",
        type: "tool_started",
        spanId: "s-lost",
        parentSpanId: "s-vanished",
        minute: 6,
        sequence: 7,
      }),
    ];
    const trace = buildTraceTree(events, TRACE_ID);
    expect(trace.orphans).toEqual([]);
    expect(trace.root?.children.map((child) => child.event.spanId)).toEqual([
      "s-part",
      "s-lost",
    ]);
  });

  it("reports orphans when there is no root", () => {
    const events = orchestrationEvents()
      .filter((event) => event.spanId !== "s-root")
      .map((event) =>
        event.spanId === "s-part" ? { ...event, parentSpanId: "s-vanished" } : event,
      );
    const trace = buildTraceTree(events, TRACE_ID);
    expect(trace.root).toBeNull();
    expect(trace.orphans.map((node) => node.event.spanId)).toEqual(["s-part"]);
    expect(onlyChild(trace.orphans[0] as AuditTraceNode).event.spanId).toBe("s-run");
  });

  it("picks the first non-policy failure as the failing step", () => {
    const events = [
      ...orchestrationEvents(),
      makeEvent({
        id: "d1",
        type: "authorization_decision",
        spanId: "s-policy",
        parentSpanId: "s-root",
        minute: 1,
        sequence: 8,
        status: "failure",
      }),
      makeEvent({
        id: "d2",
        type: "tool_failed",
        spanId: "s-tool",
        parentSpanId: "s-run",
        minute: 3,
        sequence: 9,
        status: "failure",
      }),
    ];
    const trace = buildTraceTree(events, TRACE_ID);
    expect(trace.failingStep).toEqual({
      spanId: "s-tool",
      eventId: "d2",
      type: "tool_failed",
    });
  });

  it("marks a trace failed when a run fails", () => {
    const events = [
      ...orchestrationEvents().slice(0, 4),
      makeEvent({
        id: "e5f",
        type: "run_failed",
        spanId: "s-run",
        parentSpanId: "s-part",
        minute: 4,
        sequence: 5,
        status: "failure",
        runId: "run-1",
      }),
    ];
    const trace = buildTraceTree(events, TRACE_ID);
    expect(trace.status).toBe("failure");
    expect(trace.failingStep?.eventId).toBe("e5f");
  });
});

describe("listTraces", () => {
  const other = [
    makeEvent({
      id: "o1",
      type: "orchestration_started",
      spanId: "o-root",
      minute: 8,
      sequence: 20,
      traceId: "orch-2",
      agentId: "agent-2",
    }),
    makeEvent({
      id: "o2",
      type: "orchestration_failed",
      spanId: "o-root",
      minute: 9,
      sequence: 21,
      status: "failure",
      traceId: "orch-2",
      agentId: "agent-2",
    }),
  ];

  it("returns newest first with root projection", () => {
    const summaries = listTraces([...orchestrationEvents(), ...other]);
    expect(summaries.map((summary) => summary.traceId)).toEqual(["orch-2", "orch-1"]);
    expect(summaries[0]?.rootType).toBe("orchestration_started");
    expect(summaries[0]?.rootSummary).toContain("orchestration_started");
    expect(summaries[0]).not.toHaveProperty("root");
  });

  it("filters by agentId and by status", () => {
    const events = [...orchestrationEvents(), ...other];
    expect(listTraces(events, { agentId: "agent-2" }).map((s) => s.traceId)).toEqual([
      "orch-2",
    ]);
    expect(listTraces(events, { status: "success" }).map((s) => s.traceId)).toEqual([
      "orch-1",
    ]);
    expect(listTraces(events, { projectId: "project-1" }).map((s) => s.traceId)).toEqual([
      "orch-1",
    ]);
    expect(listTraces(events, { limit: 1 })).toHaveLength(1);
  });
});

describe("AuditService trace projections", () => {
  it("resolves a run to its orchestration trace", () => {
    const service = new AuditService(new InMemoryAuditStoreAdapter(orchestrationEvents()));
    const trace = service.runTrace("run-1");
    expect(trace?.traceId).toBe(TRACE_ID);
    expect(trace?.root?.event.type).toBe("orchestration_started");
    expect(service.runTrace("run-missing")).toBeNull();
    expect(service.trace(TRACE_ID)?.eventCount).toBe(6);
    expect(service.trace("nope")).toBeNull();
    expect(service.traces().map((summary) => summary.traceId)).toEqual([TRACE_ID]);
  });
});

describe("audit trace routes", () => {
  const agentService = {
    listAgents: () => [],
    systemInfo: async () => ({}),
  } as unknown as AgentService;

  async function makeApp() {
    const auditService = new AuditService(
      new InMemoryAuditStoreAdapter(orchestrationEvents()),
    );
    return createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      undefined,
      undefined,
      undefined,
      undefined,
      { auditService } as McpRouteDependencies,
    );
  }

  it("lists traces and returns one by id", async () => {
    const app = await makeApp();
    const listed = await app.inject({ method: "GET", url: "/api/audit/traces" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().traces).toHaveLength(1);
    expect(listed.json().traces[0].traceId).toBe(TRACE_ID);

    const single = await app.inject({ method: "GET", url: `/api/audit/traces/${TRACE_ID}` });
    expect(single.statusCode).toBe(200);
    expect(single.json().trace.root.event.type).toBe("orchestration_started");
    await app.close();
  });

  it("404s an unknown trace id and an unknown run", async () => {
    const app = await makeApp();
    const missing = await app.inject({ method: "GET", url: "/api/audit/traces/nope" });
    expect(missing.statusCode).toBe(404);

    const missingRun = await app.inject({
      method: "GET",
      url: "/api/runs/99999999-9999-4999-8999-999999999999/trace",
    });
    expect(missingRun.statusCode).toBe(404);
    await app.close();
  });
});
