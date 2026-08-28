import { describe, expect, it, vi } from "vitest";
import {
  GatewayClientError,
  type GatewayManagementClient,
  type IssueLeaseRequest,
  type IssuedLease,
} from "./gateway-client.js";
import {
  GatewayModelAccess,
  ModelAccessError,
  type GatewayScope,
  type GatewaySessionEvent,
} from "./model-access.js";

const scope: GatewayScope = {
  runId: "run-1",
  agentId: "agent-1",
  providerId: "mock",
  model: "mock-model",
};

class FakeGateway implements GatewayManagementClient {
  issued: IssueLeaseRequest[] = [];
  revoked: string[] = [];
  private counter = 0;
  issueBehavior: (request: IssueLeaseRequest) => Promise<IssuedLease> = async () => {
    this.counter += 1;
    return {
      leaseId: `lease-${this.counter}`,
      token: `glease_token_${this.counter}`,
      expiresAt: "2026-01-01T00:15:00.000Z",
    };
  };
  revokeBehavior: (leaseId: string) => Promise<void> = async () => undefined;

  async issueLease(request: IssueLeaseRequest): Promise<IssuedLease> {
    this.issued.push(request);
    return this.issueBehavior(request);
  }
  async revokeLease(leaseId: string): Promise<void> {
    this.revoked.push(leaseId);
    return this.revokeBehavior(leaseId);
  }
}

describe("GatewayModelAccess.withSession", () => {
  it("issues a lease, hands the callback an ephemeral session, and revokes after", async () => {
    const gateway = new FakeGateway();
    const access = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gw:4000/",
    });

    const seen = await access.withSession(scope, async (session) => {
      expect(session).toEqual({
        runId: "run-1",
        agentId: "agent-1",
        leaseId: "lease-1",
        gatewayUrl: "http://gw:4000",
        leaseToken: "glease_token_1",
        providerId: "mock",
        model: "mock-model",
        expiresAt: "2026-01-01T00:15:00.000Z",
      });
      // No provider credential is anywhere on the session object.
      expect(JSON.stringify(session)).not.toMatch(/api[_-]?key/i);
      return session.leaseToken;
    });

    expect(seen).toBe("glease_token_1");
    expect(gateway.issued).toHaveLength(1);
    expect(gateway.issued[0]).toMatchObject({ scope: "responses:create" });
    expect(gateway.revoked).toEqual(["lease-1"]);
  });

  it("revokes the lease even when the callback throws, and propagates the error", async () => {
    const gateway = new FakeGateway();
    const access = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gw:4000",
    });

    await expect(
      access.withSession(scope, async () => {
        throw new Error("callback blew up");
      }),
    ).rejects.toThrow("callback blew up");

    expect(gateway.revoked).toEqual(["lease-1"]);
  });

  it("still returns the callback result when the revoke call fails", async () => {
    const gateway = new FakeGateway();
    gateway.revokeBehavior = async () => {
      throw new GatewayClientError("GATEWAY_UNAVAILABLE", "cannot reach gateway");
    };
    const events: GatewaySessionEvent[] = [];
    const access = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gw:4000",
      onEvent: (event) => events.push(event),
    });

    await expect(
      access.withSession(scope, async () => "done"),
    ).resolves.toBe("done");
    expect(gateway.revoked).toEqual(["lease-1"]);
    expect(
      events.find((e) => e.kind === "gateway.revoke")?.status,
    ).toBe("error");
  });

  it("fails closed with GATEWAY_UNAVAILABLE and never runs the callback when issuance fails", async () => {
    const gateway = new FakeGateway();
    gateway.issueBehavior = async () => {
      throw new GatewayClientError("GATEWAY_UNAVAILABLE", "down");
    };
    const access = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gw:4000",
    });
    const callback = vi.fn(async () => "unreached");

    const error = await access.withSession(scope, callback).catch((e) => e);
    expect(error).toBeInstanceOf(ModelAccessError);
    expect(error.code).toBe("GATEWAY_UNAVAILABLE");
    expect(callback).not.toHaveBeenCalled();
    expect(gateway.revoked).toEqual([]);
  });

  it("surfaces a deterministic 4xx rejection as LEASE_REQUEST_REJECTED", async () => {
    const gateway = new FakeGateway();
    gateway.issueBehavior = async () => {
      throw new GatewayClientError(
        "LEASE_REQUEST_REJECTED",
        "model not allowed",
        400,
        "MODEL_NOT_ALLOWED",
      );
    };
    const access = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gw:4000",
    });

    const error = await access
      .withSession(scope, async () => "x")
      .catch((e) => e);
    expect(error).toBeInstanceOf(ModelAccessError);
    expect(error.code).toBe("LEASE_REQUEST_REJECTED");
  });

  it("rejects a second concurrent session for the same run", async () => {
    const gateway = new FakeGateway();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const access = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gw:4000",
    });

    const first = access.withSession(scope, async () => {
      await gate;
      return "first";
    });
    await expect(
      access.withSession(scope, async () => "second"),
    ).rejects.toThrow(ModelAccessError);
    release();
    await expect(first).resolves.toBe("first");
  });
});

describe("GatewayModelAccess.revoke", () => {
  it("is a no-op for an unknown run", async () => {
    const gateway = new FakeGateway();
    const access = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gw:4000",
    });
    await expect(access.revoke("never-issued")).resolves.toBeUndefined();
    expect(gateway.revoked).toEqual([]);
  });

  it("is idempotent when called during and after a session", async () => {
    const gateway = new FakeGateway();
    const access = new GatewayModelAccess({
      client: gateway,
      gatewayUrl: "http://gw:4000",
    });

    await access.withSession(scope, async () => {
      await access.revoke("run-1"); // explicit revoke inside the session
      return "ok";
    });
    await access.revoke("run-1"); // and again after finally already ran

    expect(gateway.revoked).toEqual(["lease-1"]); // exactly one upstream revoke
  });
});
