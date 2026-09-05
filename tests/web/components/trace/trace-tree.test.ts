import { describe, expect, it } from "vitest";
import {
  categoryColorVar,
  flattenTrace,
  pathToSpan,
  spanLabel,
  statusFilter,
  timelineBars,
} from "../../../../apps/web/src/components/trace/trace-tree";
import type {
  AuditEventRecord,
  AuditTrace,
  AuditTraceNode,
  AuditTraceSummary,
} from "../../../../apps/web/src/types";

function event(
  overrides: Partial<AuditEventRecord> & { id: string; createdAt: string },
): AuditEventRecord {
  return {
    type: "orchestration_started",
    status: "success",
    summary: "summary",
    ...overrides,
  };
}

function node(
  own: AuditEventRecord,
  children: AuditTraceNode[] = [],
  events: AuditEventRecord[] = [own],
): AuditTraceNode {
  return { event: own, events, children };
}

const root = node(
  event({ id: "e-root", spanId: "root", createdAt: "2026-01-01T00:00:00.000Z", category: "orchestration" }),
  [
    node(
      event({
        id: "e-a",
        spanId: "a",
        parentSpanId: "root",
        createdAt: "2026-01-01T00:00:01.000Z",
        category: "model_call",
        type: "run_started",
        metadata: { model: "gpt-5" },
      }),
      [
        node(
          event({
            id: "e-a1",
            spanId: "a1",
            parentSpanId: "a",
            createdAt: "2026-01-01T00:00:02.000Z",
            category: "tool_call",
            type: "mcp_tool_call",
            metadata: { toolId: "fs.read" },
          }),
        ),
      ],
    ),
    node(
      event({ id: "e-b", spanId: "b", parentSpanId: "root", createdAt: "2026-01-01T00:00:05.000Z" }),
    ),
  ],
);

const orphan = node(
  event({ id: "e-o", spanId: "orphan", createdAt: "2026-01-01T00:00:08.000Z", category: "system" }),
  [node(event({ id: "e-o1", spanId: "orphan-child", parentSpanId: "orphan", createdAt: "2026-01-01T00:00:09.000Z" }))],
);

const trace: AuditTrace = {
  traceId: "trace-1",
  root,
  orphans: [orphan],
  status: "success",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:10.000Z",
  durationMs: 10_000,
  eventCount: 6,
  countsByCategory: {} as AuditTrace["countsByCategory"],
  failingStep: null,
  agentIds: [],
  runIds: [],
};

describe("flattenTrace", () => {
  it("walks depth-first and appends orphans at depth 0", () => {
    const spans = flattenTrace(trace);
    expect(spans.map((span) => span.spanId)).toEqual([
      "root",
      "a",
      "a1",
      "b",
      "orphan",
      "orphan-child",
    ]);
    expect(spans.map((span) => span.depth)).toEqual([0, 1, 2, 1, 0, 1]);
  });

  it("ends a span at the last event, extended by its duration", () => {
    const withEvents: AuditTrace = {
      ...trace,
      root: node(
        event({ id: "e-root", spanId: "root", createdAt: "2026-01-01T00:00:00.000Z" }),
        [],
        [
          event({ id: "e-root", spanId: "root", createdAt: "2026-01-01T00:00:00.000Z" }),
          event({ id: "e-tail", spanId: "root", createdAt: "2026-01-01T00:00:02.000Z", durationMs: 3000 }),
        ],
      ),
      orphans: [],
    };
    const [span] = flattenTrace(withEvents);
    expect(span.endedAt).toBe("2026-01-01T00:00:05.000Z");
    expect(span.durationMs).toBe(5000);
  });
});

describe("timelineBars", () => {
  it("positions bars relative to the trace window", () => {
    const spans = flattenTrace(trace);
    const bars = timelineBars(spans, trace);
    expect(bars[0]).toMatchObject({ spanId: "root", leftPct: 0 });
    expect(bars[1].leftPct).toBeCloseTo(10);
    expect(bars[2].leftPct).toBeCloseTo(20);
    expect(bars[4].leftPct).toBeCloseTo(80);
  });

  it("keeps a zero-length span visible", () => {
    const spans = flattenTrace(trace);
    const bars = timelineBars(spans, trace);
    expect(bars[3].widthPct).toBe(0.5);
  });

  it("falls back to a full-width bar when the trace window is empty", () => {
    const spans = flattenTrace(trace);
    const bars = timelineBars(spans, { ...trace, endedAt: trace.startedAt });
    expect(bars.every((bar) => bar.leftPct === 0 && bar.widthPct === 100)).toBe(true);
  });
});

describe("spanLabel", () => {
  it("labels each event family", () => {
    expect(
      spanLabel(event({ id: "1", createdAt: "", type: "sandbox_command", metadata: { program: "ls" } })),
    ).toBe("$ ls");
    expect(
      spanLabel(
        event({ id: "2", createdAt: "", type: "workspace_file_change", metadata: { fileCount: 3 } }),
      ),
    ).toBe("edit 3 files");
    expect(
      spanLabel(event({ id: "3", createdAt: "", type: "mcp_tool_call", metadata: { toolId: "fs.read" } })),
    ).toBe("fs.read");
    expect(
      spanLabel(event({ id: "4", createdAt: "", type: "tool_result", summary: "did a thing" })),
    ).toBe("did a thing");
    expect(
      spanLabel(event({ id: "5", createdAt: "", type: "run_started", metadata: { model: "gpt-5" } })),
    ).toBe("run gpt-5");
    expect(
      spanLabel(event({ id: "6", createdAt: "", type: "orchestration_started", summary: "kicked off" })),
    ).toBe("kicked off");
    expect(spanLabel(event({ id: "7", createdAt: "", type: "session_opened" }))).toBe("session_opened");
  });
});

describe("categoryColorVar", () => {
  it("maps a category to its CSS variable", () => {
    expect(categoryColorVar("model_call")).toBe("--trace-cat-model-call");
    expect(categoryColorVar("system")).toBe("--trace-cat-system");
  });
});

describe("pathToSpan", () => {
  it("returns ancestors outermost first", () => {
    expect(pathToSpan(trace, "a1")).toEqual(["root", "a"]);
    expect(pathToSpan(trace, "root")).toEqual([]);
    expect(pathToSpan(trace, "orphan-child")).toEqual(["orphan"]);
    expect(pathToSpan(trace, "missing")).toEqual([]);
  });
});

describe("statusFilter", () => {
  const summaries = [
    { traceId: "s", status: "success" },
    { traceId: "f", status: "failure" },
  ] as AuditTraceSummary[];

  it("filters by status and passes everything through for all", () => {
    expect(statusFilter(summaries, "all")).toHaveLength(2);
    expect(statusFilter(summaries, "success").map((t) => t.traceId)).toEqual(["s"]);
    expect(statusFilter(summaries, "failure").map((t) => t.traceId)).toEqual(["f"]);
  });
});
