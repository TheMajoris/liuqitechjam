import { describe, expect, it } from "vitest";
import {
  startChildProcessExecution,
  type ChildProcessExecutionResult,
} from "../../apps/server/src/child-process-execution.js";

/**
 * Drives a real child process so the stdout framing, the retention bound and
 * the close-time flush are all exercised together.
 */
function runNodeScript(
  script: string,
  maxOutputBytes: number,
): { lines: string[]; completed: Promise<ChildProcessExecutionResult> } {
  const lines: string[] = [];
  const execution = startChildProcessExecution({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 30_000,
    maxOutputBytes,
    startErrorMessage: "could not start",
    onLine: (line) => {
      if (line.trim()) lines.push(line);
    },
    stop: (child) => {
      child.kill("SIGKILL");
    },
  });
  return { lines, completed: execution.completed };
}

describe("startChildProcessExecution", () => {
  it("parses a stream far larger than the retention bound", async () => {
    // The bound is per line, so 400 KB of framed output survives a 64 KB
    // bound. Codex echoes every command's output through its event stream,
    // and that volume must not fail an otherwise healthy turn.
    const { lines, completed } = runNodeScript(
      `for (let i = 0; i < 4000; i++) process.stdout.write(JSON.stringify({ i, pad: "x".repeat(80) }) + "\\n");
       process.stdout.write(JSON.stringify({ type: "agent_message" }) + "\\n");`,
      65_536,
    );

    const result = await completed;
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(false);
    expect(lines).toHaveLength(4001);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ type: "agent_message" });
  });

  it("drops only the oversized line and still parses what follows it", async () => {
    const { lines, completed } = runNodeScript(
      `process.stdout.write(JSON.stringify({ type: "first" }) + "\\n");
       process.stdout.write(JSON.stringify({ type: "huge", output: "y".repeat(300_000) }) + "\\n");
       process.stdout.write(JSON.stringify({ type: "agent_message" }) + "\\n");`,
      65_536,
    );

    const result = await completed;
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    // The huge line is gone; neither neighbour is lost and no fragment of
    // truncated JSON is handed to the parser.
    expect(lines.map((line) => JSON.parse(line).type)).toEqual([
      "first",
      "agent_message",
    ]);
  });

  it("never emits a fragment of a dropped line that ends without a newline", async () => {
    const { lines, completed } = runNodeScript(
      `process.stdout.write(JSON.stringify({ type: "first" }) + "\\n");
       process.stdout.write(JSON.stringify({ type: "huge", output: "y".repeat(300_000) }));`,
      65_536,
    );

    const result = await completed;
    expect(result.outputTruncated).toBe(true);
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["first"]);
  });

  it("flushes a trailing line that was never newline-terminated", async () => {
    const { lines, completed } = runNodeScript(
      `process.stdout.write(JSON.stringify({ type: "agent_message" }));`,
      65_536,
    );

    await expect(completed).resolves.toMatchObject({ outputTruncated: false });
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["agent_message"]);
  });

  it("ignores stderr volume, which is never retained", async () => {
    const { lines, completed } = runNodeScript(
      `process.stderr.write("z".repeat(400_000));
       process.stdout.write(JSON.stringify({ type: "agent_message" }) + "\\n");`,
      65_536,
    );

    const result = await completed;
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(false);
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["agent_message"]);
  });
});
