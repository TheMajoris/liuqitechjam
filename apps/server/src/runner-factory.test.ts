import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { CodexRunner } from "./codex-runner.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { createRunner } from "./runner-factory.js";
import { SecretlessRunner } from "./runtime/secretless-runner.js";

describe("createRunner", () => {
  it("returns the host-process runner outside container mode", () => {
    const config = loadConfig({ NODE_ENV: "test", RUNTIME_PROVIDER: "local-process" });
    expect(createRunner(config)).toBeInstanceOf(CodexRunner);
  });

  it("returns the plain container runner when no gateway-admin capability is set", () => {
    const config = loadConfig({ NODE_ENV: "test", RUNTIME_PROVIDER: "container" });
    expect(createRunner(config)).toBeInstanceOf(ContainerCodexRunner);
  });

  it("returns the secretless runner when container mode has a gateway-admin token", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      MODEL_GATEWAY_ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrst",
      RUNTIME_PROVIDER_ID: "ark",
      MODEL_ID: "ep-live",
    });
    expect(createRunner(config)).toBeInstanceOf(SecretlessRunner);
  });
});
