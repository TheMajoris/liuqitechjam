import { describe, expect, it } from "vitest";
import {
  resolveActiveTools,
  resolveStation,
  stationForTool,
} from "../../../apps/web/src/workspace/workspace-adapter";
import type { AuditEventRecord } from "../../../apps/web/src/types";

function event(
  overrides: Partial<AuditEventRecord> & Pick<AuditEventRecord, "id" | "type">,
): AuditEventRecord {
  return {
    status: "success",
    summary: "",
    createdAt: "2026-08-31T10:00:00.000Z",
    ...overrides,
  } as AuditEventRecord;
}

describe("stationForTool", () => {
  it("sends web tools to the library and preview tools to the server nook", () => {
    expect(stationForTool("web.search")).toBe("library");
    expect(stationForTool("web.fetch")).toBe("library");
    expect(stationForTool("project.preview.inspect")).toBe("server");
    expect(stationForTool("project.preview.restart")).toBe("server");
  });

  it("returns null for a tool it does not know", () => {
    expect(stationForTool("something.else")).toBeNull();
  });
});

describe("resolveActiveTools", () => {
  it("treats a start with no outcome as still running", () => {
    const active = resolveActiveTools([
      event({
        id: "1",
        type: "tool_started",
        agentId: "a1",
        runId: "r1",
        resource: { kind: "tool", id: "web.search" },
      }),
    ]);
    expect(active.get("a1")?.toolId).toBe("web.search");
  });

  it("closes a tool once its outcome arrives", () => {
    const active = resolveActiveTools([
      event({
        id: "2",
        type: "tool_succeeded",
        agentId: "a1",
        runId: "r1",
        createdAt: "2026-08-31T10:00:05.000Z",
        resource: { kind: "tool", id: "web.search" },
      }),
      event({
        id: "1",
        type: "tool_started",
        agentId: "a1",
        runId: "r1",
        resource: { kind: "tool", id: "web.search" },
      }),
    ]);
    expect(active.has("a1")).toBe(false);
  });

  it("closes a tool that failed, so a failure never strands the Agent", () => {
    const active = resolveActiveTools([
      event({
        id: "2",
        type: "tool_failed",
        status: "failure",
        agentId: "a1",
        runId: "r1",
        createdAt: "2026-08-31T10:00:05.000Z",
        resource: { kind: "tool", id: "web.fetch" },
      }),
      event({
        id: "1",
        type: "tool_started",
        agentId: "a1",
        runId: "r1",
        resource: { kind: "tool", id: "web.fetch" },
      }),
    ]);
    expect(active.has("a1")).toBe(false);
  });

  it("keeps the newest open tool when an Agent has run several", () => {
    const active = resolveActiveTools([
      event({
        id: "old",
        type: "tool_started",
        agentId: "a1",
        runId: "r1",
        createdAt: "2026-08-31T10:00:00.000Z",
        resource: { kind: "tool", id: "web.search" },
      }),
      event({
        id: "new",
        type: "tool_started",
        agentId: "a1",
        runId: "r2",
        createdAt: "2026-08-31T10:05:00.000Z",
        resource: { kind: "tool", id: "project.preview.inspect" },
      }),
    ]);
    expect(active.get("a1")?.toolId).toBe("project.preview.inspect");
  });

  it("tracks each Agent separately", () => {
    const active = resolveActiveTools([
      event({
        id: "1",
        type: "tool_started",
        agentId: "a1",
        runId: "r1",
        resource: { kind: "tool", id: "web.search" },
      }),
      event({
        id: "2",
        type: "tool_started",
        agentId: "a2",
        runId: "r2",
        resource: { kind: "tool", id: "project.preview.restart" },
      }),
    ]);
    expect(active.get("a1")?.toolId).toBe("web.search");
    expect(active.get("a2")?.toolId).toBe("project.preview.restart");
  });

  it("ignores events with no Agent or no tool resource", () => {
    const active = resolveActiveTools([
      event({ id: "1", type: "tool_started", runId: "r1" }),
      event({ id: "2", type: "tool_started", agentId: "a1" }),
    ]);
    expect(active.size).toBe(0);
  });
});

describe("resolveStation", () => {
  it("keeps an Agent at its desk when no tool is running", () => {
    expect(resolveStation("working", null)).toBe("desk");
    expect(resolveStation("idle", null)).toBe("desk");
  });

  it("sends a working Agent to the zone its tool implies", () => {
    expect(
      resolveStation("working", { toolId: "web.search", startedAt: "" }),
    ).toBe("library");
    expect(
      resolveStation("working", { toolId: "project.preview.inspect", startedAt: "" }),
    ).toBe("server");
  });

  it("lets the approval boundary outrank a running tool", () => {
    // Being stopped at the door is the thing a viewer most needs to see.
    expect(
      resolveStation("blocked", { toolId: "web.search", startedAt: "" }),
    ).toBe("door");
  });

  it("lets turn selection outrank a running tool", () => {
    expect(
      resolveStation("thinking", { toolId: "web.search", startedAt: "" }),
    ).toBe("board");
  });

  it("stays at the desk for a tool with no zone", () => {
    expect(
      resolveStation("working", { toolId: "unknown.tool", startedAt: "" }),
    ).toBe("desk");
  });
});
