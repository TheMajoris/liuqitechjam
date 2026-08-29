import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import { PreviewError } from "./preview-errors.js";
import type {
  PreviewLogResult,
  PreviewRuntime,
  PreviewRuntimeHandle,
  PreviewRuntimeStatus,
  PreviewStartInput,
} from "./preview-types.js";

const execFileAsync = promisify(execFile);
const PREVIEW_COMMAND_TIMEOUT_MS = 15_000;
const PREVIEW_LOG_MAX_BYTES = 64 * 1024;

function safeName(value: string, maxLength: number): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, maxLength) || "preview";
}

export function previewContainerName(previewId: string, instanceId = "default"): string {
  return "launchpad-preview-" + safeName(instanceId, 32) + "-" + safeName(previewId, 48);
}

function runtimeError(
  code: "PREVIEW_RUNTIME_UNAVAILABLE" | "PREVIEW_START_FAILED" | "PREVIEW_STOP_FAILED" | "PREVIEW_LOGS_FAILED",
  message: string,
  cause?: unknown,
): PreviewError {
  return new PreviewError(
    code,
    code === "PREVIEW_RUNTIME_UNAVAILABLE" ? 503 : 500,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isUnavailable(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException;
  const message = error instanceof Error ? error.message : String(error);
  return candidate.code === "ENOENT" ||
    /cannot connect|is not running|daemon|socket|machine is not running/i.test(message);
}

function assertArgv(command: readonly string[]): void {
  if (
    command.length === 0 ||
    command.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\0"))
  ) {
    throw new PreviewError(
      "PREVIEW_START_FAILED",
      500,
      "The resolved preview command is invalid",
    );
  }
}

function assertWorkspacePath(workspacePath: string): void {
  if (!path.isAbsolute(workspacePath) || workspacePath.includes("\0")) {
    throw new PreviewError(
      "PREVIEW_WORKSPACE_INVALID",
      422,
      "The Agent workspace path is invalid",
    );
  }
}

function buildPreviewResourceArgs(input: PreviewStartInput): string[] {
  const limits = input.resourceLimits;
  if (
    !Number.isFinite(limits.memoryMb) || limits.memoryMb <= 0 ||
    !Number.isFinite(limits.cpus) || limits.cpus <= 0 ||
    !Number.isInteger(limits.pids) || limits.pids <= 0
  ) {
    throw new PreviewError("PREVIEW_START_FAILED", 500, "Preview resource limits are invalid");
  }
  return [
    "--cpus",
    String(limits.cpus),
    "--memory",
    String(Math.ceil(limits.memoryMb)) + "m",
    "--pids-limit",
    String(limits.pids),
  ];
}

/**
 * Build a detached, localhost-bound container invocation. Values that can
 * affect the host are all supplied by the trusted PreviewService/config
 * boundary; command remains argv and is never joined into a shell string.
 */
export function buildPreviewContainerRunArgs(
  input: PreviewStartInput,
  config: AppConfig,
): string[] {
  assertWorkspacePath(input.workspacePath);
  assertArgv(input.command);
  if (!Number.isInteger(input.containerPort) || input.containerPort < 1 || input.containerPort > 65_535) {
    throw new PreviewError("PREVIEW_START_FAILED", 500, "The preview container port is invalid");
  }
  if (
    input.hostPort !== undefined &&
    (!Number.isInteger(input.hostPort) || input.hostPort < 1 || input.hostPort > 65_535)
  ) {
    throw new PreviewError("PREVIEW_START_FAILED", 500, "The preview host port is invalid");
  }

  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const name = previewContainerName(input.previewId, config.runtimeInstanceId);
  const hostPort = input.hostPort === undefined ? "" : String(input.hostPort);
  return [
    "run",
    "--detach",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=preview-runtime",
    "--label",
    "io.codejam.agent-id=" + input.agentId,
    "--label",
    "io.codejam.preview-id=" + input.previewId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    ...buildPreviewResourceArgs(input),
    "--user",
    config.containerUser,
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + input.workspacePath + ",dst=/workspace" +
      (input.workspaceReadOnly === true ? ",readonly" : ""),
    "--workdir",
    "/workspace",
    "--publish",
    "127.0.0.1:" + hostPort + ":" + input.containerPort,
    config.containerRuntimeImage,
    ...input.command,
  ];
}

function parsePublishedPort(value: string): number | null {
  const match = value.match(/127\.0\.0\.1:(\d+)/) ?? value.match(/:(\d+)->/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export class LocalContainerPreviewRuntime implements PreviewRuntime {
  constructor(private readonly config: AppConfig) {}

  async start(input: PreviewStartInput): Promise<PreviewRuntimeHandle> {
    const args = buildPreviewContainerRunArgs(input, this.config);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.config.containerEngine, args, {
        cwd: input.workspacePath,
        env: this.childEnvironment(),
        timeout: PREVIEW_COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
      }));
    } catch (error) {
      throw runtimeError(
        isUnavailable(error) ? "PREVIEW_RUNTIME_UNAVAILABLE" : "PREVIEW_START_FAILED",
        isUnavailable(error)
          ? "The local preview container engine is unavailable"
          : "The preview container could not be started",
        error,
      );
    }

    const runtimeId = stdout.trim() || previewContainerName(input.previewId, this.config.runtimeInstanceId);
    let hostPort = input.hostPort ?? null;
    if (hostPort === null) {
      try {
        const portResult = await execFileAsync(
          this.config.containerEngine,
          ["port", runtimeId, String(input.containerPort) + "/tcp"],
          { env: this.childEnvironment(), timeout: PREVIEW_COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 },
        );
        hostPort = parsePublishedPort(portResult.stdout);
      } catch {
        hostPort = null;
      }
    }
    if (hostPort === null) {
      await this.stop({ runtimeId, hostPort: 1, containerPort: input.containerPort }).catch(() => undefined);
      throw runtimeError("PREVIEW_START_FAILED", "The preview container did not expose a host port");
    }
    return { runtimeId, hostPort, containerPort: input.containerPort };
  }

  async stop(handle: PreviewRuntimeHandle): Promise<void> {
    if (!handle.runtimeId) return;
    try {
      await execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", handle.runtimeId],
        { env: this.childEnvironment(), timeout: PREVIEW_COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such object|not found|does not exist/i.test(message)) return;
      throw runtimeError(
        isUnavailable(error) ? "PREVIEW_RUNTIME_UNAVAILABLE" : "PREVIEW_STOP_FAILED",
        isUnavailable(error)
          ? "The local preview container engine is unavailable"
          : "The preview container could not be stopped",
        error,
      );
    }
  }

  async status(handle: PreviewRuntimeHandle): Promise<PreviewRuntimeStatus> {
    try {
      const result = await execFileAsync(
        this.config.containerEngine,
        ["inspect", "--format", "{{.State.Status}}", handle.runtimeId],
        { env: this.childEnvironment(), timeout: PREVIEW_COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 },
      );
      const state = result.stdout.trim().toLowerCase();
      if (state === "running") return "running";
      if (state === "created" || state === "restarting" || state === "paused") return "starting";
      if (state === "exited" || state === "dead") return "failed";
      return "unknown";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such object|not found|does not exist/i.test(message)) return "stopped";
      throw runtimeError(
        isUnavailable(error) ? "PREVIEW_RUNTIME_UNAVAILABLE" : "PREVIEW_START_FAILED",
        isUnavailable(error)
          ? "The local preview container engine is unavailable"
          : "The preview container status could not be read",
        error,
      );
    }
  }

  async logs(handle: PreviewRuntimeHandle, options: { tail?: number } = {}): Promise<PreviewLogResult> {
    const requestedTail = options.tail ?? 100;
    const tail = Number.isInteger(requestedTail) ? Math.min(Math.max(requestedTail, 1), 200) : 100;
    try {
      const result = await execFileAsync(
        this.config.containerEngine,
        ["logs", "--tail", String(tail), handle.runtimeId],
        { env: this.childEnvironment(), timeout: PREVIEW_COMMAND_TIMEOUT_MS, maxBuffer: PREVIEW_LOG_MAX_BYTES },
      );
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const bounded = combined.length > PREVIEW_LOG_MAX_BYTES
        ? combined.slice(-PREVIEW_LOG_MAX_BYTES)
        : combined;
      return {
        lines: bounded.split(/\r?\n/).filter((line) => line.length > 0).slice(-tail),
        truncated: bounded.length < combined.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such object|not found|does not exist/i.test(message)) {
        return { lines: [], truncated: false };
      }
      throw runtimeError(
        isUnavailable(error) ? "PREVIEW_RUNTIME_UNAVAILABLE" : "PREVIEW_LOGS_FAILED",
        isUnavailable(error)
          ? "The local preview container engine is unavailable"
          : "Preview logs could not be read",
        error,
      );
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR"] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}

/** Cheap read-only check used by the service before a container is requested. */
export async function isDirectory(workspacePath: string): Promise<boolean> {
  try {
    return (await stat(workspacePath)).isDirectory();
  } catch {
    return false;
  }
}
