import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../../apps/server/src/app.js";
import { AgentService } from "../../apps/server/src/agent-service.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { McpSessionService } from "../../apps/server/src/tools/mcp-session-service.js";
import { ToolRegistry } from "../../apps/server/src/tools/tool-registry.js";
import { ToolService } from "../../apps/server/src/tools/tool-service.js";
import type { ToolDefinition } from "../../apps/server/src/tools/tool-types.js";
import { RepositoryAuthorizationService } from "../../apps/server/src/access/repository-authorization-service.js";
import type { AgentRole } from "../../apps/server/src/roles/role-types.js";
import { PlatformAgentInvoker } from "../../apps/server/src/orchestration/platform-agent-invoker.js";
import {
  OrchestrationService,
} from "../../apps/server/src/orchestration/orchestration-service.js";
import type { OrchestrationSession } from "../../apps/server/src/orchestration/types.js";
import { JsonStore } from "../../apps/server/src/store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../apps/server/src/types.js";
import { WorkspaceManager } from "../../apps/server/src/workspace.js";

type ToolResult = { isError?: boolean };

function webTools(calls: { search: number }): ToolDefinition<unknown, unknown>[] {
  return [
    {
      id: "web.search",
      title: "Search",
      description: "Test search",
      risk: "network",
      requiredPermission: "tool.execute:web.search",
      inputSchema: z.object({ query: z.string().min(1) }),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute() {
        calls.search += 1;
        return { ok: true };
      },
    },
  ];
}

function webRole(): AgentRole {
  return {
    id: "web-researcher",
    name: "Web researcher",
    description: "Can use public web tools",
    skillIds: [],
    toolIds: ["web.search"],
    permissionIds: ["tool.execute:web.search"],
    source: "user",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

async function waitForTerminal(
  service: OrchestrationService,
  id: string,
): Promise<OrchestrationSession> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const session = (await service.getSession(id)).session;
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "stopped" ||
      session.status === "interrupted"
    ) {
      return session;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for orchestration " + id);
}

/** A model that handles MCP isError but still reports apparent successful output. */
class SwallowingMcpRunner implements AgentRunner {
  app: FastifyInstance | null = null;
  attempts = 0;
  readonly toolResults: ToolResult[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.attempts += 1;
    if (!request.mcp || !this.app) throw new Error("MCP test runner is not configured");
    const app = this.app;
    const transport = new StreamableHTTPClientTransport(new URL(request.mcp.url), {
      requestInit: {
        headers: { authorization: `Bearer ${request.mcp.token}` },
      },
      fetch: async (url, init) => {
        const target = new URL(String(url));
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const response = await app.inject({
          method: String(init?.method ?? "GET"),
          url: target.pathname + target.search,
          headers,
          payload: init?.body as string | undefined,
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(", ") : value ?? "",
            ]),
          ),
        });
      },
    });
    const client = new Client({ name: "permission-test-model", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = (await client.callTool({
        name: "web.search",
        arguments: { query: "permission" },
      })) as ToolResult;
      this.toolResults.push(result);
    } finally {
      await client.close().catch(() => undefined);
    }
    return {
      output: "The model completed after handling the tool response",
      threadId: request.threadId ?? "permission-test-thread",
      usage: null,
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent web permission denial propagation", () => {
  it("fails a swallowed MCP denial, keeps the Agent ready, and allows a fresh run after granting the role", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-web-permission-"));
    roots.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      WORKER_CURATED_MODELS: "ep-test,ep-fallback",
      LOG_LEVEL: "silent",
      PORT: "3317",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const runner = new SwallowingMcpRunner();
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    const sessions = new McpSessionService();
    service.setMcpSessionService(sessions);
    await service.initialize();

    const calls = { search: 0 };
    const toolService = new ToolService(
      new ToolRegistry(webTools(calls)),
      new RepositoryAuthorizationService(store),
      store,
    );
    const app = await createApp(
      config,
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      { sessions, toolService },
    );
    runner.app = app;
    const orchestration = new OrchestrationService({
      store,
      agents: service,
      invoker: new PlatformAgentInvoker(service),
    });
    await orchestration.initialize();

    try {
      const agent = await service.createAgent({
        name: "Researcher",
        modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
        fallbackModelRefs: [{ providerId: "volcengine_ark", modelId: "ep-fallback" }],
      });

      const firstAccepted = await service.sendMessage(agent.id, "Search the web");
      const first = await service.waitForRun(firstAccepted.run.id, { timeoutMs: 5_000 });
      expect(first).toMatchObject({
        status: "failed",
        errorCode: "WEB_TOOL_PERMISSION_DENIED",
      });
      expect(first.error).toBe("Web tool permission denied");
      expect(service.getAgent(agent.id).status).toBe("ready");
      expect(runner.toolResults[0]).toMatchObject({ isError: true });
      expect(runner.attempts).toBe(1);
      expect(calls.search).toBe(0);
      expect(sessions.hasWebToolPermissionDenied(first.id)).toBe(false);

      const created = await orchestration.createSession({
        name: "Web research",
        originalPrompt: "Search the web through the Team",
        participants: [
          { id: "researcher", agentId: agent.id, role: "Researcher", position: 0 },
        ],
        maxSteps: 1,
        perAgentTimeoutMs: 5_000,
      });
      await orchestration.startSession(created.id);
      const failedSession = await waitForTerminal(orchestration, created.id);
      expect(failedSession).toMatchObject({
        status: "failed",
        errorCode: "WEB_TOOL_PERMISSION_DENIED",
      });
      const failedDetail = await orchestration.getSession(created.id);
      const failedTurn = failedDetail.turns.find((turn) => turn.status === "failed");
      expect(failedTurn).toMatchObject({
        participantId: "researcher",
        errorCode: "WEB_TOOL_PERMISSION_DENIED",
      });
      expect(failedTurn?.stepIndex).toBe(0);
      expect(runner.toolResults[1]).toMatchObject({ isError: true });
      expect(runner.attempts).toBe(2);

      const role = webRole();
      await store.mutate((database) => {
        database.roles.push(role);
        const storedAgent = database.agents.find((item) => item.id === agent.id);
        if (storedAgent) storedAgent.globalRoleId = role.id;
      });

      await orchestration.retryFromStep(created.id, failedTurn!.stepIndex!);
      const retriedSession = await waitForTerminal(orchestration, created.id);
      expect(retriedSession.status).toBe("completed");
      const retriedDetail = await orchestration.getSession(created.id);
      expect(retriedDetail.turns).toHaveLength(2);
      expect(retriedDetail.turns.find((turn) => turn.id === failedTurn!.id)).toMatchObject({
        status: "failed",
        errorCode: "WEB_TOOL_PERMISSION_DENIED",
      });
      expect(retriedDetail.turns.find((turn) => turn.id !== failedTurn!.id)).toMatchObject({
        status: "completed",
        participantId: "researcher",
      });
      expect(runner.toolResults[2]).not.toMatchObject({ isError: true });
      expect(runner.attempts).toBe(3);
      expect(calls.search).toBe(1);
      expect(sessions.hasWebToolPermissionDenied(failedTurn!.runId)).toBe(false);
    } finally {
      await orchestration.shutdown();
      await app.close();
    }
  });
});
