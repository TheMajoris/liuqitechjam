import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/server/src/config.js";
import {
  buildContainerRunArgs,
  containerName,
  ContainerCodexRunner,
} from "../../apps/server/src/container-codex-runner.js";

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

  it("probes the host-facing MCP URL before starting a container", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      MCP_PUBLIC_URL: "http://127.0.0.1:3000/mcp",
    });
    let probedEndpoint: string | undefined;
    const runner = new ContainerCodexRunner(config, {
      mcpProbe: async (endpoint) => {
        probedEndpoint = endpoint;
        return false;
      },
    });

    await expect(
      runner.run({
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "count from 1 to 10",
        threadId: null,
        mcp: {
          url: "http://host.docker.internal:3000/mcp",
          token: "opaque-run-token",
        },
      }),
    ).rejects.toThrow("MCP endpoint is unreachable");
    expect(probedEndpoint).toBe(config.mcpPublicUrl);
    expect(probedEndpoint).not.toBe("http://host.docker.internal:3000/mcp");
  });
});
