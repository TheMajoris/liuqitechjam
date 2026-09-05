import { describe, expect, it } from "vitest";
import { AuditService } from "../../../apps/server/src/audit/audit-service.js";
import {
  AUDIT_CSV_COLUMNS,
  auditExportFilename,
  exportAuditEvents,
} from "../../../apps/server/src/audit/audit-export.js";
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

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";

interface EventSeed {
  id: string;
  type: AuditEventType;
  minute: number;
  sequence: number;
  agentId: string;
  summary?: string;
  metadata?: AuditEvent["metadata"];
}

function makeEvent(seed: EventSeed): AuditEvent {
  return {
    id: seed.id,
    type: seed.type,
    status: "success",
    summary: seed.summary ?? `${seed.type} ${seed.id}`,
    createdAt: `2026-03-01T00:0${seed.minute}:00.000Z`,
    principal: agentPrincipal(seed.agentId),
    metadata: seed.metadata ?? {},
    traceId: "trace-1",
    spanId: `span-${seed.sequence}`,
    sequence: seed.sequence,
    actorType: "agent",
    category: AUDIT_EVENT_CATEGORY[seed.type],
    agentId: seed.agentId,
  };
}

function fixtureEvents(): AuditEvent[] {
  return [
    makeEvent({ id: "e1", type: "run_started", minute: 0, sequence: 1, agentId: AGENT_A }),
    makeEvent({ id: "e2", type: "tool_started", minute: 1, sequence: 2, agentId: AGENT_B }),
    makeEvent({
      id: "e3",
      type: "tool_succeeded",
      minute: 2,
      sequence: 3,
      agentId: AGENT_A,
      summary: '=SUM(A1) said "hi", and left',
      metadata: { note: 'quoted "value"' },
    }),
    makeEvent({ id: "e4", type: "run_completed", minute: 3, sequence: 4, agentId: AGENT_A }),
  ];
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

function makeService(): AuditService {
  return new AuditService(new InMemoryAuditStoreAdapter(fixtureEvents()));
}

function parseCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (quoted) {
      if (character === '"') {
        if (row[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

describe("exportAuditEvents", () => {
  it("writes one JSON object per line and matches the query records", () => {
    const service = makeService();
    const jsonl = service.export({ agentId: AGENT_A }, "jsonl");
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(3);

    const exported = lines.map((line) => JSON.parse(line) as AuditEvent);
    expect(exported.map((event) => event.id)).toEqual(["e1", "e3", "e4"]);

    // Same records as /api/audit for the same filter, chronological instead of newest-first.
    const queried = service.query({ agentId: AGENT_A });
    expect(exported.map((event) => event.id)).toEqual(
      queried.map((event) => event.id).reverse(),
    );
    expect(exported[0]).toEqual(queried[queried.length - 1]);
  });

  it("emits an empty JSONL body when nothing matches", () => {
    expect(makeService().export({ agentId: "nobody" }, "jsonl")).toBe("");
  });

  it("quotes every CSV field and neutralizes formula-leading values", () => {
    const csv = makeService().export({ agentId: AGENT_A }, "csv");
    const rows = csv.trimEnd().split("\n");
    expect(rows).toHaveLength(4);
    expect(parseCsvRow(rows[0] as string)).toEqual([...AUDIT_CSV_COLUMNS]);
    // Every field is quoted, including the header.
    expect(rows.every((row) => row.startsWith('"') && row.endsWith('"'))).toBe(true);

    const columns = parseCsvRow(rows[2] as string);
    const cell = (name: (typeof AUDIT_CSV_COLUMNS)[number]) =>
      columns[AUDIT_CSV_COLUMNS.indexOf(name)];
    expect(cell("id")).toBe("e3");
    expect(cell("summary")).toBe('\'=SUM(A1) said "hi", and left');
    expect(rows[2]).toContain('""hi""');
    expect(cell("metadata")).toBe('{"note":"quoted \\"value\\""}');
    expect(cell("parentSpanId")).toBe("");
    expect(cell("principalKind")).toBe("agent");
    expect(cell("principalId")).toBe(AGENT_A);

    for (const prefix of ["+", "-", "@"]) {
      const csv = exportAuditEvents(
        [makeEvent({ id: "x", type: "run_started", minute: 0, sequence: 1, agentId: AGENT_A, summary: `${prefix}danger` })],
        "csv",
      );
      expect(csv.split("\n")[1]).toContain(`"'${prefix}danger"`);
    }
  });

  it("filters by since and until inclusively", () => {
    const service = makeService();
    const window = service
      .export({ since: "2026-03-01T00:01:00.000Z", until: "2026-03-01T00:02:00.000Z" }, "jsonl")
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as AuditEvent).id);
    expect(window).toEqual(["e2", "e3"]);
  });

  it("names the attachment with a sortable timestamp", () => {
    expect(auditExportFilename("csv", new Date("2026-03-04T05:06:07.000Z"))).toBe(
      "audit-20260304-050607.csv",
    );
  });
});

describe("audit export route", () => {
  const agentService = {
    listAgents: () => [],
    systemInfo: async () => ({}),
  } as unknown as AgentService;

  async function makeApp() {
    return createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      undefined,
      undefined,
      undefined,
      undefined,
      { auditService: makeService() } as McpRouteDependencies,
    );
  }

  it("serves jsonl by default and csv on request", async () => {
    const app = await makeApp();
    const jsonl = await app.inject({ method: "GET", url: "/api/audit/export" });
    expect(jsonl.statusCode).toBe(200);
    expect(jsonl.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
    expect(jsonl.headers["content-disposition"]).toMatch(
      /^attachment; filename="audit-\d{8}-\d{6}\.jsonl"$/,
    );
    expect(jsonl.body.trimEnd().split("\n")).toHaveLength(4);

    const csv = await app.inject({ method: "GET", url: "/api/audit/export?format=csv" });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["content-disposition"]).toMatch(/\.csv"$/);
    expect(csv.body.split("\n")[0]).toContain('"sequence"');
    await app.close();
  });

  it("applies filters and rejects an unknown format", async () => {
    const app = await makeApp();
    const filtered = await app.inject({
      method: "GET",
      url: `/api/audit/export?agentId=${AGENT_A}`,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.body.trimEnd().split("\n")).toHaveLength(3);

    const bad = await app.inject({ method: "GET", url: "/api/audit/export?format=xml" });
    expect(bad.statusCode).toBe(400);

    const badSince = await app.inject({
      method: "GET",
      url: "/api/audit/export?since=not-a-date",
    });
    expect(badSince.statusCode).toBe(400);
    await app.close();
  });
});
