import { describe, expect, it, vi } from "vitest";
import {
  GatewayClientError,
  HttpGatewayManagementClient,
  type IssueLeaseRequest,
} from "./gateway-client.js";

const scope: IssueLeaseRequest = {
  runId: "run-1",
  agentId: "agent-1",
  providerId: "mock",
  model: "mock-model",
  scope: "responses:create",
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("HttpGatewayManagementClient.issueLease", () => {
  it("posts to the management endpoint with the admin bearer and returns the lease", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://gw:4000/internal/leases");
      expect(init?.method).toBe("POST");
      expect(
        new Headers(init?.headers).get("authorization"),
      ).toBe("Bearer admin-token-abcdefghijklmnop");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        runId: "run-1",
        scope: "responses:create",
      });
      return jsonResponse(201, {
        leaseId: "lease-1",
        token: "glease_xxx",
        expiresAt: "2026-01-01T00:15:00.000Z",
      });
    });
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000/",
      adminToken: "admin-token-abcdefghijklmnop",
      fetchImpl,
    });

    await expect(client.issueLease(scope)).resolves.toEqual({
      leaseId: "lease-1",
      token: "glease_xxx",
      expiresAt: "2026-01-01T00:15:00.000Z",
    });
  });

  it("maps a 4xx rejection to LEASE_REQUEST_REJECTED with the gateway code", async () => {
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000",
      adminToken: "admin-token-abcdefghijklmnop",
      fetchImpl: async () =>
        jsonResponse(400, { error: "no", code: "MODEL_NOT_ALLOWED" }),
    });
    const error = await client.issueLease(scope).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayClientError);
    expect(error.kind).toBe("LEASE_REQUEST_REJECTED");
    expect(error.code).toBe("MODEL_NOT_ALLOWED");
    expect(error.status).toBe(400);
  });

  it("maps a 5xx to GATEWAY_UNAVAILABLE", async () => {
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000",
      adminToken: "admin-token-abcdefghijklmnop",
      fetchImpl: async () => jsonResponse(503, { error: "down" }),
    });
    const error = await client.issueLease(scope).catch((e) => e);
    expect(error.kind).toBe("GATEWAY_UNAVAILABLE");
  });

  it("maps a transport failure to GATEWAY_UNAVAILABLE", async () => {
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000",
      adminToken: "admin-token-abcdefghijklmnop",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const error = await client.issueLease(scope).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayClientError);
    expect(error.kind).toBe("GATEWAY_UNAVAILABLE");
  });

  it("treats a malformed 201 body as GATEWAY_UNAVAILABLE", async () => {
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000",
      adminToken: "admin-token-abcdefghijklmnop",
      fetchImpl: async () => jsonResponse(201, { leaseId: "only-id" }),
    });
    const error = await client.issueLease(scope).catch((e) => e);
    expect(error.kind).toBe("GATEWAY_UNAVAILABLE");
  });

  it("aborts and fails closed when the gateway does not answer in time", async () => {
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000",
      adminToken: "admin-token-abcdefghijklmnop",
      timeoutMs: 10,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    });
    const error = await client.issueLease(scope).catch((e) => e);
    expect(error.kind).toBe("GATEWAY_UNAVAILABLE");
  });
});

describe("HttpGatewayManagementClient.revokeLease", () => {
  it("posts to the revocations endpoint and resolves on 2xx", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe(
        "http://gw:4000/internal/leases/lease-1/revocations",
      );
      return jsonResponse(200, { revoked: true });
    });
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000",
      adminToken: "admin-token-abcdefghijklmnop",
      fetchImpl,
    });
    await expect(client.revokeLease("lease-1")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("treats 404 as already-gone (idempotent)", async () => {
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000",
      adminToken: "admin-token-abcdefghijklmnop",
      fetchImpl: async () => jsonResponse(404, { error: "unknown" }),
    });
    await expect(client.revokeLease("lease-x")).resolves.toBeUndefined();
  });

  it("raises GATEWAY_UNAVAILABLE on a 5xx revoke", async () => {
    const client = new HttpGatewayManagementClient({
      baseUrl: "http://gw:4000",
      adminToken: "admin-token-abcdefghijklmnop",
      fetchImpl: async () => jsonResponse(500, {}),
    });
    const error = await client.revokeLease("lease-1").catch((e) => e);
    expect(error.kind).toBe("GATEWAY_UNAVAILABLE");
  });
});
