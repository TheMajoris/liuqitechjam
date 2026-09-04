import { describe, expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { McpSessionService } from "../../apps/server/src/tools/mcp-session-service.js";
import type { AgentService } from "../../apps/server/src/agent-service.js";
import type { McpRouteDependencies } from "../../apps/server/src/mcp-server.js";
import type { ToolService } from "../../apps/server/src/tools/tool-service.js";
import type { AuditEvent, AuditEventInput } from "../../apps/server/src/audit/audit-types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const emptyToolService = {
  getRegistry: () => ({ list: () => [] }),
} as unknown as ToolService;

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
