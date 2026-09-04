import { describe, expect, it } from "vitest";
import {
  createRuntimeActionObserver,
  type RuntimeActionObserver,
} from "../../../apps/server/src/audit/runtime-action-audit.js";
import {
  isSecretLikeFilename,
  programBasename,
  safeAuditInput,
} from "../../../apps/server/src/audit/audit-redaction.js";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRecorder,
} from "../../../apps/server/src/audit/audit-types.js";

class RecordingAudit implements AuditRecorder {
  readonly inputs: AuditEventInput[] = [];

  async record(input: AuditEventInput): Promise<AuditEvent> {
    this.inputs.push(input);
    return {} as AuditEvent;
  }

  ofType(type: AuditEventInput["type"]): AuditEventInput[] {
    return this.inputs.filter((input) => input.type === type);
  }
}

const parentSpan = { traceId: "trace-1", spanId: "span-run" };

function makeObserver(): {
  audit: RecordingAudit;
  observer: RuntimeActionObserver;
  advance: (ms: number) => void;
} {
  const audit = new RecordingAudit();
  let clock = 1_000;
  const observer = createRuntimeActionObserver({
    audit,
    runId: "run-1",
    agentId: "agent-1",
    parentSpan,
    now: () => clock,
    onError: () => undefined,
  });
  return { audit, observer, advance: (ms) => { clock += ms; } };
}

/** What would actually reach the store after redaction. */
function persisted(input: AuditEventInput): string {
  return JSON.stringify(safeAuditInput(input));
}

describe("runtime action observer", () => {
  it("records a completed sandbox command without the command text", () => {
    const { audit, observer, advance } = makeObserver();
    observer.onEvent({
      type: "item.started",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "bash -lc 'npm test'",
        status: "in_progress",
      },
    });
    advance(25);
    observer.onEvent({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "bash -lc 'npm test'",
        aggregated_output: "all good",
        exit_code: 0,
        status: "completed",
      },
    });

    const events = audit.ofType("sandbox_command");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.status).toBe("success");
    expect(event.durationMs).toBe(25);
    expect(event.span).toEqual({
      traceId: "trace-1",
      spanId: expect.any(String),
      parentSpanId: "span-run",
    });
    expect(event.metadata).toMatchObject({
      program: "npm",
      exitCode: 0,
      argCount: 3,
      stdoutBytes: 8,
    });
    expect(event.metadata?.commandHash).toMatch(/^[0-9a-f]{16}$/);

    const serialized = persisted(event);
    expect(serialized).not.toContain("npm test");
    expect(serialized).not.toContain("/workspace");
    expect(JSON.parse(serialized).metadata.program).toBe("npm");
  });

  it("marks a non-zero exit as a failure", () => {
    const { audit, observer } = makeObserver();
    observer.onEvent({
      type: "item.completed",
      item: {
        id: "item_9",
        type: "command_execution",
        command: "ls /nope",
        aggregated_output: "",
        exit_code: 2,
        status: "completed",
      },
    });

    const event = audit.ofType("sandbox_command")[0];
    expect(event?.status).toBe("failure");
    expect(event?.metadata).toMatchObject({ exitCode: 2, program: "ls" });
    expect(event?.durationMs).toBeUndefined();
  });

  it("emits an aggregate plus per-file events and hides secret-like filenames", () => {
    const { audit, observer } = makeObserver();
    observer.onEvent({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "file_change",
        changes: [
          { path: "/workspace/src/a.ts", kind: "add" },
          { path: "/workspace/.env", kind: "update" },
        ],
        status: "completed",
      },
    });

    const events = audit.ofType("workspace_file_change");
    expect(events).toHaveLength(3);
    expect(events[0]?.metadata).toEqual({
      fileCount: 2,
      added: 1,
      modified: 1,
      deleted: 0,
    });
    const source = events[1]!;
    const secret = events[2]!;
    expect(source.metadata).toMatchObject({ kind: "add", workspaceFile: "src/a.ts" });
    expect(secret.metadata?.pathHash).toMatch(/^[0-9a-f]{16}$/);
    expect(secret.metadata).not.toHaveProperty("workspaceFile");
    expect(JSON.parse(persisted(source)).metadata.workspaceFile).toBe("src/a.ts");
    expect(persisted(secret)).not.toContain(".env");
  });

  it("emits only the aggregate for a large change set", () => {
    const { audit, observer } = makeObserver();
    observer.onEvent({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "file_change",
        changes: Array.from({ length: 25 }, (_unused, index) => ({
          path: "/workspace/src/file" + index + ".ts",
          kind: "add",
        })),
        status: "completed",
      },
    });

    const events = audit.ofType("workspace_file_change");
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ fileCount: 25, added: 25 });
  });

  it("records an MCP tool call without its arguments", () => {
    const { audit, observer, advance } = makeObserver();
    observer.onEvent({
      type: "item.started",
      item: {
        id: "item_2",
        type: "mcp_tool_call",
        server: "launchpad",
        tool: "web_fetch",
        arguments: { url: "https://example.invalid/secret" },
        status: "in_progress",
      },
    });
    advance(11);
    observer.onEvent({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "mcp_tool_call",
        server: "launchpad",
        tool: "web_fetch",
        arguments: { url: "https://example.invalid/secret" },
        result: { body: "secret body" },
        status: "completed",
      },
    });

    const event = audit.ofType("mcp_tool_call")[0]!;
    expect(event.status).toBe("success");
    expect(event.durationMs).toBe(11);
    expect(event.metadata).toMatchObject({
      server: "launchpad",
      toolId: "web_fetch",
      itemStatus: "completed",
    });
    expect(event.metadata?.argHash).toMatch(/^[0-9a-f]{16}$/);
    const serialized = persisted(event);
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("secret body");
  });

  it("reports a failed MCP tool call as a failure", () => {
    const { audit, observer } = makeObserver();
    observer.onEvent({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "mcp_tool_call",
        server: "launchpad",
        tool: "web_fetch",
        status: "failed",
        error: { message: "boom while reading token" },
      },
    });

    const event = audit.ofType("mcp_tool_call")[0]!;
    expect(event.status).toBe("failure");
    expect(persisted(event)).not.toContain("boom");
  });

  it("summarises a turn with item counters and usage", () => {
    const { audit, observer, advance } = makeObserver();
    observer.onEvent({ type: "turn.started" });
    observer.onEvent({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "x" } });
    observer.onEvent({ type: "item.completed", item: { id: "r2", type: "reasoning", text: "y" } });
    observer.onEvent({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "z" } });
    observer.onEvent({
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "ls", exit_code: 0 },
    });
    advance(500);
    observer.onEvent({
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
    });

    expect(audit.ofType("model_turn")).toHaveLength(1);
    const event = audit.ofType("model_turn")[0]!;
    expect(event.status).toBe("success");
    expect(event.durationMs).toBe(500);
    expect(event.metadata).toMatchObject({
      reasoningItems: 2,
      messageItems: 1,
      commandItems: 1,
      fileChangeItems: 0,
      mcpToolItems: 0,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    const safe = safeAuditInput(event).metadata;
    expect(safe).toMatchObject({
      reasoningItems: 2,
      messageItems: 1,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
  });

  it("records a failed turn without the error text", () => {
    const { audit, observer } = makeObserver();
    observer.onEvent({ type: "turn.started" });
    observer.onEvent({ type: "item.completed", item: { id: "r1", type: "reasoning" } });
    observer.onEvent({
      type: "turn.failed",
      error: { message: "model refused the prompt" },
    });

    const event = audit.ofType("model_turn")[0]!;
    expect(event.status).toBe("failure");
    expect(event.metadata).toMatchObject({ reasoningItems: 1, messageItems: 0 });
    expect(event.metadata).not.toHaveProperty("inputTokens");
    expect(persisted(event)).not.toContain("refused");
  });

  it("resets counters between turns", () => {
    const { audit, observer } = makeObserver();
    observer.onEvent({ type: "turn.started" });
    observer.onEvent({ type: "item.completed", item: { id: "r1", type: "reasoning" } });
    observer.onEvent({ type: "turn.completed" });
    observer.onEvent({ type: "turn.started" });
    observer.onEvent({ type: "turn.completed" });

    expect(audit.ofType("model_turn")[1]?.metadata).toMatchObject({ reasoningItems: 0 });
  });

  it("ignores malformed events without throwing", () => {
    const { audit, observer } = makeObserver();
    const malformed: unknown[] = [
      null,
      undefined,
      "not an object",
      42,
      [],
      {},
      { type: 7 },
      { type: "item.completed" },
      { type: "item.completed", item: "nope" },
      { type: "item.completed", item: [1, 2] },
      { type: "item.completed", item: { id: 5, type: 9 } },
      { type: "item.started", item: { type: "command_execution" } },
      { type: "some.unknown.event", item: { type: "command_execution" } },
    ];
    for (const event of malformed) {
      expect(() => observer.onEvent(event as Record<string, unknown>)).not.toThrow();
    }

    expect(audit.inputs).toHaveLength(0);
  });
});

describe("programBasename", () => {
  it.each([
    ["ls -la", "ls"],
    ["FOO=1 /usr/bin/python3 x.py", "python3"],
    ['bash -lc "cd /tmp && rm -rf x"', "cd"],
    ["sh -c 'git status'", "git"],
    ["C:\\tools\\node.exe a.js", "node"],
    ["", "unknown"],
  ])("maps %j to %j", (command, expected) => {
    expect(programBasename(command)).toBe(expected);
  });

  it("returns unknown for a non-string command", () => {
    expect(programBasename(undefined)).toBe("unknown");
    expect(programBasename(42)).toBe("unknown");
  });
});

describe("isSecretLikeFilename", () => {
  it("flags credential-shaped filenames only", () => {
    expect(isSecretLikeFilename("/workspace/.env")).toBe(true);
    expect(isSecretLikeFilename("/workspace/.env.local")).toBe(true);
    expect(isSecretLikeFilename("/workspace/certs/server.pem")).toBe(true);
    expect(isSecretLikeFilename("/workspace/id_rsa")).toBe(true);
    expect(isSecretLikeFilename("/workspace/.npmrc")).toBe(true);
    expect(isSecretLikeFilename("/workspace/src/a.ts")).toBe(false);
  });
});
