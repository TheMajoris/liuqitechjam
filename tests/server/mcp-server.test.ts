import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { createMcpServer, type McpRouteDependencies } from "../../apps/server/src/mcp-server.js";
import {
  McpSessionService,
  type McpSessionContext,
} from "../../apps/server/src/tools/mcp-session-service.js";
import type { AgentService } from "../../apps/server/src/agent-service.js";
import type { ToolService } from "../../apps/server/src/tools/tool-service.js";
import type { AuditEvent, AuditEventInput } from "../../apps/server/src/audit/audit-types.js";
import { agentPrincipal } from "../../apps/server/src/access/access-types.js";
import { ToolRegistry } from "../../apps/server/src/tools/tool-registry.js";
import type { ToolDefinition } from "../../apps/server/src/tools/tool-types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const emptyToolService = {
  getRegistry: () => ({ list: () => [] }),
} as unknown as ToolService;

describe("MCP scoped advertisement configuration", () => {
  it("defaults to legacy full advertisement and requires an explicit opt-in", () => {
    expect(loadConfig({ NODE_ENV: "test" }).mcpScopedAdvertisement).toBe(false);
    expect(loadConfig({
      NODE_ENV: "test",
      MCP_SCOPED_ADVERTISEMENT: "true",
    }).mcpScopedAdvertisement).toBe(true);
  });
});

function fakeAudit(): McpRouteDependencies["auditService"] & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    query: () => events,
    record: async (input: AuditEventInput) => {
      const event: AuditEvent = {
        id: String(events.length + 1),
        type: input.type,
        status: input.status,
        summary: input.summary,
        createdAt: new Date().toISOString(),
        principal: input.principal,
        metadata: (input.metadata ?? {}) as AuditEvent["metadata"],
        traceId: input.span?.traceId ?? "trace",
        spanId: input.span?.spanId ?? "span",
        sequence: events.length + 1,
        actorType: input.actorType ?? input.principal.kind,
        category: "session",
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      };
      events.push(event);
      return event;
    },
  };
}

describe("MCP route authentication auditing", () => {
  it("records mcp_session_rejected with reason invalid for a bad bearer token and never logs the token", async () => {
    const audit = fakeAudit();
    const sessions = new McpSessionService(60_000, { audit });
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      { sessions, toolService: emptyToolService, auditService: audit },
    );

    const badToken = "not-a-real-token";
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${badToken}` },
    });
    expect(response.statusCode).toBe(401);

    const rejected = audit.events.filter((event) => event.type === "mcp_session_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      status: "failure",
      summary: "MCP session rejected",
      principal: { kind: "system" },
      metadata: { reason: "invalid" },
    });
    expect(JSON.stringify(audit.events)).not.toContain(badToken);
    await app.close();
  });

  it("records mcp_session_rejected with reason missing when no bearer token is supplied", async () => {
    const audit = fakeAudit();
    const sessions = new McpSessionService(60_000, { audit });
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      { sessions, toolService: emptyToolService, auditService: audit },
    );

    const response = await app.inject({ method: "POST", url: "/mcp" });
    expect(response.statusCode).toBe(401);

    const rejected = audit.events.filter((event) => event.type === "mcp_session_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ metadata: { reason: "missing" } });
    await app.close();
  });
});

function mcpDefinition(id: string): ToolDefinition<unknown, unknown> {
  return {
    id,
    title: id,
    description: id,
    risk: "read",
    requiredPermission: "preview.read",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute() {
      return { ok: true };
    },
  };
}

describe("MCP per-run advertisement snapshots", () => {
  it("registers only the cloned snapshot, rejects hidden SDK calls, and strips discovery fields", async () => {
    const registry = new ToolRegistry([
      mcpDefinition("hidden.tool"),
      mcpDefinition("visible.tool"),
    ]);
    const executed: Array<Record<string, unknown>> = [];
    const toolService = {
      getRegistry: () => registry,
      execute: async (context: Record<string, unknown>) => {
        executed.push(context);
        return { ok: true };
      },
    } as unknown as ToolService;
    const context: McpSessionContext = {
      principal: agentPrincipal("agent-1"),
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      sessionId: "session-1",
      traceparent: "traceparent",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      advertisedToolIds: ["visible.tool"],
      diagnostics: {
        configuredCatalogueSize: 2,
        advertisedToolCount: 1,
        resolutionStatus: "scoped",
      },
    };
    const server = createMcpServer(context, toolService);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-snapshot-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["visible.tool"]);

      const hidden = await client.callTool({ name: "hidden.tool", arguments: {} });
      expect(hidden).toMatchObject({ isError: true });
      expect(executed).toHaveLength(0);

      const visibleResult = await client.callTool({ name: "visible.tool", arguments: {} });
      expect(visibleResult).toMatchObject({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      });
      expect(visibleResult).not.toHaveProperty("structuredContent");
      expect(executed).toHaveLength(1);
      expect(executed[0]).not.toHaveProperty("advertisedToolIds");
      expect(executed[0]).not.toHaveProperty("diagnostics");
      expect(executed[0]).not.toHaveProperty("expiresAt");
      expect(executed[0]).not.toHaveProperty("traceparent");
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("keeps legacy full advertisement when no snapshot is supplied", async () => {
    const registry = new ToolRegistry([mcpDefinition("hidden.tool"), mcpDefinition("visible.tool")]);
    const toolService = {
      getRegistry: () => registry,
      execute: async () => ({ ok: true }),
    } as unknown as ToolService;
    const context: McpSessionContext = {
      principal: agentPrincipal("agent-1"),
      agentId: "agent-1",
      runId: "run-legacy",
      sessionId: "session-legacy",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const server = createMcpServer(context, toolService);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-legacy-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "hidden.tool",
        "visible.tool",
      ]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("fails closed when scoped resolution reports failure without a snapshot", async () => {
    const registry = new ToolRegistry([mcpDefinition("hidden.tool")]);
    const toolService = {
      getRegistry: () => registry,
      execute: async () => ({ ok: true }),
    } as unknown as ToolService;
    const context: McpSessionContext = {
      principal: agentPrincipal("agent-1"),
      agentId: "agent-1",
      runId: "run-failed-resolution",
      sessionId: "session-failed-resolution",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      diagnostics: { resolutionStatus: "failed" },
    };
    const server = createMcpServer(context, toolService);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-failed-resolution-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toHaveLength(0);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("observes batch tools/list messages without retaining request data", async () => {
    const registry = new ToolRegistry([mcpDefinition("visible.tool")]);
    const sessions = new McpSessionService(60_000);
    const minted = sessions.mint({
      agentId: "agent-observer",
      runId: "run-observer",
      advertisedToolIds: ["visible.tool"],
    });
    const toolService = {
      getRegistry: () => registry,
      execute: async () => ({ ok: true }),
    } as unknown as ToolService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      { sessions, toolService },
    );
    try {
      await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${minted.token}`,
          "content-type": "application/json",
          "x-test-secret": "must-not-be-recorded",
        },
        payload: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "tools/list", params: { secret: "hidden" } },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { jsonrpc: "2.0", id: 3, method: "ping" },
        ]),
      });
      const resolved = sessions.resolve(minted.token);
      expect(resolved?.diagnostics).toMatchObject({
        configuredCatalogueSize: 1,
        advertisedToolCount: 1,
        toolsListRequestsObserved: 2,
        toolsListRequestBound: 32,
        toolsListRequestCountStatus: "observed",
      });
      expect(JSON.stringify(resolved)).not.toContain("must-not-be-recorded");
      expect(JSON.stringify(resolved)).not.toContain("hidden");
    } finally {
      await app.close();
    }
  });
});
