import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  startChildProcessExecution,
  type ChildProcessExecution,
} from "./child-process-execution.js";
import type { AppConfig } from "./config.js";
import {
  buildCodexArgs,
  finalizeCodexRun,
  parseCodexEventLine,
  type ParsedEvents,
} from "./codex-runner.js";
import { RetryableModelError, RunCancelledError } from "./errors.js";
import type { SandboxAuditSink } from "./audit/sandbox-audit.js";
import type { ContainerHealthSampler } from "./telemetry/container-health-sampler.js";
import { MCP_BEARER_TOKEN_ENV } from "./tools/mcp-session-service.js";
import type {
  AgentRunner,
  RuntimeReconciliationInput,
  RuntimeReconciliationResult,
  RunnerRequest,
  RunnerResult,
  WorkspaceWriterSettlement,
} from "./types.js";
import {
  isPositiveRuntimeAbsence,
  reconcileOwnedContainerRuntimes,
  type RuntimeContainerEngineExec,
} from "./runtime-reconciliation.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS = 2_000;
const MAX_MCP_PREFLIGHT_TIMEOUT_MS = 5_000;

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export interface McpEndpointProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
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
  const onExternalAbort = () => {
    controller.abort(options.signal?.reason);
    resolveTimeout(false);
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
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
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

interface ActiveContainer {
  execution: ChildProcessExecution;
  context: ContainerExecutionContext;
}

interface ContainerExecutionContext {
  controller: AbortController;
  deadlineAt?: number;
  execution: ChildProcessExecution | null;
  settled: Promise<void>;
  resolveSettled: () => void;
  cancelPromise: Promise<void> | null;
  cancelReason: "cancelled" | "timed-out" | null;
  deadlineTimer: NodeJS.Timeout | null;
  removeSignalListener: (() => void) | null;
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

export type ContainerEngineExec = RuntimeContainerEngineExec;

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
    ...buildCodexArgs(
      request,
      config.codexSandboxMode,
      "/workspace",
      config.mcpToolTimeoutSec,
    ),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();
  private readonly contexts = new Map<string, ContainerExecutionContext>();
  private readonly mcpProbe: (
    endpoint: string,
    options?: McpEndpointProbeOptions,
  ) => Promise<boolean>;
  private readonly execEngine: ContainerEngineExec;
  private readonly healthSampler: ContainerHealthSampler | undefined;

  constructor(
    private readonly config: AppConfig,
    options: {
      mcpProbe?: (
        endpoint: string,
        options?: McpEndpointProbeOptions,
      ) => Promise<boolean>;
      execEngine?: ContainerEngineExec;
      healthSampler?: ContainerHealthSampler;
    } = {},
  ) {
    this.mcpProbe =
      options.mcpProbe ??
      ((endpoint, probeOptions) => probeMcpEndpoint(endpoint, probeOptions));
    this.execEngine =
      options.execEngine ??
      ((args, timeoutMs) =>
        execFileAsync(this.config.containerEngine, args, {
          timeout: timeoutMs,
          env: this.childEnvironment(),
        }));
    this.healthSampler = options.healthSampler;
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

  /** Reconcile only this configured instance's persisted runtime identities. */
  async reconcileStartup(
    input: RuntimeReconciliationInput,
  ): Promise<RuntimeReconciliationResult> {
    return reconcileOwnedContainerRuntimes(
      this.config,
      input,
      this.execEngine,
    );
  }

  async cancel(agentId: string): Promise<boolean> {
    const context = this.contexts.get(agentId);
    if (!context) return false;
    await this.cancelContext(context, "cancelled");
    return true;
  }

  private createContext(request: RunnerRequest): ContainerExecutionContext {
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const context: ContainerExecutionContext = {
      controller,
      ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
      execution: null,
      settled,
      resolveSettled,
      cancelPromise: null,
      cancelReason: null,
      deadlineTimer: null,
      removeSignalListener: null,
    };
    const onAbort = () => {
      const reason = request.signal?.reason;
      const timedOut = reason instanceof Error && reason.name === "TimeoutError";
      void this.cancelContext(context, timedOut ? "timed-out" : "cancelled");
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    context.removeSignalListener = () =>
      request.signal?.removeEventListener("abort", onAbort);
    if (request.signal?.aborted) onAbort();
    if (request.deadlineAt !== undefined && Number.isFinite(request.deadlineAt)) {
      const remaining = request.deadlineAt - Date.now();
      if (remaining <= 0) {
        void this.cancelContext(context, "timed-out");
      } else {
        context.deadlineTimer = setTimeout(() => {
          void this.cancelContext(context, "timed-out");
        }, remaining);
        context.deadlineTimer.unref();
      }
    }
    return context;
  }

  private async cancelContext(
    context: ContainerExecutionContext,
    reason: "cancelled" | "timed-out",
  ): Promise<void> {
    if (context.cancelPromise) return context.cancelPromise;
    context.cancelReason = reason;
    const abortReason =
      reason === "timed-out"
        ? timeoutError("Runtime operation timed out")
        : new RunCancelledError();
    if (!context.controller.signal.aborted) context.controller.abort(abortReason);
    context.cancelPromise = (async () => {
      let cancellationError: unknown;
      try {
        if (context.execution) await context.execution.cancel();
      } catch (error) {
        cancellationError = error;
      }
      await context.settled;
      if (cancellationError) throw cancellationError;
    })();
    await context.cancelPromise;
  }

  private operationError(context: ContainerExecutionContext): Error | undefined {
    if (
      context.deadlineAt !== undefined &&
      Number.isFinite(context.deadlineAt) &&
      Date.now() >= context.deadlineAt
    ) {
      return timeoutError("Runtime operation timed out");
    }
    if (!context.cancelReason) return undefined;
    if (context.cancelReason === "timed-out") {
      return timeoutError("Runtime operation timed out");
    }
    return new RunCancelledError();
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
  ): Promise<{ state: ContainerState | null; settlement: WorkspaceWriterSettlement }> {
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
    // Settlement is positive evidence only: a successful forced removal, or
    // the engine stating that the named container does not exist. An engine
    // failure or timeout is unknown, even when a model result exists.
    let settlement: WorkspaceWriterSettlement = "unknown";
    try {
      await this.execEngine(
        ["rm", "--force", containerName],
        REMOVE_TIMEOUT_MS,
      );
      settlement = "settled";
    } catch (error) {
      if (isPositiveRuntimeAbsence(error)) {
        settlement = "settled";
      } else if (child) {
        // Only a stop path owns the container's removal; on the normal path
        // the container is already gone and a rejection is expected.
        sandboxAudit?.cleanupFailed({
          stage: "remove",
          durationMs: Date.now() - cleanupStartedAt,
        });
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 3_000);
        forceKill.unref();
      }
    }
    return { state, settlement };
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId) || this.contexts.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }
    const context = this.createContext(request);
    this.contexts.set(request.agentId, context);
    try {
      const initialControlError = this.operationError(context);
      if (initialControlError) throw initialControlError;
      if (request.mcp) {
        let reachable = false;
        try {
          const probeTimeoutMs =
            request.deadlineAt === undefined
              ? undefined
              : Math.max(1, request.deadlineAt - Date.now());
          reachable = await this.mcpProbe(this.config.mcpPublicUrl, {
            signal: context.controller.signal,
            ...(probeTimeoutMs === undefined ? {} : { timeoutMs: probeTimeoutMs }),
          });
        } catch {
          const probeControlError = this.operationError(context);
          if (probeControlError) throw probeControlError;
          reachable = false;
        }
        const probeControlError = this.operationError(context);
        if (probeControlError) throw probeControlError;
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
      let termination: Promise<{ state: ContainerState | null; settlement: WorkspaceWriterSettlement }> | null = null;
      let inspectedState: ContainerState | null = null;
      let settlement: WorkspaceWriterSettlement = "unknown";
      // Inspect + remove is idempotent per run: the stop path and the normal
      // path share one promise so the container is never inspected twice.
      const cleanup = async (child?: ChildProcess): Promise<ContainerState | null> => {
        if (!termination) {
          termination = this.inspectAndRemove(
            activeContainerName,
            child,
            request.sandboxAudit,
          );
        }
        const outcome = await termination;
        settlement = outcome.settlement;
        return outcome.state;
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
      const beforeSpawnControlError = this.operationError(context);
      if (beforeSpawnControlError) throw beforeSpawnControlError;
      const startedAt = Date.now();
      try {
        execution = startChildProcessExecution({
          command: this.config.containerEngine,
          args: buildContainerRunArgs(request, this.config),
          cwd: request.workspacePath,
          env: this.childEnvironment(request),
          timeoutMs: this.config.codexTimeoutMs,
          signal: context.controller.signal,
          ...(request.deadlineAt === undefined
            ? {}
            : { deadlineAt: request.deadlineAt }),
          maxOutputBytes: this.config.codexMaxOutputBytes,
          startErrorMessage: "Container runtime could not start",
          onLine: (line) => parseCodexEventLine(line, parsed, request.observer),
          stop: (child) => cleanup(child).then(() => undefined),
        });
      } catch (error) {
        const spawnControlError = this.operationError(context);
        if (spawnControlError) throw spawnControlError;
        throw new RetryableModelError("Container runtime could not start", {
          cause: error,
        });
      }
      context.execution = execution;
      this.active.set(request.agentId, { execution, context });
      const runId = request.runId ?? request.agentId;
      this.healthSampler?.start(activeContainerName, {
        agentId: request.agentId,
        runId,
      });

      let result: Awaited<typeof execution.completed> | undefined;
      try {
        try {
          result = await execution.completed;
        } catch (error) {
          const executionControlError = this.operationError(context);
          if (executionControlError) throw executionControlError;
          throw new RetryableModelError("Container runtime could not start", {
            cause: error,
          });
        }
        inspectedState = await cleanup();
        const cleanupControlError = this.operationError(context);
        if (cleanupControlError) throw cleanupControlError;
        const finalized = finalizeCodexRun(parsed, result, {
          timeout: "Runtime timed out after " + this.config.codexTimeoutMs + " ms",
          exit: "Container runtime exited with code " + result.exitCode,
          missing: "Codex completed without an agent message",
          missingTruncated:
            "Codex completed without an agent message after an oversized event was dropped; raise CODEX_MAX_OUTPUT_BYTES",
        });
        return { ...finalized, workspaceSettlement: settlement };
      } finally {
        this.active.delete(request.agentId);
        this.healthSampler?.stop(runId);
        const peak = this.healthSampler?.peak(runId);
        const inspected = inspectedState !== null;
        request.sandboxAudit?.exited({
          exitCode: inspected
            ? (inspectedState?.ExitCode ?? null)
            : (result?.exitCode ?? null),
          oomKilled: inspected ? Boolean(inspectedState?.OOMKilled) : null,
          durationMs: Date.now() - startedAt,
          inspected,
          cancelled: result?.cancelled ?? context.cancelReason === "cancelled",
          timedOut: result?.timedOut ?? context.cancelReason === "timed-out",
          ...(peak ? { peakCpuPct: peak.peakCpuPct, peakMemBytes: peak.peakMemBytes } : {}),
        });
      }
    } finally {
      this.settleContext(request.agentId, context);
    }
  }

  private settleContext(agentId: string, context: ContainerExecutionContext): void {
    if (context.deadlineTimer) clearTimeout(context.deadlineTimer);
    context.deadlineTimer = null;
    context.removeSignalListener?.();
    context.removeSignalListener = null;
    if (this.contexts.get(agentId) === context) this.contexts.delete(agentId);
    context.resolveSettled();
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
