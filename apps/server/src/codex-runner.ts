import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  startChildProcessExecution,
  type ChildProcessExecution,
} from "./child-process-execution.js";
import { DEFAULT_MCP_TOOL_TIMEOUT_SEC, type AppConfig } from "./config.js";
import {
  ModelInferenceLimitExceededError,
  RetryableModelError,
  RunCancelledError,
} from "./errors.js";
import { MCP_BEARER_TOKEN_ENV } from "./tools/mcp-session-service.js";
import type {
  AgentRunner,
  RunUsage,
  RuntimeReconciliationInput,
  RuntimeReconciliationResult,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { reconcileLocalProcessStartup } from "./runtime-reconciliation.js";
import type { RuntimeActionObserver } from "./audit/runtime-action-audit.js";

const execFileAsync = promisify(execFile);
const PROVIDER_INFERENCE_LIMIT_CODE = "SetLimitExceeded";
/** Do not retain or parse arbitrarily large provider error strings. */
const MAX_PROVIDER_ERROR_EVIDENCE_BYTES = 32 * 1024;

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  /** Set only from the supported structured Codex failure events. */
  modelInferenceLimitExceeded?: boolean;
  /** A completed turn suppresses a transient diagnostic error event. */
  turnCompleted?: boolean;
  /** Set when Codex reports an explicit terminal `turn.failed` event. */
  terminalFailure?: boolean;
  /** Ordered terminal evidence; later valid completion can supersede failure. */
  lastTerminalEvent?: "failed" | "completed";
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Match only the provider's exact code in a bounded, supported error shape.
 * The recursive fields cover an error wrapper and a provider error payload;
 * arbitrary event/message text is never searched for the code.
 */
function hasProviderInferenceLimitCode(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 2) return false;
  if (typeof value === "string") {
    if (value === PROVIDER_INFERENCE_LIMIT_CODE) return true;
    if (Buffer.byteLength(value, "utf8") > MAX_PROVIDER_ERROR_EVIDENCE_BYTES) {
      return false;
    }
    try {
      return hasProviderInferenceLimitCode(JSON.parse(value), depth + 1);
    } catch {
      return false;
    }
  }
  if (!isJsonRecord(value)) return false;
  if (value.code === PROVIDER_INFERENCE_LIMIT_CODE) return true;
  return (
    hasProviderInferenceLimitCode(value.error, depth + 1) ||
    hasProviderInferenceLimitCode(value.details, depth + 1) ||
    hasProviderInferenceLimitCode(value.message, depth + 1)
  );
}

function eventHasProviderInferenceLimitCode(event: JsonRecord): boolean {
  if (event.type === "error") {
    return (
      hasProviderInferenceLimitCode(event.code) ||
      hasProviderInferenceLimitCode(event.error) ||
      hasProviderInferenceLimitCode(event.message)
    );
  }
  if (event.type === "turn.failed") {
    return (
      hasProviderInferenceLimitCode(event.code) ||
      hasProviderInferenceLimitCode(event.error)
    );
  }
  return false;
}

export interface CodexProcessResult {
  exitCode: number;
  cancelled: boolean;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface CodexTerminalMessages {
  timeout: string;
  exit: string;
  missing: string;
  missingTruncated: string;
}

/**
 * Apply the same terminal-outcome precedence to local and container runners.
 * Cancellation and timeout are control-plane outcomes, so they win over any
 * diagnostic event. A successful terminal turn wins over earlier diagnostic
 * or failed-turn evidence when it is the later terminal event. A stream
 * without an explicit terminal event retains legacy message-plus-exit-0
 * compatibility.
 */
export function finalizeCodexRun(
  parsed: ParsedEvents,
  result: CodexProcessResult,
  messages: CodexTerminalMessages,
): RunnerResult {
  if (result.cancelled) {
    throw new RunCancelledError();
  }
  if (result.timedOut) {
    throw new Error(messages.timeout);
  }

  const output = parsed.messages.at(-1)?.trim();
  if (result.exitCode !== 0) {
    if (parsed.modelInferenceLimitExceeded) {
      throw new ModelInferenceLimitExceededError();
    }
    throw new Error(messages.exit);
  }

  if (
    parsed.lastTerminalEvent === "failed" ||
    (parsed.terminalFailure === true && parsed.turnCompleted !== true)
  ) {
    if (parsed.modelInferenceLimitExceeded) {
      throw new ModelInferenceLimitExceededError();
    }
    throw new Error("Codex reported a failed turn");
  }

  // A successful terminal response is authoritative. Codex can emit a
  // diagnostic error before the final turn.completed event, and that should
  // not turn an otherwise usable response into a failed Run.
  if (output) {
    return { output, threadId: parsed.threadId, usage: parsed.usage };
  }
  if (parsed.turnCompleted) {
    throw new Error(messages.missingTruncated && result.outputTruncated
      ? messages.missingTruncated
      : messages.missing);
  }
  throw new Error(result.outputTruncated ? messages.missingTruncated : messages.missing);
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
  mcpToolTimeoutSec = DEFAULT_MCP_TOOL_TIMEOUT_SEC,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  // A legacy/default Agent already gets its model from the trusted CODEX_HOME
  // config. Explicit assignments are passed per run so the same process can
  // safely serve Agents with different worker models. Never pass credentials
  // through argv; only the resolver-produced Codex model id is accepted here.
  if (request.model && !request.model.usesDefaultModel) {
    args.push("--model", request.model.codexModel);
  }
  if (request.mcp) {
    // Codex reads the token from a dedicated child environment variable. The
    // literal bearer token is intentionally absent from argv and config text.
    args.push(
      "-c",
      "mcp_servers.launchpad.url=" + JSON.stringify(request.mcp.url),
      "-c",
      "mcp_servers.launchpad.bearer_token_env_var=" +
        JSON.stringify(MCP_BEARER_TOKEN_ENV),
      "-c",
      "mcp_servers.launchpad.tool_timeout_sec=" +
        String(mcpToolTimeoutSec),
    );
  }
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

/** A provider counter is trusted only when it is a real non-negative count. */
function numericCounter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Sum one turn's counters into the run's running totals.
 *
 * A counter absent from every turn stays absent, so "the provider never
 * reported this" remains distinguishable from "the provider reported zero".
 */
function addTurnUsage(
  into: RunUsage | null,
  turn: {
    inputTokens: number | undefined;
    cachedInputTokens: number | undefined;
    cacheWriteInputTokens: number | undefined;
    outputTokens: number | undefined;
    reasoningOutputTokens: number | undefined;
  },
): RunUsage | null {
  const fields = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const;
  let total: RunUsage | null = into;
  for (const field of fields) {
    const value = turn[field];
    if (value === undefined) continue;
    total ??= {};
    total[field] = (total[field] ?? 0) + value;
  }
  return total;
}

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  observer?: RuntimeActionObserver,
): void {
  let event: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(line);
    if (!isJsonRecord(decoded)) return;
    event = decoded;
  } catch {
    return;
  }

  // The audit tap is passive evidence; a failure there must not cost us the
  // parse of this line.
  try {
    observer?.onEvent(event);
  } catch {
    // ignored
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    // Codex reports each turn.completed independently rather than as a running
    // total: on a resumed thread turn N carries that turn's own prompt, not the
    // sum of the turns before it. A single `codex exec` is normally one turn,
    // but when a run does produce several, the run's usage is their sum.
    parsed.usage = addTurnUsage(parsed.usage, {
      inputTokens: numericCounter(usage.input_tokens),
      cachedInputTokens: numericCounter(usage.cached_input_tokens),
      cacheWriteInputTokens: numericCounter(usage.cache_write_input_tokens),
      outputTokens: numericCounter(usage.output_tokens),
      reasoningOutputTokens: numericCounter(usage.reasoning_output_tokens),
    });
  }

  if (event.type === "turn.completed") {
    parsed.turnCompleted = true;
    parsed.lastTerminalEvent = "completed";
  }

  if (event.type === "turn.failed") {
    parsed.terminalFailure = true;
    parsed.lastTerminalEvent = "failed";
  }

  if (event.type === "error") {
    // Keep only a safe category. Provider messages may contain credentials,
    // request identifiers, prompts, or paths and are never useful to the
    // runner's terminal decision.
    parsed.errors.push("Codex reported an error");
  }

  if (
    (event.type === "error" || event.type === "turn.failed") &&
    eventHasProviderInferenceLimitCode(event)
  ) {
    parsed.modelInferenceLimitExceeded = true;
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<string, ChildProcessExecution>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Local processes do not expose a durable identity that can be adopted on
   * restart. Persisted active work therefore stays behind the startup safety
   * gate until an operator verifies it explicitly.
   */
  async reconcileStartup(
    input: RuntimeReconciliationInput,
  ): Promise<RuntimeReconciliationResult> {
    return reconcileLocalProcessStartup(input);
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    await active.cancel();
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(
      request,
      this.config.codexSandboxMode,
      request.workspacePath,
      this.config.mcpToolTimeoutSec,
    );
    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let forceKillTimer: NodeJS.Timeout | null = null;
    let execution: ChildProcessExecution;
    try {
      execution = startChildProcessExecution({
        command: this.config.codexBin,
        args,
        cwd: request.workspacePath,
        env: this.childEnvironment(request),
        timeoutMs: this.config.codexTimeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
        maxOutputBytes: this.config.codexMaxOutputBytes,
        startErrorMessage: "Codex could not start",
        onLine: (line) => parseCodexEventLine(line, parsed, request.observer),
        stop: (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          if (!forceKillTimer) {
            forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
            forceKillTimer.unref();
          }
        },
      });
    } catch (error) {
      // spawn() can fail before a child exists. This is the only runner-level
      // startup condition classified as safe for a model fallback.
      if (isControlError(error)) throw error;
      throw new RetryableModelError("Codex could not start", { cause: error });
    }
    this.active.set(request.agentId, execution);

    try {
      let result;
      try {
        // An `error` event here means Node could not create the child process;
        // it is still pre-execution and therefore safe to classify. Ordinary
        // non-zero exits below remain non-retryable.
        result = await execution.completed;
      } catch (error) {
        if (isControlError(error)) throw error;
        throw new RetryableModelError("Codex could not start", { cause: error });
      }
      return finalizeCodexRun(parsed, result, {
        timeout: "Codex timed out after " + this.config.codexTimeoutMs + " ms",
        exit: "Codex exited with code " + result.exitCode,
        missing: "Codex completed without an agent message",
        missingTruncated:
          "Codex completed without an agent message after an oversized event was dropped; raise CODEX_MAX_OUTPUT_BYTES",
      });
    } finally {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(request?: { mcp?: { token: string; traceparent?: string } }): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    if (request?.mcp) {
      environment[MCP_BEARER_TOKEN_ENV] = request.mcp.token;
      if (request.mcp.traceparent !== undefined) {
        environment.TRACEPARENT = request.mcp.traceparent;
      }
    }
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
