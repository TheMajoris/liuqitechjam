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
import { RetryableModelError, RunCancelledError } from "./errors.js";
import type { SandboxAuditSink } from "./audit/sandbox-audit.js";
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

/** The engine `inspect` seam; only the fields we treat as evidence are named. */
interface ContainerState {
  ExitCode?: number;
  OOMKilled?: boolean;
  StartedAt?: string;
  FinishedAt?: string;
}

const INSPECT_TIMEOUT_MS = 4_000;
const REMOVE_TIMEOUT_MS = 8_000;

export type ContainerEngineExec = (
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

function parseContainerState(stdout: unknown): ContainerState | null {
  if (typeof stdout !== "string") return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ContainerState;
  } catch {
    return null;
  }
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
  private readonly execEngine: ContainerEngineExec;

  constructor(
    private readonly config: AppConfig,
    options: {
      mcpProbe?: (endpoint: string) => Promise<boolean>;
      execEngine?: ContainerEngineExec;
    } = {},
  ) {
    this.mcpProbe = options.mcpProbe ?? ((endpoint) => probeMcpEndpoint(endpoint));
    this.execEngine =
      options.execEngine ??
      ((args, timeoutMs) =>
        execFileAsync(this.config.containerEngine, args, {
          timeout: timeoutMs,
          env: this.childEnvironment(),
        }));
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

  /**
   * Inspect the container for its exit evidence, then remove it. Inspect runs
   * first because `--rm` erases the record the moment removal succeeds; a
   * failed inspect only means the container is already gone, never an error.
   */
  private async inspectAndRemove(
    containerName: string,
    child: ChildProcess | undefined,
    sandboxAudit: SandboxAuditSink | undefined,
  ): Promise<ContainerState | null> {
    const cleanupStartedAt = Date.now();
    let state: ContainerState | null = null;
    try {
      const inspected = await this.execEngine(
        ["inspect", containerName, "--format", "{{json .State}}"],
        INSPECT_TIMEOUT_MS,
      );
      state = parseContainerState(inspected.stdout);
    } catch {
      state = null;
    }
    try {
      await this.execEngine(
        ["rm", "--force", containerName],
        REMOVE_TIMEOUT_MS,
      );
    } catch {
      // Only a stop path owns the container's removal; on the normal path the
      // container is already gone and a rejection is expected.
      if (child) {
        sandboxAudit?.cleanupFailed({
          stage: "remove",
          durationMs: Date.now() - cleanupStartedAt,
        });
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 3_000);
        forceKill.unref();
      }
    }
    return state;
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
    let termination: Promise<ContainerState | null> | null = null;
    let inspectedState: ContainerState | null = null;
    // Inspect + remove is idempotent per run: the stop path and the normal
    // path share one promise so the container is never inspected twice.
    const cleanup = (child?: ChildProcess): Promise<ContainerState | null> => {
      if (!termination) {
        termination = this.inspectAndRemove(
          activeContainerName,
          child,
          request.sandboxAudit,
        );
      }
      return termination;
    };
    let execution: ChildProcessExecution;
    request.sandboxAudit?.started({
      engine: this.config.containerEngine,
      image: this.config.containerRuntimeImage,
      cpuLimit: this.config.containerCpuLimit,
      memoryLimit: this.config.containerMemoryLimit,
      pidsLimit: this.config.containerPidsLimit,
      containerName: activeContainerName,
    });
    const startedAt = Date.now();
    try {
      execution = startChildProcessExecution({
        command: this.config.containerEngine,
        args: buildContainerRunArgs(request, this.config),
        cwd: request.workspacePath,
        env: this.childEnvironment(request),
        timeoutMs: this.config.codexTimeoutMs,
        maxOutputBytes: this.config.codexMaxOutputBytes,
        startErrorMessage: "Container runtime could not start",
        onLine: (line) => parseCodexEventLine(line, parsed, request.observer),
        stop: (child) => cleanup(child).then(() => undefined),
      });
    } catch (error) {
      throw new RetryableModelError("Container runtime could not start", {
        cause: error,
      });
    }
    this.active.set(request.agentId, { execution });

    let result: Awaited<typeof execution.completed> | undefined;
    try {
      try {
        result = await execution.completed;
      } catch (error) {
        throw new RetryableModelError("Container runtime could not start", {
          cause: error,
        });
      }
      inspectedState = await cleanup();
      if (result.cancelled) throw new RunCancelledError();
      if (result.timedOut) {
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (result.exitCode !== 0) {
        throw new Error("Container runtime exited with code " + result.exitCode);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        // Truncation is only worth reporting when it plausibly cost us the
        // answer; a completed turn is returned regardless of dropped lines.
        throw new Error(
          result.outputTruncated
            ? "Codex completed without an agent message after an oversized event was dropped; raise CODEX_MAX_OUTPUT_BYTES"
            : "Codex completed without an agent message",
        );
      }
      return { output, threadId: parsed.threadId, usage: parsed.usage };
    } finally {
      this.active.delete(request.agentId);
      const inspected = inspectedState !== null;
      request.sandboxAudit?.exited({
        exitCode: inspected
          ? (inspectedState?.ExitCode ?? null)
          : (result?.exitCode ?? null),
        oomKilled: inspected ? Boolean(inspectedState?.OOMKilled) : null,
        durationMs: Date.now() - startedAt,
        inspected,
        cancelled: result?.cancelled ?? false,
        timedOut: result?.timedOut ?? false,
      });
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
