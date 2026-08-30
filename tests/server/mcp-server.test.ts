import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { McpSessionService } from "../../apps/server/src/tools/mcp-session-service.js";
import { ToolRegistry } from "../../apps/server/src/tools/tool-registry.js";
import { ToolService, type ToolApprovalGateway } from "../../apps/server/src/tools/tool-service.js";
import type { ToolDefinition } from "../../apps/server/src/tools/tool-types.js";
import { JsonStore } from "../../apps/server/src/store.js";
import type { AgentService } from "../../apps/server/src/agent-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Streamable HTTP MCP boundary", () => {
  it("deletes revoked bearer sessions immediately", () => {
    const sessions = new McpSessionService(60_000);
    const minted = sessions.mint({ agentId: "agent-1", runId: "run-1" });
    expect(sessions.size()).toBe(1);
    expect(sessions.revoke(minted.token)).toBe(true);
    expect(sessions.resolve(minted.token)).toBeNull();
    expect(sessions.size()).toBe(0);
  });

  it("derives the default token lifetime from the Codex run timeout", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults.mcpTokenTtlMs).toBeGreaterThanOrEqual(
      defaults.codexTimeoutMs + 60_000,
    );

    const longerRun = loadConfig({
      NODE_ENV: "test",
      CODEX_TIMEOUT_MS: "1200000",
    });
    expect(longerRun.mcpTokenTtlMs).toBe(1_260_000);

    const explicitOverride = loadConfig({
      NODE_ENV: "test",
      CODEX_TIMEOUT_MS: "1200000",
      MCP_TOKEN_TTL_MS: "120000",
    });
    expect(explicitOverride.mcpTokenTtlMs).toBe(120_000);
  });

  it("authenticates before dispatch and lists/invokes a registered tool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-mcp-"));
    roots.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    await store.mutate((database) => {
      database.capabilityGrants.push({
        id: "test-echo-grant",
        agentId: "agent-1",
        projectId: "project-1",
        toolId: "test.echo",
        scope: "project",
        usesRemaining: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      });
    });
    const calls: string[] = [];
    const definition: ToolDefinition<{ value: string }, { echoed: string }> = {
      id: "test.echo",
      title: "Echo",
      description: "Echo a value",
      risk: "read",
      requiredPermission: "project.read",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      async execute(_context, input) {
        calls.push(input.value);
        return { echoed: input.value };
      },
    };
    const authorization = {
      decide: async () => ({ result: "allow" as const, reason: "test" }),
      require: async () => undefined,
    };
    // This route test deliberately uses an explicit no-op approval fake. A
    // production Agent ToolService without a Permit approval gateway fails
    // closed instead of silently skipping one-time approval consumption.
    const testApprovals = {
      isAvailable: () => true,
      consumeOperationApproval: async () => true,
    } as unknown as ToolApprovalGateway;
    const toolService = new ToolService(
      new ToolRegistry([definition]),
      authorization,
      store,
      testApprovals,
    );
    const sessions = new McpSessionService(60_000);
    const minted = sessions.mint({ agentId: "agent-1", projectId: "project-1", runId: "run-1" });
    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      { sessions, toolService },
    );

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const initialize = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer " + minted.token,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.headers["mcp-session-id"]).toBeUndefined();

    const listed = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer " + minted.token,
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["mcp-session-id"]).toBeUndefined();
    expect(listed.json().result.tools).toEqual([
      expect.objectContaining({ name: "test.echo", title: "Echo" }),
    ]);

    const invoked = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer " + minted.token,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "test.echo", arguments: { value: "hello" } },
      },
    });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.headers["mcp-session-id"]).toBeUndefined();
    expect(invoked.json().result.structuredContent).toEqual({ echoed: "hello" });
    expect(calls).toEqual(["hello"]);
    await app.close();
  });
});
