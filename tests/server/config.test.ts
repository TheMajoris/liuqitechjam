import { describe, expect, it } from "vitest";
import { isPermitAccessRequestConfigured, isPermitConfigured, loadConfig } from "../../apps/server/src/config.js";

const permitEnvironment = {
  NODE_ENV: "production" as const,
  HOST: "127.0.0.1",
  PERMIT_API_KEY: "permit-api-key",
  PERMIT_PDP_URL: "https://pdp.example.test",
  PERMIT_PROJECT_ID: "launchpad",
  PERMIT_ENVIRONMENT_ID: "production",
  PERMIT_TENANT_KEY: "demo",
  PERMIT_OPERATION_APPROVAL_CONFIG_ID: "approval-config",
  PERMIT_ACCESS_REQUEST_CONFIG_ID: "access-config",
};

describe("Permit configuration", () => {
  it("requires the production Permit authorization settings", () => {
    expect(() => loadConfig({ NODE_ENV: "production", HOST: "127.0.0.1" })).toThrow(
      "PERMIT_API_KEY",
    );
  });

  it("returns a complete, all-or-nothing Permit configuration", () => {
    const config = loadConfig(permitEnvironment);

    expect(isPermitConfigured(config)).toBe(true);
    expect(isPermitAccessRequestConfigured(config)).toBe(true);
    expect(config).toMatchObject({
      permitPdpUrl: "https://pdp.example.test",
      permitProjectId: "launchpad",
      permitEnvironmentId: "production",
      permitTenantKey: "demo",
      permitOperationApprovalConfigId: "approval-config",
      permitAccessRequestConfigId: "access-config",
      permitCheckTimeoutMs: 5_000,
    });
  });

  it("does not require deferred persistent Access Requests for production authorization", () => {
    const config = loadConfig({
      ...permitEnvironment,
      PERMIT_ACCESS_REQUEST_CONFIG_ID: undefined,
    });

    expect(isPermitConfigured(config)).toBe(true);
    expect(isPermitAccessRequestConfigured(config)).toBe(false);
  });

  it("allows production local mode without any Permit configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      AUTHORIZATION_MODE: "local",
      HOST: "127.0.0.1",
    });

    expect(config.authorizationMode).toBe("local");
    expect(isPermitConfigured(config)).toBe(false);
  });

  it("rejects local mode on a non-loopback host", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      AUTHORIZATION_MODE: "local",
      HOST: "0.0.0.0",
    })).toThrow("AUTHORIZATION_MODE=local requires HOST to be a loopback address");
  });
});
