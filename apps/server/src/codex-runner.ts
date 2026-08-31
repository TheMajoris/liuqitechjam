import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  startChildProcessExecution,
  type ChildProcessExecution,
} from "./child-process-execution.js";
import type { AppConfig } from "./config.js";
import { RetryableModelError, RunCancelledError } from "./errors.js";
import { MCP_BEARER_TOKEN_ENV } from "./tools/mcp-session-service.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
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

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
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

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
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
        onLine: (line) => parseCodexEventLine(line, parsed),
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
      if (result.cancelled) {
        throw new RunCancelledError();
      }
      if (result.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (result.exitCode !== 0) {
        throw new Error("Codex exited with code " + result.exitCode);
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
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
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
