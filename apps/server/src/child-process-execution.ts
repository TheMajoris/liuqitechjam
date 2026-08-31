import { spawn, type ChildProcess } from "node:child_process";
import { safeRuntimeError } from "./safe-runtime-error.js";

export type ChildProcessStopReason = "cancelled" | "timed-out";

export interface ChildProcessExecutionOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /**
   * Largest single un-terminated stdout line the parent will hold. This is a
   * retention bound, not a throughput budget: the child may stream far more
   * than this in total, because everything before the last newline is parsed
   * and released rather than kept.
   */
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
  /** At least one oversized stdout line was dropped before parsing. */
  outputTruncated: boolean;
}

export interface ChildProcessExecution {
  readonly settled: Promise<void>;
  readonly completed: Promise<ChildProcessExecutionResult>;
  cancel(): Promise<void>;
}

/**
 * Owns the lifecycle shared by local and container-backed Codex processes.
 * The caller supplies only command construction, environment, output parsing,
 * and resource-specific termination.
 *
 * Stdout is parsed line by line and released, so total volume is bounded by
 * `timeoutMs` rather than by a byte budget: `codex exec --json` echoes the
 * full output of every command the Agent runs back through the event stream,
 * and a turn that streams a lot is not a turn that retained a lot. The only
 * way the child can grow the parent without bound is one enormous line with
 * no newline, so that is what `maxOutputBytes` bounds. Stderr is never
 * retained and therefore never counted.
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
  let cancelled = false;
  let timedOut = false;
  let outputTruncated = false;
  let droppingOversizedLine = false;
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
    if (target !== "stdout") return;

    stdoutBuffer +=
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (droppingOversizedLine) {
        // The tail of a line already dropped below. Resynchronize on the
        // newline rather than parsing a fragment of truncated JSON.
        droppingOversizedLine = false;
        continue;
      }
      options.onLine(line);
    }
    if (Buffer.byteLength(stdoutBuffer, "utf8") > options.maxOutputBytes) {
      // Drop only the offending line. A run whose final agent message
      // survives is still a usable run, so this never fails the process.
      stdoutBuffer = "";
      droppingOversizedLine = true;
      outputTruncated = true;
    }
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
        if (!droppingOversizedLine && stdoutBuffer.trim()) {
          options.onLine(stdoutBuffer.trim());
        }
        resolve({
          exitCode: code ?? 1,
          cancelled,
          timedOut,
          outputTruncated,
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
