import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../apps/server/src/config.js";
import {
  CodexRunner,
  finalizeCodexRun,
  parseCodexEventLine,
  type ParsedEvents,
} from "../../apps/server/src/codex-runner.js";

const childProcessMock = vi.hoisted(() => ({ next: [] as unknown[] }));

vi.mock("../../apps/server/src/child-process-execution.js", () => ({
  startChildProcessExecution: () => {
    const next = childProcessMock.next.shift();
    if (next instanceof Error) throw next;
    return next;
  },
}));

function emptyParsed(): ParsedEvents {
  return { messages: [], threadId: null, usage: null, errors: [] };
}

describe("parseCodexEventLine observer tap", () => {
  it("forwards each parsed event to the observer", () => {
    const seen: Record<string, unknown>[] = [];
    const parsed = emptyParsed();
    parseCodexEventLine('{"type":"thread.started","thread_id":"t1"}', parsed, {
      onEvent: (event) => seen.push(event),
    });
    parseCodexEventLine(
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi"}}',
      parsed,
      { onEvent: (event) => seen.push(event) },
    );

    expect(seen.map((event) => event.type)).toEqual([
      "thread.started",
      "item.completed",
    ]);
    expect(parsed.threadId).toBe("t1");
    expect(parsed.messages).toEqual(["hi"]);
  });

  it("does not call the observer for an unparsable line", () => {
    let calls = 0;
    parseCodexEventLine("not json", emptyParsed(), {
      onEvent: () => {
        calls += 1;
      },
    });

    expect(calls).toBe(0);
  });

  it("keeps parsing when the observer throws", () => {
    const parsed = emptyParsed();
    expect(() =>
      parseCodexEventLine(
        '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi"}}',
        parsed,
        {
          onEvent: () => {
            throw new Error("observer exploded");
          },
        },
      ),
    ).not.toThrow();

    expect(parsed.messages).toEqual(["hi"]);
  });
});

const terminalMessages = {
  timeout: "timed out",
  exit: "exited",
  missing: "missing output",
  missingTruncated: "missing output after truncation",
};

function controlError(name: "AbortError" | "TimeoutError"): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("Codex terminal failure classification", () => {
  it("preserves runner cancellation and deadline errors before model fallback", async () => {
    childProcessMock.next.length = 0;
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
    });
    const request = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      prompt: "count from 1 to 10",
      threadId: null,
    };
    const startupTimeout = controlError("TimeoutError");
    childProcessMock.next.push(startupTimeout);

    await expect(new CodexRunner(config).run(request)).rejects.toBe(startupTimeout);

    let rejectCompleted!: (error: unknown) => void;
    childProcessMock.next.push({
      completed: new Promise<never>((_resolve, reject) => {
        rejectCompleted = reject;
      }),
      settled: Promise.resolve(),
      cancel: async () => {},
    });
    const completion = new CodexRunner(config).run(request);
    const cancellation = controlError("AbortError");
    rejectCompleted(cancellation);

    await expect(completion).rejects.toBe(cancellation);
  });

  it("classifies the exact provider code from an error event", () => {
    const parsed = emptyParsed();
    parseCodexEventLine(
      '{"type":"error","error":{"code":"SetLimitExceeded","message":"request-id and secret"}}',
      parsed,
    );

    expect(() =>
      finalizeCodexRun(
        parsed,
        { exitCode: 1, cancelled: false, timedOut: false, outputTruncated: false },
        terminalMessages,
      ),
    ).toThrowError(
      expect.objectContaining({
        errorCode: "MODEL_INFERENCE_LIMIT_EXCEEDED",
        message: expect.stringContaining("provider inference limit was reached"),
      }),
    );
    expect(parsed.errors).toEqual(["Codex reported an error"]);
  });

  it("reads the provider code from turn.failed.error but not generic 429 text", () => {
    const parsed = emptyParsed();
    parseCodexEventLine(
      '{"type":"turn.failed","error":{"message":"{\\"code\\":\\"SetLimitExceeded\\"}"}}',
      parsed,
    );
    expect(parsed.modelInferenceLimitExceeded).toBe(true);

    const generic429 = emptyParsed();
    parseCodexEventLine(
      '{"type":"error","message":"HTTP 429 TooManyRequests"}',
      generic429,
    );
    expect(generic429.modelInferenceLimitExceeded).toBeUndefined();
    expect(() =>
      finalizeCodexRun(
        generic429,
        { exitCode: 1, cancelled: false, timedOut: false, outputTruncated: false },
        terminalMessages,
      ),
    ).toThrow("exited");
  });

  it("lets a successful response win over a transient provider error", () => {
    const parsed = emptyParsed();
    parseCodexEventLine(
      '{"type":"error","error":{"code":"SetLimitExceeded"}}',
      parsed,
    );
    parseCodexEventLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      parsed,
    );
    parseCodexEventLine('{"type":"turn.completed"}', parsed);

    expect(
      finalizeCodexRun(
        parsed,
        { exitCode: 0, cancelled: false, timedOut: false, outputTruncated: false },
        terminalMessages,
      ),
    ).toEqual({ output: "done", threadId: null, usage: null });
  });

  it("rejects a partial message when Codex reports turn.failed on exit 0", () => {
    const parsed = emptyParsed();
    parseCodexEventLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}',
      parsed,
    );
    parseCodexEventLine(
      '{"type":"turn.failed","error":{"message":"provider unavailable"}}',
      parsed,
    );

    expect(() =>
      finalizeCodexRun(
        parsed,
        { exitCode: 0, cancelled: false, timedOut: false, outputTruncated: false },
        terminalMessages,
      ),
    ).toThrow("failed turn");
  });

  it("allows a diagnostic followed by a completed turn on exit 0", () => {
    const parsed = emptyParsed();
    parseCodexEventLine(
      '{"type":"error","message":"transient diagnostic"}',
      parsed,
    );
    parseCodexEventLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      parsed,
    );
    parseCodexEventLine('{"type":"turn.completed"}', parsed);

    expect(
      finalizeCodexRun(
        parsed,
        { exitCode: 0, cancelled: false, timedOut: false, outputTruncated: false },
        terminalMessages,
      ),
    ).toEqual({ output: "done", threadId: null, usage: null });
  });

  it("keeps cancellation and timeout ahead of provider failure evidence", () => {
    const parsed = emptyParsed();
    parsed.modelInferenceLimitExceeded = true;

    expect(() =>
      finalizeCodexRun(
        parsed,
        { exitCode: 130, cancelled: true, timedOut: false, outputTruncated: false },
        terminalMessages,
      ),
    ).toThrow("Run cancelled");
    expect(() =>
      finalizeCodexRun(
        parsed,
        { exitCode: 1, cancelled: false, timedOut: true, outputTruncated: false },
        terminalMessages,
      ),
    ).toThrow("timed out");
  });
});
