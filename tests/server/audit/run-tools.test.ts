import { describe, expect, it } from "vitest";
import { summarizeRunTools } from "../../../apps/server/src/audit/run-tools.js";
import type { AuditEvent } from "../../../apps/server/src/audit/audit-types.js";

let sequence = 0;

/** A minimally complete persisted event; only the fields tool naming reads. */
function event(partial: Partial<AuditEvent> & Pick<AuditEvent, "type">): AuditEvent {
  sequence += 1;
  return {
    id: "event-" + sequence,
    status: "success",
    summary: partial.type,
    createdAt: new Date(1_700_000_000_000 + sequence).toISOString(),
    principal: { kind: "agent", id: "agent-1" },
    metadata: {},
    traceId: "trace-1",
    spanId: "span-" + sequence,
    sequence,
    actorType: "agent",
    category: "tool_call",
    runId: "run-1",
    ...partial,
  } as AuditEvent;
}

describe("what a Run called", () => {
  it("names the tool from the resource it acted on", () => {
    const tools = summarizeRunTools([
      event({ type: "tool_started", resource: { kind: "tool", id: "read_file" } }),
      event({ type: "tool_succeeded", resource: { kind: "tool", id: "read_file" } }),
    ]);

    // The outcome event reports the same call the start already counted.
    expect(tools.calls).toBe(1);
    expect(tools.names).toEqual([{ name: "read_file", calls: 1, failed: 0 }]);
  });

  it("counts one call when the runtime and the server both record it", () => {
    const tools = summarizeRunTools([
      event({ type: "mcp_tool_call", metadata: { toolId: "read_file" } }),
      event({ type: "tool_started", resource: { kind: "tool", id: "read_file" } }),
      event({ type: "tool_succeeded", resource: { kind: "tool", id: "read_file" } }),
    ]);

    expect(tools.calls).toBe(1);
    expect(tools.names).toEqual([{ name: "read_file", calls: 1, failed: 0 }]);
  });

  it("reconciles regardless of which record the log holds first", () => {
    const serverFirst = summarizeRunTools([
      event({ type: "tool_started", resource: { kind: "tool", id: "read_file" } }),
      event({ type: "mcp_tool_call", metadata: { toolId: "read_file" } }),
    ]);
    const runtimeFirst = summarizeRunTools([
      event({ type: "mcp_tool_call", metadata: { toolId: "read_file" } }),
      event({ type: "tool_started", resource: { kind: "tool", id: "read_file" } }),
    ]);

    expect(serverFirst).toEqual(runtimeFirst);
    expect(serverFirst.calls).toBe(1);
  });

  it("keeps a runtime-only call that the server never recorded", () => {
    const tools = summarizeRunTools([
      event({ type: "tool_started", resource: { kind: "tool", id: "read_file" } }),
      event({ type: "mcp_tool_call", metadata: { toolId: "read_file" } }),
      event({ type: "mcp_tool_call", metadata: { toolId: "write_file" } }),
    ]);

    expect(tools.calls).toBe(2);
    expect(tools.names.map((tool) => tool.name).sort()).toEqual(["read_file", "write_file"]);
  });

  it("names the failing tool rather than only counting the failure", () => {
    const tools = summarizeRunTools([
      event({ type: "tool_started", resource: { kind: "tool", id: "write_file" } }),
      event({
        type: "tool_failed",
        status: "failure",
        resource: { kind: "tool", id: "write_file" },
      }),
    ]);

    expect(tools.calls).toBe(1);
    expect(tools.names).toEqual([{ name: "write_file", calls: 1, failed: 1 }]);
  });

  it("counts sandbox commands apart from tool calls and names the programs", () => {
    const tools = summarizeRunTools([
      event({ type: "sandbox_command", category: "sandbox_execution", metadata: { program: "rg" } }),
      event({ type: "sandbox_command", category: "sandbox_execution", metadata: { program: "rg" } }),
      event({ type: "sandbox_command", category: "sandbox_execution", metadata: { program: "ls" } }),
      event({ type: "skill_invoked", metadata: { skillId: "tdd" } }),
    ]);

    expect(tools.sandboxCommands).toBe(3);
    expect(tools.calls).toBe(1);
    // Busiest first, so a Run's dominant act is the one a cell has room for.
    expect(tools.names).toEqual([
      { name: "$ rg", calls: 2, failed: 0 },
      { name: "$ ls", calls: 1, failed: 0 },
      { name: "tdd", calls: 1, failed: 0 },
    ]);
  });

  it("reports nothing for a Run that only talked to the model", () => {
    const tools = summarizeRunTools([
      event({ type: "run_started", category: "model_call" }),
      event({ type: "model_turn", category: "model_call" }),
      event({ type: "run_completed", category: "model_call" }),
    ]);

    expect(tools).toEqual({ calls: 0, sandboxCommands: 0, names: [] });
  });
});
