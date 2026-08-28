import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });

  it("omits the provider key and stays gateway-only on a secretless turn", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "provider-key-must-never-appear",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      RUNTIME_GATEWAY_NETWORK: "launchpad-gateway-internal",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "do work",
        threadId: null,
        runId: "run-77",
        gateway: {
          gatewayUrl: "http://gateway:4000",
          leaseToken: "glease_super_secret_lease_value",
          providerId: "ark",
          model: "ep-live",
          codexHome: "/tmp/codex-home/runs/run-77",
        },
      },
      config,
    );

    const joined = args.join(" ");
    expect(joined).not.toContain("provider-key-must-never-appear");
    expect(joined).not.toContain("glease_super_secret_lease_value");
    expect(args).not.toContain("ARK_API_KEY");
    expect(args).toContain("MODEL_GATEWAY_URL");
    expect(args).toContain("MODEL_GATEWAY_TOKEN");
    expect(args).toContain("MODEL_ID");
    // gateway-only network, run-scoped Codex home
    const networkIndex = args.indexOf("--network");
    expect(args[networkIndex + 1]).toBe("launchpad-gateway-internal");
    expect(args).toContain(
      "type=bind,src=/tmp/codex-home/runs/run-77,dst=/codex-home",
    );
    expect(args).not.toContain(
      "type=bind,src=/tmp/codex-home,dst=/codex-home",
    );
    // baseline hardening still present
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("ALL");
  });
});
