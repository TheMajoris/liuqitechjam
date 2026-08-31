import { describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "../../../apps/server/src/access/authorization-service.js";
import {
  PermitAuthorizationAdapter,
  type PermitAuthorizationConfig,
  type PermitCheckClient,
} from "../../../apps/server/src/access/permit-authorization-adapter.js";
import { PermitSynchronizationGate } from "../../../apps/server/src/access/permit-synchronization-gate.js";

const configured: PermitAuthorizationConfig = {
  apiKey: "permit-api-key",
  pdpUrl: "https://pdp.example.test",
  projectId: "launchpad",
  environmentId: "test",
  tenantKey: "demo",
  operationApprovalConfigId: "approval-config",
};

function request() {
  return {
    principal: { kind: "agent" as const, id: "agent-1" },
    permission: "project.read" as const,
    resource: { kind: "project" as const, id: "project-1" },
    context: { projectId: "project-1" },
  };
}

describe("PermitAuthorizationAdapter", () => {
  it("forwards only the mapped check and allows an exact boolean true", async () => {
    const check = vi.fn<PermitCheckClient["check"]>().mockResolvedValue(true);
    const adapter = new PermitAuthorizationAdapter({
      ...configured,
      client: { check },
      requireConfiguration: true,
    });

    await expect(adapter.decide(request())).resolves.toEqual({
      result: "allow",
      reason: "Permit policy allowed the operation",
    });
    expect(check).toHaveBeenCalledWith(
      "agent:agent-1",
      "project.read",
      { type: "project", key: "project:project-1", tenant: "demo" },
      { projectId: "project-1" },
    );
  });

  it("fails closed for false, malformed, provider failures, and timeouts", async () => {
    const denied = new PermitAuthorizationAdapter({
      ...configured,
      client: { check: vi.fn().mockResolvedValue(false) },
      requireConfiguration: true,
    });
    await expect(denied.decide(request())).resolves.toMatchObject({
      result: "deny",
      reason: "Permit policy denied the operation",
      errorCode: "PERMISSION_DENIED",
    });

    const malformed = new PermitAuthorizationAdapter({
      ...configured,
      client: { check: vi.fn().mockResolvedValue({ allow: true }) },
      requireConfiguration: true,
    });
    await expect(malformed.decide(request())).resolves.toMatchObject({
      result: "deny",
      reason: "Permit returned an invalid authorization decision",
    });

    const secret = "provider-body-secret";
    const unavailable = new PermitAuthorizationAdapter({
      ...configured,
      client: {
        check: vi.fn().mockRejectedValue(new Error("HTTP 500 " + secret)),
      },
      requireConfiguration: true,
    });
    const unavailableDecision = await unavailable.decide(request());
    expect(unavailableDecision).toMatchObject({
      result: "deny",
      reason: "Permit authorization is unavailable",
    });
    expect(JSON.stringify(unavailableDecision)).not.toContain(secret);

    const timeout = new PermitAuthorizationAdapter({
      ...configured,
      client: {
        check: vi.fn(() => new Promise<boolean>(() => undefined)),
      },
      timeoutMs: 10,
      requireConfiguration: true,
    });
    await expect(timeout.decide(request())).resolves.toMatchObject({
      result: "deny",
      reason: "Permit authorization timed out",
    });
  });

  it("denies unconfigured adapters and preserves the stable AuthorizationError", async () => {
    const adapter = new PermitAuthorizationAdapter({
      client: null,
      requireConfiguration: true,
    });

    await expect(adapter.decide(request())).resolves.toMatchObject({
      result: "deny",
      reason: "Permit authorization is not configured",
      errorCode: "PERMISSION_DENIED",
    });
    await expect(adapter.require(request())).rejects.toMatchObject({
      name: "AuthorizationError",
      code: "PERMISSION_DENIED",
      message: "You are not authorized to perform this operation",
      reason: "Permit authorization is not configured",
    });
    await expect(adapter.require(request())).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("does not call Permit while the shared synchronization gate is closed", async () => {
    const gate = new PermitSynchronizationGate();
    const check = vi.fn<PermitCheckClient["check"]>().mockResolvedValue(true);
    const adapter = new PermitAuthorizationAdapter({
      ...configured,
      client: { check },
      synchronizationGate: gate,
      requireConfiguration: true,
    });

    await expect(adapter.decide(request())).resolves.toMatchObject({
      result: "deny",
      reason: "Permit authorization is not synchronized",
    });
    expect(check).not.toHaveBeenCalled();

    gate.markReady();
    await expect(adapter.decide(request())).resolves.toMatchObject({ result: "allow" });
    expect(check).toHaveBeenCalledTimes(1);

    gate.begin();
    await expect(adapter.decide(request())).resolves.toMatchObject({
      result: "deny",
      reason: "Permit authorization is not synchronized",
    });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
