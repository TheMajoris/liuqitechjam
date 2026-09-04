import { AUDIT_CATEGORIES, type AuditCategory, type AuditEvent } from "./audit-types.js";

export const MAX_AUDIT_TRACE_LIST_LIMIT = 200;
export const DEFAULT_AUDIT_TRACE_LIST_LIMIT = 50;

/** One span of a trace. A span may carry several events (start/finish). */
export interface AuditTraceNode {
  /** The earliest event of the span; the node's identity. */
  event: AuditEvent;
  /** Every event of the span, in order. */
  events: AuditEvent[];
  children: AuditTraceNode[];
}

export interface AuditTraceFailingStep {
  spanId: string;
  eventId: string;
  type: string;
}

export interface AuditTrace {
  traceId: string;
  root: AuditTraceNode | null;
  orphans: AuditTraceNode[];
  status: "success" | "failure";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  eventCount: number;
  countsByCategory: Record<AuditCategory, number>;
  failingStep: AuditTraceFailingStep | null;
  agentIds: string[];
  runIds: string[];
}

export type AuditTraceSummary = Omit<AuditTrace, "root" | "orphans"> & {
  rootType: string | null;
  rootSummary: string;
};

export interface AuditTraceListQuery {
  agentId?: string | undefined;
  projectId?: string | undefined;
  status?: "success" | "failure" | undefined;
  limit?: number | undefined;
}

function compareEvents(a: AuditEvent, b: AuditEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.sequence - b.sequence;
}

function emptyCounts(): Record<AuditCategory, number> {
  const counts = {} as Record<AuditCategory, number>;
  for (const category of AUDIT_CATEGORIES) counts[category] = 0;
  return counts;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    if (value !== undefined && !seen.includes(value)) seen.push(value);
  }
  return seen;
}

/** Malformed parent links must not produce a cyclic, unserializable tree. */
function createsCycle(
  spans: ReadonlyMap<string, AuditTraceNode>,
  spanId: string,
  parentSpanId: string,
): boolean {
  let cursor: string | undefined = parentSpanId;
  const seen = new Set<string>([spanId]);
  while (cursor !== undefined) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = spans.get(cursor)?.event.parentSpanId;
  }
  return false;
}

/** Group a trace's events into a span tree with a derived rollup. */
export function buildTraceTree(
  events: readonly AuditEvent[],
  traceId: string,
): AuditTrace {
  const ordered = [...events].sort(compareEvents);

  const spans = new Map<string, AuditTraceNode>();
  for (const event of ordered) {
    const existing = spans.get(event.spanId);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    spans.set(event.spanId, { event, events: [event], children: [] });
  }

  // The root is the earliest parentless span; ordered insertion makes the
  // first such span the earliest one.
  let root: AuditTraceNode | null = null;
  for (const node of spans.values()) {
    if (node.event.parentSpanId === undefined) {
      root = node;
      break;
    }
  }

  const orphans: AuditTraceNode[] = [];
  for (const node of spans.values()) {
    if (node === root) continue;
    const parentSpanId = node.event.parentSpanId;
    const parent =
      parentSpanId === undefined || createsCycle(spans, node.event.spanId, parentSpanId)
        ? undefined
        : spans.get(parentSpanId);
    if (parent) {
      parent.children.push(node);
    } else if (root) {
      root.children.push(node);
    } else {
      orphans.push(node);
    }
  }
  for (const node of spans.values()) {
    node.children.sort((a, b) => compareEvents(a.event, b.event));
  }
  orphans.sort((a, b) => compareEvents(a.event, b.event));

  const countsByCategory = emptyCounts();
  for (const event of ordered) countsByCategory[event.category] += 1;

  const failures = ordered.filter((event) => event.status === "failure");
  const significant = failures.find(
    (event) => event.category !== "human_approval" && event.category !== "policy_decision",
  );
  const failing = significant ?? failures[0];
  const failingStep: AuditTraceFailingStep | null = failing
    ? { spanId: failing.spanId, eventId: failing.id, type: failing.type }
    : null;

  const rootFailed =
    root?.events.some((event) => event.status === "failure") === true;
  const terminalFailure = ordered.some(
    (event) => event.type === "run_failed" || event.type === "orchestration_failed",
  );

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const startedAt = first?.createdAt ?? "";
  const endedAt = last?.createdAt ?? "";
  const elapsed = first && last ? Date.parse(endedAt) - Date.parse(startedAt) : 0;
  const spanDuration = root?.events[root.events.length - 1]?.durationMs;
  const durationMs =
    spanDuration !== undefined && spanDuration > elapsed
      ? spanDuration
      : Number.isFinite(elapsed) && elapsed > 0
        ? elapsed
        : 0;

  return {
    traceId,
    root,
    orphans,
    status: rootFailed || terminalFailure ? "failure" : "success",
    startedAt,
    endedAt,
    durationMs,
    eventCount: ordered.length,
    countsByCategory,
    failingStep,
    agentIds: uniqueStrings(ordered.map((event) => event.agentId)),
    runIds: uniqueStrings(ordered.map((event) => event.runId)),
  };
}

function summarize(trace: AuditTrace): AuditTraceSummary {
  const { root, orphans: _orphans, ...rest } = trace;
  return {
    ...rest,
    rootType: root?.event.type ?? null,
    rootSummary: root?.event.summary ?? "",
  };
}

/** Bounded list of trace rollups, newest first. */
export function listTraces(
  events: readonly AuditEvent[],
  filter: AuditTraceListQuery = {},
): AuditTraceSummary[] {
  const grouped = new Map<string, AuditEvent[]>();
  for (const event of events) {
    const bucket = grouped.get(event.traceId);
    if (bucket) bucket.push(event);
    else grouped.set(event.traceId, [event]);
  }

  const summaries: AuditTraceSummary[] = [];
  for (const [traceId, traceEvents] of grouped) {
    if (
      filter.agentId !== undefined &&
      !traceEvents.some((event) => event.agentId === filter.agentId)
    ) {
      continue;
    }
    if (
      filter.projectId !== undefined &&
      !traceEvents.some((event) => event.projectId === filter.projectId)
    ) {
      continue;
    }
    const trace = buildTraceTree(traceEvents, traceId);
    if (filter.status !== undefined && trace.status !== filter.status) continue;
    summaries.push(summarize(trace));
  }

  summaries.sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? 1 : -1));
  const limit = Math.min(
    filter.limit ?? DEFAULT_AUDIT_TRACE_LIST_LIMIT,
    MAX_AUDIT_TRACE_LIST_LIMIT,
  );
  return summaries.slice(0, limit);
}
