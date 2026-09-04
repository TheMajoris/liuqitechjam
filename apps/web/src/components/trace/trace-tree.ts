import type {
  AuditEventRecord,
  AuditTrace,
  AuditTraceNode,
  AuditTraceSummary,
} from "../../types";

export interface FlatSpan {
  spanId: string;
  parentSpanId: string | null;
  depth: number;
  event: AuditEventRecord;
  events: AuditEventRecord[];
  category: string;
  status: "success" | "failure";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  label: string;
  agentId?: string;
  runId?: string;
}

export interface TimelineBar {
  spanId: string;
  leftPct: number;
  widthPct: number;
}

const MIN_BAR_WIDTH_PCT = 0.5;

function metadataString(
  event: AuditEventRecord,
  key: string,
): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataNumber(event: AuditEventRecord, key: string): number | undefined {
  const value = event.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

/** A short, human label for a span's defining event. */
export function spanLabel(event: AuditEventRecord): string {
  const { type } = event;
  if (type === "sandbox_command") {
    return "$ " + (metadataString(event, "program") ?? "");
  }
  if (type === "workspace_file_change") {
    return "edit " + (metadataNumber(event, "fileCount") ?? 0) + " files";
  }
  if (type === "mcp_tool_call" || type.startsWith("tool_")) {
    return metadataString(event, "toolId") ?? event.summary;
  }
  if (type.startsWith("run_")) {
    return "run " + (metadataString(event, "model") ?? "");
  }
  if (type.startsWith("orchestration_")) {
    return event.summary;
  }
  return type;
}

function spanEnd(events: AuditEventRecord[], fallback: string): string {
  let end = Date.parse(fallback);
  if (!Number.isFinite(end)) end = 0;
  for (const event of events) {
    const started = Date.parse(event.createdAt);
    if (!Number.isFinite(started)) continue;
    const candidate = started + (event.durationMs ?? 0);
    if (candidate > end) end = candidate;
    if (started > end) end = started;
  }
  return new Date(end).toISOString();
}

function flattenNode(node: AuditTraceNode, depth: number, into: FlatSpan[]): void {
  const { event } = node;
  const events = node.events.length > 0 ? node.events : [event];
  const startedAt = event.createdAt;
  const endedAt = spanEnd(events, startedAt);
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  into.push({
    spanId: event.spanId ?? event.id,
    parentSpanId: event.parentSpanId ?? null,
    depth,
    event,
    events,
    category: event.category ?? "system",
    status: event.status,
    startedAt,
    endedAt,
    durationMs:
      Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
    label: spanLabel(event),
    agentId: event.agentId,
    runId: event.runId,
  });
  for (const child of node.children) flattenNode(child, depth + 1, into);
}

/** DFS order; orphan subtrees follow the root subtree at depth 0. */
export function flattenTrace(trace: AuditTrace): FlatSpan[] {
  const spans: FlatSpan[] = [];
  if (trace.root) flattenNode(trace.root, 0, spans);
  for (const orphan of trace.orphans) flattenNode(orphan, 0, spans);
  return spans;
}

export function timelineBars(spans: FlatSpan[], trace: AuditTrace): TimelineBar[] {
  const traceStart = Date.parse(trace.startedAt);
  const traceEnd = Date.parse(trace.endedAt);
  const total = traceEnd - traceStart;
  if (!Number.isFinite(total) || total <= 0) {
    return spans.map((span) => ({ spanId: span.spanId, leftPct: 0, widthPct: 100 }));
  }
  return spans.map((span) => {
    const start = Date.parse(span.startedAt);
    const end = Date.parse(span.endedAt);
    const leftPct = Number.isFinite(start)
      ? Math.min(100, Math.max(0, ((start - traceStart) / total) * 100))
      : 0;
    const rawWidth = Number.isFinite(end) && Number.isFinite(start)
      ? ((end - start) / total) * 100
      : 0;
    const widthPct = Math.min(100 - leftPct, Math.max(MIN_BAR_WIDTH_PCT, rawWidth));
    return { spanId: span.spanId, leftPct, widthPct };
  });
}

/** Category palette lives in CSS; this only names the variable. */
export function categoryColorVar(category: string): string {
  return "--trace-cat-" + category.replace(/_/g, "-");
}

/** Ancestor span ids of `spanId`, outermost first, so a view can expand to it. */
export function pathToSpan(trace: AuditTrace, spanId: string): string[] {
  const roots = [
    ...(trace.root ? [trace.root] : []),
    ...trace.orphans,
  ];
  const walk = (node: AuditTraceNode, ancestors: string[]): string[] | null => {
    const id = node.event.spanId ?? node.event.id;
    if (id === spanId) return ancestors;
    for (const child of node.children) {
      const found = walk(child, [...ancestors, id]);
      if (found) return found;
    }
    return null;
  };
  for (const root of roots) {
    const found = walk(root, []);
    if (found) return found;
  }
  return [];
}

export function statusFilter(
  traces: AuditTraceSummary[],
  status: "all" | "success" | "failure",
): AuditTraceSummary[] {
  if (status === "all") return traces;
  return traces.filter((trace) => trace.status === status);
}
