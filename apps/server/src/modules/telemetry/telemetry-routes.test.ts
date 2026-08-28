import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { JsonStore } from "../../store.js";
import type { AgentService } from "../../agent-service.js";
import { ProviderDirectory } from "../providers/provider-directory.js";
import { TelemetryLedger } from "./telemetry-ledger.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const agentServiceStub = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const build = async (env: Record<string, string> = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), "telemetry-routes-"));
  dirs.push(root);
  const config = loadConfig({ NODE_ENV: "test", ...env });
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const ledger = new TelemetryLedger({ store, secretValues: () => ["SUPER-SECRET-KEY"] });
  const providers = new ProviderDirectory(config);
  const app = await createApp(config, agentServiceStub, {
    telemetry: { config, store, ledger, providers },
  });
  return { app, store, ledger };
};

describe("telemetry read routes", () => {
  it("GET /api/providers returns safe descriptors only", async () => {
    const { app } = await build({ RUNTIME_PROVIDER_ID: "ark", MODEL_ID: "ep-live" });
    const res = await app.inject({ method: "GET", url: "/api/providers" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers.map((p: { id: string }) => p.id).sort()).toEqual(["ark", "mock"]);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/apiKey|api_key|base_url|BASE_URL|KEY_ENV/i);
    expect(body.providers.every((p: { credentialMode: string }) => p.credentialMode === "gateway-managed")).toBe(true);
    await app.close();
  });

  it("GET /api/runs/:id/observability returns ordered spans, usage and counts", async () => {
    const { app, ledger } = await build();
    const runId = "11111111-1111-4111-8111-111111111111";
    await ledger.append({
      traceId: "t1",
      spanId: "s1",
      kind: "provider.responses",
      name: "provider.responses",
      status: "ok",
      startedAt: "2026-01-01T00:00:01.000Z",
      runId,
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    await ledger.append({
      traceId: "t1",
      spanId: "s2",
      kind: "security.deny",
      name: "denied",
      status: "error",
      startedAt: "2026-01-01T00:00:02.000Z",
      runId,
      preview: "attempt used SUPER-SECRET-KEY here",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/observability`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.spans).toHaveLength(2);
    expect(body.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(body.counts).toEqual({ total: 2, errors: 1, denied: 1 });
    expect(JSON.stringify(body)).not.toContain("SUPER-SECRET-KEY");
    await app.close();
  });

  it("GET /api/security/posture describes the protected asset and recent events", async () => {
    const { app, ledger } = await build();
    await ledger.append({
      traceId: "t2",
      spanId: "s3",
      kind: "security.kill",
      name: "security.kill",
      status: "ok",
      startedAt: "2026-01-01T00:00:03.000Z",
      code: "LEASE_REVOKED",
      runId: "22222222-2222-4222-8222-222222222222",
    });
    const res = await app.inject({ method: "GET", url: "/api/security/posture" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.protectedAsset).toMatch(/credential/i);
    expect(body.track).toBe("Kill Switch");
    expect(Array.isArray(body.controls)).toBe(true);
    expect(body.recentEvents[0]).toMatchObject({ kind: "security.kill", code: "LEASE_REVOKED" });
    await app.close();
  });
});
