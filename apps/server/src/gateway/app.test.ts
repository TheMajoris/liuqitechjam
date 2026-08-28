import { describe, expect, it, vi } from "vitest";
import { buildGatewayApp } from "./app.js";
import { loadGatewayConfig } from "./config.js";
import { LeaseRegistry } from "./lease-registry.js";
import {
  ProviderNotFoundError,
  type ProviderCatalogPort,
} from "./provider-catalog.js";
import type { ResponsesProvider } from "./types.js";

const ADMIN_TOKEN = "gw-admin-token_0123456789abcdef";
const PROVIDER_KEY = "super-secret-provider-key-value-xyz";

const fullEnv: NodeJS.ProcessEnv = {
  MODEL_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
  LOG_LEVEL: "silent",
  GATEWAY_PROVIDERS: "mock,ark",
  PROVIDER_MOCK_PROTOCOL: "mock",
  PROVIDER_MOCK_MODELS: "mock-model",
  PROVIDER_ARK_PROTOCOL: "responses-http",
  PROVIDER_ARK_BASE_URL: "https://provider.invalid/api/v3",
  PROVIDER_ARK_MODELS: "ark-model",
  PROVIDER_ARK_KEY_ENV: "ARK_TEST_KEY",
  ARK_TEST_KEY: PROVIDER_KEY,
};

function realApp(env: NodeJS.ProcessEnv = fullEnv) {
  return buildGatewayApp(loadGatewayConfig(env));
}

async function issueLease(
  app: Awaited<ReturnType<typeof buildGatewayApp>>,
  body: Record<string, unknown>,
): Promise<{ leaseId: string; token: string; expiresAt: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/internal/leases",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: {
      runId: "run-1",
      agentId: "agent-1",
      scope: "responses:create",
      ...body,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

interface SpyHarness {
  respond: ReturnType<typeof vi.fn>;
  leases: LeaseRegistry;
  setNow: (value: number) => void;
  build: () => Promise<Awaited<ReturnType<typeof buildGatewayApp>>>;
}

function spyHarness(): SpyHarness {
  let now = 1_000_000;
  const respond = vi.fn(async () => ({
    output: "SPY-OUTPUT",
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    model: "mock-model",
  }));
  const catalog: ProviderCatalogPort = {
    list: () => [
      {
        id: "mock",
        protocol: "mock",
        models: ["mock-model"],
        credentialMode: "gateway-managed",
        health: "ok",
      },
    ],
    has: (id) => id === "mock",
    allowsModel: (id, model) => id === "mock" && model === "mock-model",
    resolve: (id) => {
      if (id !== "mock") {
        throw new ProviderNotFoundError(id);
      }
      return { respond } as unknown as ResponsesProvider;
    },
  };
  const leases = new LeaseRegistry(() => now);
  const config = loadGatewayConfig({
    MODEL_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
    LOG_LEVEL: "silent",
  });
  return {
    respond,
    leases,
    setNow: (value) => {
      now = value;
    },
    build: () => buildGatewayApp(config, { catalog, leases }),
  };
}

describe("gateway health", () => {
  it("lists providers with safe descriptors and no secrets", async () => {
    const app = await realApp();
    const res = await app.inject({ method: "GET", url: "/internal/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.leases).toEqual({ active: 0 });
    expect(body.providers).toEqual([
      {
        id: "mock",
        protocol: "mock",
        models: ["mock-model"],
        credentialMode: "gateway-managed",
        health: "ok",
      },
      {
        id: "ark",
        protocol: "responses-http",
        models: ["ark-model"],
        credentialMode: "gateway-managed",
        health: "unknown",
      },
    ]);
    expect(res.body).not.toContain(PROVIDER_KEY);
    expect(res.body).not.toContain(ADMIN_TOKEN);
    expect(res.body).not.toContain("provider.invalid");
    expect(res.body).not.toContain("ARK_TEST_KEY");
  });
});

describe("gateway lease management", () => {
  it("requires the admin token to issue a lease", async () => {
    const app = await realApp();

    const noAuth = await app.inject({
      method: "POST",
      url: "/internal/leases",
      payload: {
        runId: "r",
        agentId: "a",
        providerId: "mock",
        model: "mock-model",
        scope: "responses:create",
      },
    });
    expect(noAuth.statusCode).toBe(401);

    const wrongAuth = await app.inject({
      method: "POST",
      url: "/internal/leases",
      headers: { authorization: "Bearer not-the-admin-token" },
      payload: {
        runId: "r",
        agentId: "a",
        providerId: "mock",
        model: "mock-model",
        scope: "responses:create",
      },
    });
    expect(wrongAuth.statusCode).toBe(401);

    const ok = await issueLease(app, { providerId: "mock", model: "mock-model" });
    expect(ok.token.startsWith("glease_")).toBe(true);
    await app.close();
  });

  it("rejects unknown provider and disallowed model at issue time", async () => {
    const app = await realApp();

    const badProvider = await app.inject({
      method: "POST",
      url: "/internal/leases",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        runId: "r",
        agentId: "a",
        providerId: "ghost",
        model: "mock-model",
        scope: "responses:create",
      },
    });
    expect(badProvider.statusCode).toBe(400);
    expect(badProvider.json().code).toBe("PROVIDER_NOT_FOUND");

    const badModel = await app.inject({
      method: "POST",
      url: "/internal/leases",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        runId: "r",
        agentId: "a",
        providerId: "mock",
        model: "not-allowed",
        scope: "responses:create",
      },
    });
    expect(badModel.statusCode).toBe(400);
    expect(badModel.json().code).toBe("MODEL_NOT_ALLOWED");
    await app.close();
  });

  it("revokes idempotently", async () => {
    const app = await realApp();
    const lease = await issueLease(app, {
      providerId: "mock",
      model: "mock-model",
    });

    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: `/internal/leases/${lease.leaseId}/revocations`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revoked: true });
    }
    await app.close();
  });
});

describe("gateway data plane", () => {
  it("returns deterministic mock output for a valid lease", async () => {
    const app = await realApp();
    const lease = await issueLease(app, {
      providerId: "mock",
      model: "mock-model",
    });

    const call = () =>
      app.inject({
        method: "POST",
        url: "/p/mock/v1/responses",
        headers: { authorization: `Bearer ${lease.token}` },
        payload: { model: "mock-model", input: "hello world" },
      });

    const first = await call();
    const second = await call();
    await app.close();

    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.model).toBe("mock-model");
    expect(body.output).toMatch(/^mock:[0-9a-f]{32}$/);
    expect(body.usage).toEqual({
      inputTokens: 2,
      cachedInputTokens: 0,
      outputTokens: 3,
    });
    expect(second.json()).toEqual(body);
  });

  it("invokes the resolved provider exactly once on the happy path", async () => {
    const harness = spyHarness();
    const app = await harness.build();
    const lease = harness.leases.issue({
      runId: "run-1",
      agentId: "agent-1",
      providerId: "mock",
      model: "mock-model",
      scope: "responses:create",
    });

    const res = await app.inject({
      method: "POST",
      url: "/p/mock/v1/responses",
      headers: { authorization: `Bearer ${lease.token}` },
      payload: { model: "mock-model", input: "x" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().output).toBe("SPY-OUTPUT");
    expect(harness.respond).toHaveBeenCalledTimes(1);
  });

  const denialCases: Array<{
    name: string;
    status: number;
    code: string;
    prepare: (h: SpyHarness) => { token: string; url: string; model?: string };
  }> = [
    {
      name: "missing lease",
      status: 401,
      code: "LEASE_INVALID",
      prepare: () => ({ token: "", url: "/p/mock/v1/responses" }),
    },
    {
      name: "malformed lease",
      status: 401,
      code: "LEASE_INVALID",
      prepare: () => ({
        token: "glease_deadbeefdeadbeefdeadbeef",
        url: "/p/mock/v1/responses",
      }),
    },
    {
      name: "expired lease",
      status: 401,
      code: "LEASE_EXPIRED",
      prepare: (h) => {
        const lease = h.leases.issue({
          runId: "run-1",
          agentId: "agent-1",
          providerId: "mock",
          model: "mock-model",
          scope: "responses:create",
          ttlSeconds: 10,
        });
        h.setNow(1_000_000 + 11_000);
        return { token: lease.token, url: "/p/mock/v1/responses" };
      },
    },
    {
      name: "revoked lease",
      status: 401,
      code: "LEASE_REVOKED",
      prepare: (h) => {
        const lease = h.leases.issue({
          runId: "run-1",
          agentId: "agent-1",
          providerId: "mock",
          model: "mock-model",
          scope: "responses:create",
        });
        h.leases.revoke(lease.leaseId);
        return { token: lease.token, url: "/p/mock/v1/responses" };
      },
    },
    {
      name: "provider mismatch",
      status: 403,
      code: "LEASE_SCOPE_MISMATCH",
      prepare: (h) => {
        const lease = h.leases.issue({
          runId: "run-1",
          agentId: "agent-1",
          providerId: "other",
          model: "mock-model",
          scope: "responses:create",
        });
        return { token: lease.token, url: "/p/mock/v1/responses" };
      },
    },
    {
      name: "model mismatch",
      status: 403,
      code: "LEASE_SCOPE_MISMATCH",
      prepare: (h) => {
        const lease = h.leases.issue({
          runId: "run-1",
          agentId: "agent-1",
          providerId: "mock",
          model: "other-model",
          scope: "responses:create",
        });
        return { token: lease.token, url: "/p/mock/v1/responses" };
      },
    },
    {
      name: "unknown provider",
      status: 404,
      code: "PROVIDER_NOT_FOUND",
      prepare: (h) => {
        const lease = h.leases.issue({
          runId: "run-1",
          agentId: "agent-1",
          providerId: "ghost",
          model: "mock-model",
          scope: "responses:create",
        });
        return { token: lease.token, url: "/p/ghost/v1/responses" };
      },
    },
  ];

  for (const testCase of denialCases) {
    it(`denies ${testCase.name} with ${testCase.code} and zero provider calls`, async () => {
      const harness = spyHarness();
      const app = await harness.build();
      const { token, url } = testCase.prepare(harness);

      const res = await app.inject({
        method: "POST",
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: { model: "mock-model", input: "x" },
      });
      await app.close();

      expect(res.statusCode).toBe(testCase.status);
      expect(res.json().code).toBe(testCase.code);
      expect(harness.respond).not.toHaveBeenCalled();
    });
  }
});

describe("gateway secret hygiene", () => {
  it("keeps admin token, provider key, and raw lease out of logs and bodies", async () => {
    const chunks: string[] = [];
    const app = await buildGatewayApp(
      loadGatewayConfig({ ...fullEnv, LOG_LEVEL: "info" }),
      { logStream: { write: (chunk) => chunks.push(chunk) } },
    );

    const issued = await issueLease(app, {
      providerId: "mock",
      model: "mock-model",
    });

    const okCall = await app.inject({
      method: "POST",
      url: "/p/mock/v1/responses",
      headers: { authorization: `Bearer ${issued.token}` },
      payload: { model: "mock-model", input: "hi" },
    });
    const denied = await app.inject({
      method: "POST",
      url: "/p/mock/v1/responses",
      headers: { authorization: "Bearer glease_bogusbogusbogusbogus" },
      payload: { model: "mock-model", input: "x" },
    });
    const health = await app.inject({ method: "GET", url: "/internal/health" });
    await app.close();

    const logs = chunks.join("");
    expect(logs.length).toBeGreaterThan(0);

    for (const secret of [ADMIN_TOKEN, PROVIDER_KEY]) {
      expect(logs).not.toContain(secret);
      expect(okCall.body).not.toContain(secret);
      expect(denied.body).not.toContain(secret);
      expect(health.body).not.toContain(secret);
      expect(JSON.stringify(issued)).not.toContain(secret);
    }
    // The raw lease token may appear only in the issue response, never elsewhere.
    expect(logs).not.toContain(issued.token);
    expect(okCall.body).not.toContain(issued.token);
    expect(denied.body).not.toContain(issued.token);
    expect(health.body).not.toContain(issued.token);
  });
});
