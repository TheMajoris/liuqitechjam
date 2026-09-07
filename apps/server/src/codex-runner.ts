import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  startChildProcessExecution,
  type ChildProcessExecution,
} from "./child-process-execution.js";
import type { AppConfig } from "./config.js";
import {
  ModelInferenceLimitExceededError,
  RetryableModelError,
  RunCancelledError,
} from "./errors.js";
import { MCP_BEARER_TOKEN_ENV } from "./tools/mcp-session-service.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
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
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * diagnostic event. A successful terminal turn wins over an earlier error
 * event; provider-limit evidence is considered only for a failed turn.
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
    );
  }
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
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
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "turn.completed") {
    parsed.turnCompleted = true;
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

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
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
