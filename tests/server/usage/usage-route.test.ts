import { describe, expect, it } from "vitest";
import { createApp } from "../../../apps/server/src/app.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import type { AgentService } from "../../../apps/server/src/agent-service.js";
import type { UsageReportOptions } from "../../../apps/server/src/usage/usage-types.js";

function serviceCapturing(seen: UsageReportOptions[]): AgentService {
  return {
    listAgents: () => [],
    systemInfo: async () => ({}),
    usageReport: (options: UsageReportOptions) => {
      seen.push(options);
      return {
        since: options.since ?? null,
        generatedAt: "2026-08-30T12:00:00.000Z",
        totals: {
          runs: { total: 0, completed: 0, failed: 0, cancelled: 0, active: 0 },
          tokens: {
            availability: "unavailable",
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            runsReporting: 0,
          },
          activity: {
            toolCalls: 0,
            toolFailures: 0,
            approvalsRequired: 0,
            skillInvocations: 0,
            authorizationDenials: 0,
          },
          latency: { samples: 0, averageMs: 0, p95Ms: 0, maxMs: 0 },
          messages: 0,
        },
        agents: [],
        workspaces: [],
        projects: [],
        daily: [],
      };
    },
  } as unknown as AgentService;
}

describe("GET /api/usage", () => {
  it("returns the usage report and forwards a validated window", async () => {
    const seen: UsageReportOptions[] = [];
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), serviceCapturing(seen));

    const response = await app.inject({
      method: "GET",
      url: "/api/usage?since=2026-08-01T00:00:00.000Z&days=7",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().usage.totals.tokens.availability).toBe("unavailable");
    expect(seen).toEqual([{ since: "2026-08-01T00:00:00.000Z", days: 7 }]);
    await app.close();
  });

  it("rejects an out-of-range window rather than silently clamping it", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), serviceCapturing([]));

    const badDays = await app.inject({ method: "GET", url: "/api/usage?days=4000" });
    expect(badDays.statusCode).toBe(400);

    const badSince = await app.inject({ method: "GET", url: "/api/usage?since=yesterday" });
    expect(badSince.statusCode).toBe(400);
    await app.close();
  });

  it("requires the shared token when one is configured", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      serviceCapturing([]),
    );

    expect((await app.inject({ method: "GET", url: "/api/usage" })).statusCode).toBe(401);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/usage",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});
