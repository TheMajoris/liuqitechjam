import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../apps/server/src/config.js";
import {
  buildContainerRunArgs,
  containerName,
  ContainerCodexRunner,
} from "../../apps/server/src/container-codex-runner.js";
import type { SandboxAuditSink } from "../../apps/server/src/audit/sandbox-audit.js";
import type { RuntimeReconciliationInput } from "../../apps/server/src/types.js";

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

  it("inherits the configured MCP tool timeout from the shared Codex args", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      MCP_TOOL_TIMEOUT_SEC: "75",
    });
    const args = buildContainerRunArgs(
      {
        ...baseRequest,
        mcp: {
          url: "http://host.docker.internal:3000/mcp",
          token: "opaque-token",
        },
      },
      config,
    );

    expect(args).toContain("mcp_servers.launchpad.tool_timeout_sec=75");
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

  it("cancels a pending MCP probe without spawning a container", async () => {
    hoisted.executions.length = 0;
    let probeSignal: AbortSignal | undefined;
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      (_endpoint: URL, options?: RequestInit) => {
        probeSignal = options?.signal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    );
    try {
      const runner = new ContainerCodexRunner(containerConfig());
      const run = runner.run({
        ...baseRequest,
        mcp: { url: "http://host.docker.internal:3000/mcp", token: "opaque" },
      });
      await vi.waitFor(() => expect(probeSignal).toBeDefined());
      const cancellation = runner.cancel("agent");
      await vi.waitFor(() => expect(probeSignal?.aborted).toBe(true));
      resolveFetch(new Response(null, { status: 200 }));

      await expect(cancellation).resolves.toBe(true);
      await expect(run).rejects.toThrow();
      expect(hoisted.executions).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reconciles persisted Agent and Preview runtimes without touching unrelated identities", async () => {
    const config = containerConfig();
    const removed = new Set<string>();
    const calls: string[][] = [];
    const execEngine = async (args: string[]) => {
      calls.push([...args]);
      if (args[0] === "ps") {
        if (args.includes("label=io.codejam.launchpad=agent-runtime")) {
          return { stdout: "agent-container\nunknown-agent-container\n" };
        }
        return { stdout: "preview-container\nunknown-preview-container\n" };
      }
      if (args[0] === "inspect") {
        const runtimeId = args[1];
        if (removed.has(runtimeId ?? "")) {
          throw new Error("No such object: " + runtimeId);
        }
        if (runtimeId === "agent-container") {
          return {
            stdout: JSON.stringify({
              "io.codejam.launchpad": "agent-runtime",
              "io.codejam.instance-id": config.runtimeInstanceId,
              "io.codejam.agent-id": "owned-agent",
            }),
          };
        }
        if (runtimeId === "preview-container") {
          return {
            stdout: JSON.stringify({
              "io.codejam.launchpad": "preview-runtime",
              "io.codejam.instance-id": config.runtimeInstanceId,
              "io.codejam.preview-id": "owned-preview",
            }),
          };
        }
        return {
          stdout: JSON.stringify({
            "io.codejam.launchpad": args[1]?.includes("preview")
              ? "preview-runtime"
              : "agent-runtime",
            "io.codejam.instance-id": config.runtimeInstanceId,
            [args[1]?.includes("preview")
              ? "io.codejam.preview-id"
              : "io.codejam.agent-id"]: "unrelated-persisted-id",
          }),
        };
      }
      if (args[0] === "rm") {
        removed.add(args[2] ?? "");
        return { stdout: "" };
      }
      throw new Error("unexpected engine command");
    };
    const input = {
      agents: [{ id: "owned-agent", status: "busy" }],
      runs: [],
      previews: [{ id: "owned-preview", status: "interrupted", runtimeId: "preview-container" }],
      projectLeases: [],
    } as unknown as RuntimeReconciliationInput;
    const runner = new ContainerCodexRunner(config, { execEngine });

    const result = await runner.reconcileStartup(input);

    expect(result.confirmedAgentIds).toEqual(["owned-agent"]);
    expect(result.confirmedPreviewIds).toEqual(["owned-preview"]);
    expect(result.unresolvedAgentIds).toEqual([]);
    expect(result.unresolvedPreviewIds).toEqual([]);
    expect(calls.filter((args) => args[0] === "rm").map((args) => args[2])).toEqual([
      "agent-container",
      "preview-container",
    ]);
    expect(calls.some((args) => args.includes("unknown-agent-container"))).toBe(true);
    expect(calls.some((args) => args.includes("unknown-preview-container"))).toBe(true);
    const failingRunner = new ContainerCodexRunner(config, {
      execEngine: async (args: string[]) => {
        if (args[0] === "ps") return { stdout: "agent-container\n" };
        if (args[0] === "inspect") {
          return {
            stdout: JSON.stringify({
              "io.codejam.launchpad": "agent-runtime",
              "io.codejam.instance-id": config.runtimeInstanceId,
              "io.codejam.agent-id": "owned-agent",
            }),
          };
        }
        throw new Error("permission denied by engine");
      },
    });
    await expect(failingRunner.reconcileStartup({
      agents: [{ id: "owned-agent", status: "busy" }],
      runs: [],
      previews: [],
      projectLeases: [],
    } as unknown as RuntimeReconciliationInput)).resolves.toMatchObject({
      confirmedAgentIds: [],
      unresolvedAgentIds: ["owned-agent"],
    });

    const duplicateRunner = new ContainerCodexRunner(config, {
      execEngine: async (args: string[]) => {
        if (args[0] === "ps") return { stdout: "failed-agent\nremoved-agent\n" };
        if (args[0] === "inspect") {
          const runtimeId = args[1] ?? "";
          if (runtimeId === "removed-agent" && removed.has(runtimeId)) {
            throw new Error("No such object: " + runtimeId);
          }
          return {
            stdout: JSON.stringify({
              "io.codejam.launchpad": "agent-runtime",
              "io.codejam.instance-id": config.runtimeInstanceId,
              "io.codejam.agent-id": "owned-agent",
            }),
          };
        }
        if (args[0] === "rm") {
          if (args[2] === "failed-agent") throw new Error("permission denied by engine");
          removed.add(args[2] ?? "");
          return { stdout: "" };
        }
        throw new Error("unexpected engine command");
      },
    });
    await expect(duplicateRunner.reconcileStartup({
      agents: [{ id: "owned-agent", status: "busy" }],
      runs: [],
      previews: [],
      projectLeases: [],
    } as unknown as RuntimeReconciliationInput)).resolves.toMatchObject({
      confirmedAgentIds: [],
      unresolvedAgentIds: ["owned-agent"],
    });
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

  it("preserves the provider-limit classification on a failed container turn", async () => {
    hoisted.executions.length = 0;
    const { execEngine } = engineExec({});
    const runner = new ContainerCodexRunner(containerConfig(), { execEngine });

    const run = runner.run(baseRequest);
    hoisted.executions[0]!.options.onLine(
      '{"type":"turn.failed","error":{"code":"SetLimitExceeded"}}',
    );
    hoisted.executions[0]!.finish({
      exitCode: 1,
      cancelled: false,
      timedOut: false,
      outputTruncated: false,
    });

    await expect(run).rejects.toMatchObject({
      errorCode: "MODEL_INFERENCE_LIMIT_EXCEEDED",
      message: expect.stringContaining("provider inference limit was reached"),
    });
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
