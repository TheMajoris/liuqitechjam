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

export interface TraceModelEvidence {
  key: string;
  runId: string | null;
  agentId: string | null;
  providerId: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  fallback: boolean;
  retried: boolean;
  failed: boolean;
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
    const model =
      metadataString(event, "resolvedModel") ??
      metadataString(event, "modelUsed") ??
      metadataString(event, "model") ??
      "";
    const provider = metadataString(event, "providerId");
    return "run " + model + (provider ? ` · ${provider}` : "");
  }
  if (type.startsWith("orchestration_")) {
    return event.summary;
  }
  return type;
}

function firstMetadataString(
  events: readonly AuditEventRecord[],
  keys: readonly string[],
): string | null {
  for (const event of events) {
    for (const key of keys) {
      const value = metadataString(event, key);
      if (value) return value;
    }
  }
  return null;
}

function latestMetadataNumber(
  events: readonly AuditEventRecord[],
  keys: readonly string[],
): number | undefined {
  let result: number | undefined;
  for (const event of events) {
    for (const key of keys) {
      const value = metadataNumber(event, key);
      if (value !== undefined) result = value;
    }
  }
  return result;
}

/**
 * Compact per-run model evidence for Trace. Values are copied from the
 * server-redacted audit metadata; this function never derives a quota or
 * invents a total from partial counters.
 */
export function modelEvidenceFromSpans(spans: readonly FlatSpan[]): TraceModelEvidence[] {
  const grouped = new Map<string, AuditEventRecord[]>();
  for (const span of spans) {
    const events = span.events.filter(
      (event) =>
        event.type.startsWith("run_") ||
        event.type === "model_fallback" ||
        event.type === "run_retried" ||
        event.category === "model_call" ||
        metadataString(event, "model") !== undefined ||
        metadataString(event, "modelUsed") !== undefined,
    );
    if (events.length === 0) continue;
    const key = span.runId ?? span.spanId;
    const current = grouped.get(key) ?? [];
    current.push(...events);
    grouped.set(key, current);
  }

  return Array.from(grouped, ([key, events]) => {
    const fallback = events.some(
      (event) =>
        event.type === "model_fallback" ||
        event.metadata?.fallbackUsed === true ||
        typeof event.metadata?.fallbackIndex === "number",
    );
    return {
      key,
      runId: events.find((event) => event.runId)?.runId ?? null,
      agentId: events.find((event) => event.agentId)?.agentId ?? null,
      providerId: firstMetadataString(events, ["providerId"]),
      requestedModel: firstMetadataString(events, ["requestedModel", "model"]),
      resolvedModel: firstMetadataString(events, ["resolvedModel", "modelUsed"]),
      inputTokens: latestMetadataNumber(events, ["inputTokens"]),
      cachedInputTokens: latestMetadataNumber(events, ["cachedInputTokens"]),
      outputTokens: latestMetadataNumber(events, ["outputTokens"]),
      totalTokens: latestMetadataNumber(events, ["totalTokens"]),
      fallback,
      retried: events.some((event) => event.type === "run_retried"),
      failed: events.some((event) => event.status === "failure"),
    };
  });
}

/**
 * Tokens attributable to one span.
 *
 * Only counters the provider actually reported are returned; a span with no
 * counter is `null` rather than zero, so a view can say "not reported" instead
 * of drawing a confident empty bar. When no total was recorded the fallback is
 * input plus output — matching the server — because cached input is a slice of
 * the input counter rather than a third bucket, and adding it would count the
 * cache twice.
 */
export function spanTokens(span: FlatSpan): number | null {
  let total: number | undefined;
  let input: number | undefined;
  let output: number | undefined;
  for (const event of span.events) {
    const recorded = metadataNumber(event, "totalTokens");
    if (recorded !== undefined) total = recorded;
    const recordedInput = metadataNumber(event, "inputTokens");
    if (recordedInput !== undefined) input = recordedInput;
    const recordedOutput = metadataNumber(event, "outputTokens");
    if (recordedOutput !== undefined) output = recordedOutput;
  }
  if (total !== undefined) return total;
  if (input === undefined && output === undefined) return null;
  return (input ?? 0) + (output ?? 0);
}

/**
 * Tokens counted once per model call rather than once per span.
 *
 * A Run span carries the Run's usage and its `model_turn` child carries the
 * same turn's usage, so a naive sum over spans counts a single-turn Run twice
 * and halves every share computed against that sum. A span that has a
 * descendant reporting its own counters is treated as a rollup of those
 * descendants and contributes nothing of its own.
 */
export function countedSpanTokens(spans: readonly FlatSpan[]): Map<string, number> {
  const reported = new Map<string, number>();
  for (const span of spans) {
    const tokens = spanTokens(span);
    if (tokens !== null) reported.set(span.spanId, tokens);
  }
  const rollup = new Set<string>();
  for (const span of spans) {
    if (!reported.has(span.spanId)) continue;
    // Walk to the root marking every reporting ancestor as a rollup: the leaf
    // is the model call that was actually charged.
    let parentId = span.parentSpanId;
    const guard = new Set<string>([span.spanId]);
    while (parentId !== null && parentId !== undefined && !guard.has(parentId)) {
      guard.add(parentId);
      if (reported.has(parentId)) rollup.add(parentId);
      parentId = spans.find((candidate) => candidate.spanId === parentId)?.parentSpanId ?? null;
    }
  }
  for (const spanId of rollup) reported.delete(spanId);
  return reported;
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
