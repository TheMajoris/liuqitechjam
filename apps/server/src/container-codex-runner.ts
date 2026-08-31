import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  startChildProcessExecution,
  type ChildProcessExecution,
} from "./child-process-execution.js";
import type { AppConfig } from "./config.js";
import {
  buildCodexArgs,
  parseCodexEventLine,
  type ParsedEvents,
} from "./codex-runner.js";
import { RunCancelledError } from "./errors.js";
import { MCP_BEARER_TOKEN_ENV } from "./tools/mcp-session-service.js";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS = 2_000;
const MAX_MCP_PREFLIGHT_TIMEOUT_MS = 5_000;

export interface McpEndpointProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Probe a configured MCP URL from the host without credentials. Any HTTP
 * response proves that the host route is reachable; DNS, connection, and
 * timeout failures are treated as unreachable. The body is never consumed.
 */
export async function probeMcpEndpoint(
  endpoint: string,
  options: McpEndpointProbeOptions = {},
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(endpoint);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const timeoutMs =
    Number.isInteger(options.timeoutMs) && options.timeoutMs !== undefined && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, MAX_MCP_PREFLIGHT_TIMEOUT_MS)
      : DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  let resolveTimeout!: (reachable: boolean) => void;
  const timeoutResult = new Promise<boolean>((resolve) => {
    resolveTimeout = resolve;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    resolveTimeout(false);
  }, timeoutMs);
  timeout.unref();
  const probe = Promise.resolve()
    .then(() =>
      fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      }),
    )
    .then((response) => {
      if (timedOut || controller.signal.aborted) return false;
      if (response.body) void response.body.cancel().catch(() => undefined);
      return true;
    })
    .catch(() => false);
  try {
    return await Promise.race([probe, timeoutResult]);
  } finally {
    clearTimeout(timeout);
  }
}

interface ActiveContainer {
  execution: ChildProcessExecution;
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    ...(engineName === "docker"
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "ARK_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    ...(request.mcp ? ["--env", MCP_BEARER_TOKEN_ENV] : []),
    ...(request.mcp?.traceparent ? ["--env", "TRACEPARENT"] : []),
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace",
    "--mount",
    "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();
  private readonly mcpProbe: (endpoint: string) => Promise<boolean>;

  constructor(
    private readonly config: AppConfig,
    options: { mcpProbe?: (endpoint: string) => Promise<boolean> } = {},
  ) {
    this.mcpProbe = options.mcpProbe ?? ((endpoint) => probeMcpEndpoint(endpoint));
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    await active.execution.cancel();
    return true;
  }

  private removeContainer(
    containerName: string,
    child: ChildProcess,
  ): Promise<void> {
    return execFileAsync(
      this.config.containerEngine,
      ["rm", "--force", containerName],
      { timeout: 8_000, env: this.childEnvironment() },
    )
      .then(() => undefined)
      .catch(() => {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 3_000);
        forceKill.unref();
      });
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }
    if (request.mcp) {
      let reachable = false;
      try {
        reachable = await this.mcpProbe(this.config.mcpPublicUrl);
      } catch {
        reachable = false;
      }
      if (!reachable) {
        throw new Error("MCP endpoint is unreachable");
      }
      // The probe yields to the event loop. Re-check before spawning so two
      // concurrent calls cannot both pass the initial active-run guard.
      if (this.active.has(request.agentId)) {
        throw new Error("Agent already has an active Runtime container");
      }
    }

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    const activeContainerName = containerName(
      request.agentId,
      this.config.runtimeInstanceId,
    );
    let termination: Promise<void> | null = null;
    const execution = startChildProcessExecution({
      command: this.config.containerEngine,
      args: buildContainerRunArgs(request, this.config),
      cwd: request.workspacePath,
      env: this.childEnvironment(request),
      timeoutMs: this.config.codexTimeoutMs,
      maxOutputBytes: this.config.codexMaxOutputBytes,
      startErrorMessage: "Container runtime could not start",
      onLine: (line) => parseCodexEventLine(line, parsed),
      stop: (child) => {
        if (!termination) {
          termination = this.removeContainer(activeContainerName, child);
        }
        return termination;
      },
    });
    this.active.set(request.agentId, { execution });

    try {
      const result = await execution.completed;
      if (result.cancelled) throw new RunCancelledError();
      if (result.timedOut) {
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (result.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (result.exitCode !== 0) {
        throw new Error("Container runtime exited with code " + result.exitCode);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) throw new Error("Codex completed without an agent message");
      return { output, threadId: parsed.threadId, usage: parsed.usage };
    } finally {
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(request?: { mcp?: { token: string; traceparent?: string } }): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    if (request?.mcp) {
      environment[MCP_BEARER_TOKEN_ENV] = request.mcp.token;
      if (request.mcp.traceparent !== undefined) environment.TRACEPARENT = request.mcp.traceparent;
    }
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
