import { describe, expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import type { AgentService } from "../../apps/server/src/agent-service.js";
import type { PreviewServiceContract } from "../../apps/server/src/app.js";
import type { PreviewView } from "../../apps/server/src/preview/preview-types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("exposes the primary preview start/get/logs/stop flow", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const timestamps = {
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:01.000Z",
    };
    const preview: PreviewView = {
      id: "22222222-2222-4222-8222-222222222222",
      agentId,
      status: "running",
      host: "127.0.0.1",
      hostPort: 41_231,
      url: "http://127.0.0.1:41231",
      errorCode: null,
      errorMessage: null,
      ...timestamps,
      startedAt: timestamps.createdAt,
      stoppedAt: null,
    };
    const previewService: PreviewServiceContract = {
      start: async () => preview,
      get: async () => preview,
      restart: async () => preview,
      stop: async () => ({ ...preview, status: "stopped", url: null }),
      logs: async () => ({ preview, logs: ["ready"], truncated: false }),
    };
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      previewService,
    );

    const started = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/preview/start",
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ preview: { status: "running" } });

    const inspected = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId + "/preview",
    });
    expect(inspected.statusCode).toBe(200);

    const logs = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId + "/preview/logs?tail=1",
    });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().logs).toEqual(["ready"]);

    const stopped = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/preview/stop",
    });
    expect(stopped.statusCode).toBe(202);
    expect(stopped.json()).toMatchObject({ preview: { status: "stopped" } });
    await app.close();
  });

});
