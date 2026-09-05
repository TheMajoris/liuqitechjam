import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../apps/server/src/config.js";
import {
  buildContainerRunArgs,
  containerName,
  ContainerCodexRunner,
} from "../../apps/server/src/container-codex-runner.js";
import type { SandboxAuditSink } from "../../apps/server/src/audit/sandbox-audit.js";

const hoisted = vi.hoisted(() => {
  const executions: {
    options: Record<string, any>;
    child: { kill: (signal?: string) => void };
    calls: string[];
    finish: (result: {
      exitCode: number;
      cancelled: boolean;
      timedOut: boolean;
      outputTruncated: boolean;
    }) => void;
    cancel: () => Promise<void>;
    completed: Promise<unknown>;
    settled: Promise<void>;
  }[] = [];
  return { executions };
});

vi.mock("../../apps/server/src/child-process-execution.js", () => ({
  startChildProcessExecution: (options: Record<string, any>) => {
    let finish!: (result: any) => void;
    const completed = new Promise((resolve) => {
      finish = resolve;
    });
    const calls: string[] = [];
    const child = { kill: (signal?: string) => calls.push("kill:" + signal) };
    const execution = {
      options,
      child,
      calls,
      completed,
      settled: Promise.resolve(),
      finish,
      async cancel() {
        await options.stop(child, "cancelled");
        finish({
          exitCode: 130,
          cancelled: true,
          timedOut: false,
          outputTruncated: false,
        });
      },
    };
    hoisted.executions.push(execution as any);
    return execution;
  },
}));

function containerConfig() {
  return loadConfig({
    NODE_ENV: "test",
    CODEX_HOME: "/tmp/codex-home",
    RUNTIME_PROVIDER: "container",
    CONTAINER_ENGINE: "podman",
    CONTAINER_RUNTIME_IMAGE: "runtime:test",
    RUNTIME_INSTANCE_ID: "test-instance",
  });
}

function recordingSandboxAudit(): SandboxAuditSink & {
  events: { name: string; info: any; spawnCount: number }[];
} {
  const events: { name: string; info: any; spawnCount: number }[] = [];
  const push = (name: string) => (info: any) =>
    events.push({ name, info, spawnCount: hoisted.executions.length });
  return {
    events,
    started: push("started"),
    exited: push("exited"),
    cleanupFailed: push("cleanupFailed"),
  };
}

function engineExec(handlers: {
  inspect?: () => Promise<{ stdout: string }>;
  rm?: () => Promise<{ stdout: string }>;
}) {
  const calls: string[] = [];
  const execEngine = async (args: string[]) => {
    calls.push(args[0] ?? "");
    if (args[0] === "inspect") {
      return handlers.inspect ? handlers.inspect() : { stdout: "{}" };
    }
    return handlers.rm ? handlers.rm() : { stdout: "" };
  };
  return { calls, execEngine };
}

const baseRequest = {
  agentId: "agent",
  workspacePath: "/tmp/workspace",
  prompt: "count from 1 to 10",
  threadId: null,
};

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

  it("inspects the container before removing it when a run is cancelled", async () => {
    hoisted.executions.length = 0;
    const { calls, execEngine } = engineExec({});
    const sandboxAudit = recordingSandboxAudit();
    const runner = new ContainerCodexRunner(containerConfig(), { execEngine });

    const run = runner.run({ ...baseRequest, sandboxAudit });
    await expect(runner.cancel("agent")).resolves.toBe(true);
    await expect(run).rejects.toThrow();

    expect(calls).toEqual(["inspect", "rm"]);
    expect(sandboxAudit.events.at(-1)?.info.cancelled).toBe(true);
  });

  it("audits the sandbox lifecycle around the child process", async () => {
    hoisted.executions.length = 0;
    const { execEngine } = engineExec({
      inspect: async () => ({ stdout: '{"ExitCode":137,"OOMKilled":true}' }),
    });
    const sandboxAudit = recordingSandboxAudit();
    const runner = new ContainerCodexRunner(containerConfig(), { execEngine });

    const run = runner.run({ ...baseRequest, sandboxAudit });
    hoisted.executions[0]!.finish({
      exitCode: 1,
      cancelled: false,
      timedOut: false,
      outputTruncated: false,
    });
    await expect(run).rejects.toThrow("Container runtime exited with code 1");

    const started = sandboxAudit.events[0]!;
    expect(started.name).toBe("started");
    // The start event is evidence that the container was about to be spawned.
    expect(started.spawnCount).toBe(0);
    expect(started.info.engine).toBe("podman");
    expect(started.info.image).toBe("runtime:test");
    expect(started.info.containerName).toBe("launchpad-test-instance-agent");

    const exited = sandboxAudit.events[1]!;
    expect(exited.name).toBe("exited");
    expect(exited.spawnCount).toBe(1);
    expect(exited.info.inspected).toBe(true);
    expect(exited.info.exitCode).toBe(137);
    expect(exited.info.oomKilled).toBe(true);
    expect(typeof exited.info.durationMs).toBe("number");
  });

  it("falls back to the process exit code when inspect fails", async () => {
    hoisted.executions.length = 0;
    const { execEngine } = engineExec({
      inspect: async () => {
        throw new Error("no such container");
      },
    });
    const sandboxAudit = recordingSandboxAudit();
    const runner = new ContainerCodexRunner(containerConfig(), { execEngine });

    const run = runner.run({ ...baseRequest, sandboxAudit });
    hoisted.executions[0]!.finish({
      exitCode: 3,
      cancelled: false,
      timedOut: false,
      outputTruncated: false,
    });
    await expect(run).rejects.toThrow("Container runtime exited with code 3");

    const exited = sandboxAudit.events.at(-1)!;
    expect(exited.info.inspected).toBe(false);
    expect(exited.info.exitCode).toBe(3);
    expect(exited.info.oomKilled).toBeNull();
    expect(
      sandboxAudit.events.some((event) => event.name === "cleanupFailed"),
    ).toBe(false);
  });

  it("audits a failed removal on the stop path and kills the child", async () => {
    hoisted.executions.length = 0;
    const { execEngine } = engineExec({
      rm: async () => {
        throw new Error("removal refused");
      },
    });
    const sandboxAudit = recordingSandboxAudit();
    const runner = new ContainerCodexRunner(containerConfig(), { execEngine });

    const run = runner.run({ ...baseRequest, sandboxAudit });
    await runner.cancel("agent");
    await expect(run).rejects.toThrow();

    const cleanupFailed = sandboxAudit.events.find(
      (event) => event.name === "cleanupFailed",
    );
    expect(cleanupFailed?.info.stage).toBe("remove");
    expect(hoisted.executions[0]!.calls).toContain("kill:SIGTERM");
  });

  it("starts the health sampler after spawn and folds its peak into the exit audit", async () => {
    hoisted.executions.length = 0;
    const { execEngine } = engineExec({});
    const sandboxAudit = recordingSandboxAudit();
    const startCalls: { containerName: string; key: { agentId: string; runId: string } }[] = [];
    const stopCalls: string[] = [];
    const healthSampler = {
      start: (containerName: string, key: { agentId: string; runId: string }) => {
        startCalls.push({ containerName, key });
      },
      stop: (runId: string) => {
        stopCalls.push(runId);
      },
      peak: (_runId: string) => ({ peakCpuPct: 42, peakMemBytes: 123456 }),
    };
    const runner = new ContainerCodexRunner(containerConfig(), {
      execEngine,
      healthSampler: healthSampler as any,
    });

    const run = runner.run({ ...baseRequest, runId: "run-7", sandboxAudit });
    expect(startCalls).toEqual([
      {
        containerName: "launchpad-test-instance-agent",
        key: { agentId: "agent", runId: "run-7" },
      },
    ]);
    expect(stopCalls).toEqual([]);

    hoisted.executions[0]!.finish({
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      outputTruncated: false,
    });
    await run.catch(() => undefined);

    expect(stopCalls).toEqual(["run-7"]);
    const exited = sandboxAudit.events.find((event) => event.name === "exited");
    expect(exited?.info.peakCpuPct).toBe(42);
    expect(exited?.info.peakMemBytes).toBe(123456);
  });
});
