import { describe, expect, it } from "vitest";
import {
  addTools,
  conversationKey,
  conversationLabel,
  describeTools,
  emptyTools,
  formatToolCell,
  matchesQuery,
  summarizeTools,
  toolNamesInCell,
} from "../../../../apps/web/src/components/trace/run-format";
import type {
  RunHistoryEntry,
  RunToolUsage,
} from "../../../../apps/web/src/types";

function run(overrides: Partial<RunHistoryEntry> = {}): RunHistoryEntry {
  return {
    runId: "run-1",
    agentId: "agent-1",
    agentName: "Builder",
    agentDeleted: false,
    agentDeletedAt: null,
    status: "completed",
    title: "Rewrite the retry workflow",
    traceId: "trace-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
    eventCount: 7,
    errorCount: 0,
    tokens: {
      availability: "available",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 20,
      totalTokens: 120,
      netNewInputTokens: 100,
      netNewTokens: 120,
      runsReporting: 1,
      runsMissing: 0,
    },
    context: null,
    conversation: null,
    tools: emptyTools(),
    failed: false,
    error: null,
    ...overrides,
  };
}

function tools(names: [string, number][], sandboxCommands = 0): RunToolUsage {
  return {
    calls: names.length,
    sandboxCommands,
    names: names.map(([name, calls]) => ({ name, calls, failed: 0 })),
  };
}

describe("grouping Runs by conversation", () => {
  it("puts two participants of one Team turn in the same group", () => {
    const conversation = {
      id: "orch-1",
      kind: "team" as const,
      title: "Retry workflow",
      derived: false,
    };

    expect(conversationKey(run({ runId: "run-1", conversation }))).toBe(
      conversationKey(run({ runId: "run-2", conversation })),
    );
  });

  it("keeps a private thread and a Team session apart when their IDs collide", () => {
    // The two live in separate collections, so an ID is unique only within one.
    const direct = run({
      conversation: { id: "shared", kind: "direct", title: "Chat", derived: false },
    });
    const team = run({
      conversation: { id: "shared", kind: "team", title: "Team", derived: false },
    });

    expect(conversationKey(direct)).not.toBe(conversationKey(team));
  });

  it("leaves an unattached Run in a group of its own", () => {
    // Pooling loose Runs would invent a conversation that never happened.
    expect(conversationKey(run({ runId: "run-1" }))).toBe("run:run-1");
    expect(conversationKey(run({ runId: "run-2" }))).toBe("run:run-2");
  });

  it("labels an unattached Run by its own task", () => {
    expect(conversationLabel(run())).toBe("Rewrite the retry workflow");
  });
});

describe("saying what a Run called", () => {
  it("shows an em dash rather than a zero when nothing was called", () => {
    expect(formatToolCell(emptyTools())).toBe("—");
    expect(describeTools(emptyTools())).toMatch(/called no tools/);
  });

  it("counts tool calls and sandbox commands together in the cell", () => {
    expect(formatToolCell(tools([["read_file", 1]], 3))).toBe("4");
  });

  it("names the busiest tools and counts off the rest", () => {
    const usage = tools([
      ["$ rg", 4],
      ["read_file", 3],
      ["$ ls", 2],
      ["write_file", 1],
    ]);

    expect(toolNamesInCell(usage)).toBe("$ rg, read_file, $ ls +1");
  });

  it("spells out every tool and its failures in the tooltip", () => {
    const usage: RunToolUsage = {
      calls: 2,
      sandboxCommands: 1,
      names: [
        { name: "write_file", calls: 2, failed: 1 },
        { name: "$ rg", calls: 1, failed: 0 },
      ],
    };

    expect(describeTools(usage)).toBe(
      "2 tool calls · 1 sandbox command — write_file ×2 (1 failed), $ rg ×1",
    );
  });

  it("says plainly when a rolled-up group called nothing", () => {
    expect(summarizeTools(emptyTools())).toBe("no tools called");
  });
});

describe("rolling several Runs' tools together", () => {
  it("adds the same tool's calls rather than listing it twice", () => {
    const total = emptyTools();
    addTools(total, tools([["read_file", 2]]));
    addTools(total, tools([["read_file", 3]], 1));

    expect(total.names).toEqual([{ name: "read_file", calls: 5, failed: 0 }]);
    expect(total.sandboxCommands).toBe(1);
  });

  it("keeps the busiest tool first after a merge", () => {
    const total = emptyTools();
    addTools(total, tools([["read_file", 1]]));
    addTools(total, tools([["$ rg", 6]]));

    expect(total.names.map((tool) => tool.name)).toEqual(["$ rg", "read_file"]);
  });
});

describe("searching a Run list", () => {
  const entry = run({
    title: "Rewrite the retry workflow",
    agentName: "Joshua",
    conversation: { id: "orch-1", kind: "team", title: "Retry polish", derived: false },
    tools: {
      calls: 1,
      sandboxCommands: 1,
      names: [
        { name: "$ rg", calls: 1, failed: 0 },
        { name: "read_file", calls: 1, failed: 0 },
      ],
    },
  });

  it("matches everything when the box is empty", () => {
    expect(matchesQuery(entry, "")).toBe(true);
    expect(matchesQuery(entry, "   ")).toBe(true);
  });

  it("finds a Run by its conversation, not only by its own title", () => {
    // Team turns share a title, so the thread is often the only thing that
    // tells one list of near-identical Runs from another.
    expect(matchesQuery(entry, "retry polish")).toBe(true);
  });

  it("finds a Run by Agent, by tool, and by ID", () => {
    expect(matchesQuery(entry, "joshua")).toBe(true);
    expect(matchesQuery(entry, "read_file")).toBe(true);
    expect(matchesQuery(entry, "run-1")).toBe(true);
  });

  it("requires every term, in any order", () => {
    expect(matchesQuery(entry, "joshua retry")).toBe(true);
    expect(matchesQuery(entry, "retry joshua")).toBe(true);
    expect(matchesQuery(entry, "joshua kubernetes")).toBe(false);
  });

  it("ignores case", () => {
    expect(matchesQuery(entry, "REWRITE")).toBe(true);
  });
});
