import { spawn, type ChildProcess } from "node:child_process";
import { safeRuntimeError } from "./safe-runtime-error.js";

export type ChildProcessStopReason =
  | "cancelled"
  | "timed-out"
  | "output-exceeded";

export interface ChildProcessExecutionOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  startErrorMessage: string;
  onLine: (line: string) => void;
  stop: (
    child: ChildProcess,
    reason: ChildProcessStopReason,
  ) => Promise<void> | void;
}

export interface ChildProcessExecutionResult {
  exitCode: number;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
}

export interface ChildProcessExecution {
  readonly settled: Promise<void>;
  readonly completed: Promise<ChildProcessExecutionResult>;
  cancel(): Promise<void>;
}

/**
 * Owns the lifecycle shared by local and container-backed Codex processes.
 * The caller supplies only command construction, environment, output parsing,
 * and resource-specific termination. Stderr is counted but never retained.
 */
export function startChildProcessExecution(
  options: ChildProcessExecutionOptions,
): ChildProcessExecution {
  let child: ChildProcess;
  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(safeRuntimeError(error, options.startErrorMessage));
  }

  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill();
    throw new Error(options.startErrorMessage);
  }

  let stdoutBuffer = "";
  let totalBytes = 0;
  let cancelled = false;
  let timedOut = false;
  let outputExceeded = false;
  let stopPromise: Promise<void> | null = null;
  let timeout: NodeJS.Timeout | null = null;

  const clearExecutionTimeout = () => {
    if (!timeout) return;
    clearTimeout(timeout);
    timeout = null;
  };

  const settled = new Promise<void>((resolve) => {
    child.once("close", () => {
      clearExecutionTimeout();
      resolve();
    });
    child.once("error", () => {
      clearExecutionTimeout();
      resolve();
    });
  });

  const requestStop = (reason: ChildProcessStopReason): Promise<void> => {
    if (!stopPromise) {
      try {
        stopPromise = Promise.resolve(options.stop(child, reason)).catch(
          () => undefined,
        );
      } catch {
        stopPromise = Promise.resolve();
      }
    }
    return stopPromise;
  };

  const consume = (chunk: Buffer | string, target: "stdout" | "stderr") => {
    totalBytes +=
      typeof chunk === "string"
        ? Buffer.byteLength(chunk, "utf8")
        : chunk.byteLength;
    if (totalBytes > options.maxOutputBytes) {
      outputExceeded = true;
      void requestStop("output-exceeded");
      return;
    }

    if (target !== "stdout") return;

    stdoutBuffer +=
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) options.onLine(line);
  };

  stdout.on("data", (chunk: Buffer | string) => consume(chunk, "stdout"));
  stderr.on("data", (chunk: Buffer | string) => consume(chunk, "stderr"));

  timeout = setTimeout(() => {
    timedOut = true;
    void requestStop("timed-out");
  }, options.timeoutMs);
  timeout.unref();

  const completed = new Promise<ChildProcessExecutionResult>(
    (resolve, reject) => {
      child.once("error", (error) => {
        reject(
          new Error(safeRuntimeError(error, options.startErrorMessage)),
        );
      });
      child.once("close", (code) => {
        if (stdoutBuffer.trim()) options.onLine(stdoutBuffer.trim());
        resolve({
          exitCode: code ?? 1,
          cancelled,
          timedOut,
          outputExceeded,
        });
      });
    },
  );

  return {
    settled,
    completed,
    async cancel(): Promise<void> {
      cancelled = true;
      await requestStop("cancelled");
      await settled;
    },
  };
}
