import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type {
  AuditEventRecord,
  AuditTrace,
  AuditTraceNode,
  RunHistoryEntry,
} from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatDuration } from "../insights/usage-format";
import { formatStarted, shortId } from "./run-format";
import {
  categoryColorVar,
  flattenTrace,
  modelEvidenceFromSpans,
  pathToSpan,
  spanLabel,
  timelineBars,
  type FlatSpan,
} from "./trace-tree";

/**
 * The one trace/audit detail implementation.
 *
 * It is reached from an Agent's Runs list and from the global observability
 * explorer, so it accepts either identity rather than being duplicated per
 * entry point. A Run opened here never needs its Agent record to still exist.
 */
interface TraceDetailViewProps {
  /** Opens a trace directly. Supply exactly one of traceId or runId. */
  traceId?: string;
  /** Opens the trace of one Run, headed by that Run's own record. */
  runId?: string;
  onBack: () => void;
  backLabel?: string;
}

function nodeSpanId(node: AuditTraceNode): string {
  return node.event.spanId ?? node.event.id;
}

function formatTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Only allow-listed scalars reach the DOM; objects are already stripped server-side. */
function scalarMetadata(event: AuditEventRecord): [string, string][] {
  return Object.entries(event.metadata ?? {})
    .filter(([, value]) => value !== null && typeof value !== "object")
    .map(([key, value]) => [key, String(value)] as [string, string]);
}

function EventDetail({ event }: { event: AuditEventRecord }) {
  const metadata = scalarMetadata(event);
  return (
    <li className="trace-event">
      <div className="trace-event-top">
        <code>{event.type}</code>
        <span className={"trace-pill trace-pill-" + event.status}>{event.status}</span>
        <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
      </div>
      <p>{event.summary}</p>
      {metadata.length > 0 && (
        <dl className="trace-meta">
          {metadata.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/**
 * Attribution evidence, kept conceptually apart from the trace.
 *
 * The span tree answers "what happened during this Run"; these categories
 * answer "who or what requested it, and what was decided".
 */
const AUDIT_CATEGORIES = new Set(["policy_decision", "human_approval", "session"]);

function AuditEvidence({ spans }: { spans: FlatSpan[] }) {
  const events = spans
    .flatMap((span) => span.events)
    .filter((event) => AUDIT_CATEGORIES.has(event.category ?? "system"));
  if (events.length === 0) return null;
  return (
    <section className="trace-audit" aria-labelledby="trace-audit-heading">
      <div className="trace-audit-head">
        <span className="eyebrow">Audit</span>
        <h3 id="trace-audit-heading">Who requested it, and what was decided</h3>
      </div>
      <div className="usage-table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Permission</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{formatTime(event.createdAt)}</td>
                <td>
                  <strong>{event.actorType ?? "system"}</strong>
                  {event.principal && (
                    <span className="usage-row-meta">{shortId(event.principal.id)}</span>
                  )}
                </td>
                <td>
                  <code>{event.type}</code>
                  <span className="trace-row-sub">{event.summary}</span>
                </td>
                <td>{event.permission ?? "—"}</td>
                <td>
                  <span className={"trace-pill trace-pill-" + event.status}>{event.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Run header shown when the detail view was opened from a Run. */
function RunSummaryHeading({ run }: { run: RunHistoryEntry }) {
  return (
    <>
      <span className="eyebrow">
        {run.agentName}
        {run.agentDeleted && <span className="trace-deleted-badge">Deleted</span>}
      </span>
      <h2>Run {shortId(run.runId)}</h2>
      <p className="trace-run-title">{run.title}</p>
    </>
  );
}

export function TraceDetailView({
  traceId,
  runId,
  onBack,
  backLabel = "Back",
}: TraceDetailViewProps) {
  const [trace, setTrace] = useState<AuditTrace | null>(null);
  const [run, setRun] = useState<RunHistoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pendingScroll = useRef<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      // The Run record is the identity of the page; its trace is the evidence.
      // A Run with no recorded events still renders its header.
      const [summary, result] = await Promise.all([
        runId === undefined ? Promise.resolve(null) : api.runSummary(runId),
        runId === undefined
          ? api.trace(traceId ?? "")
          : api.runTrace(runId).catch((cause) => {
              if (cause instanceof ApiError && cause.status === 404) return { trace: null };
              throw cause;
            }),
      ]);
      setRun(summary?.run ?? null);
      setTrace(result.trace);
      setError(null);
    } catch (cause) {
      if (requestSequence.current === requestId) {
        setError(cause instanceof ApiError ? cause.message : "Could not load trace");
      }
    } finally {
      if (requestSequence.current === requestId) setLoading(false);
    }
  }, [runId, traceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const spans = useMemo<FlatSpan[]>(() => (trace ? flattenTrace(trace) : []), [trace]);
  const bars = useMemo(() => (trace ? timelineBars(spans, trace) : []), [spans, trace]);
  const modelEvidence = useMemo(() => modelEvidenceFromSpans(spans), [spans]);

  useEffect(() => {
    const target = pendingScroll.current;
    if (target === null) return;
    pendingScroll.current = null;
    nodeRefs.current[target]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [expanded]);

  const toggle = (spanId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  };

  const jumpToFailing = () => {
    if (!trace?.failingStep) return;
    const { spanId } = trace.failingStep;
    setExpanded((current) => new Set([...current, ...pathToSpan(trace, spanId), spanId]));
    setHighlighted(spanId);
    pendingScroll.current = spanId;
  };

  if (loading && trace === null) {
    return (
      <div className="insights-view insights-centered">
        <Spinner />
        <p>Loading trace…</p>
      </div>
    );
  }

  if (trace === null && run === null) {
    return (
      <div className="insights-view insights-centered">
        <h2>Trace is unavailable</h2>
        <p>{error ?? "This trace has no recorded events."}</p>
        <button type="button" className="button" onClick={onBack}>
          {backLabel}
        </button>
      </div>
    );
  }

  const renderNode = (node: AuditTraceNode, depth: number) => {
    const spanId = nodeSpanId(node);
    const open = expanded.has(spanId);
    const events = node.events.length > 0 ? node.events : [node.event];
    return (
      <div
        key={spanId}
        className={"trace-node" + (highlighted === spanId ? " is-highlighted" : "")}
        style={{ marginLeft: depth * 14 }}
        ref={(element) => {
          nodeRefs.current[spanId] = element;
        }}
      >
        <button
          type="button"
          className="trace-node-head"
          aria-expanded={open}
          onClick={() => toggle(spanId)}
        >
          <span className="trace-node-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span
            className="trace-node-swatch"
            aria-hidden="true"
            style={{ background: `var(${categoryColorVar(node.event.category ?? "system")})` }}
          />
          <span className="trace-node-label">{spanLabel(node.event)}</span>
          <span className="trace-node-tag">{node.event.category ?? "system"}</span>
          <span className={"trace-pill trace-pill-" + node.event.status}>
            {node.event.status}
          </span>
          <span className="trace-node-duration">
            {formatDuration(node.event.durationMs ?? 0)}
          </span>
        </button>
        {open && (
          <ul className="trace-event-list">
            {events.map((event) => (
              <EventDetail key={event.id} event={event} />
            ))}
          </ul>
        )}
        {node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const durationMs = run?.durationMs ?? trace?.durationMs ?? 0;
  const eventCount = trace?.eventCount ?? run?.eventCount ?? 0;
  const status = run === null ? trace?.status ?? "success" : run.failed ? "failure" : "success";

  return (
    <div className="insights-view trace-detail">
      <header className="insights-head">
        <div>
          {run === null ? (
            <>
              <span className="eyebrow">Trace</span>
              <h2>{(trace?.traceId ?? "").slice(0, 12)}</h2>
            </>
          ) : (
            <RunSummaryHeading run={run} />
          )}
          <p className="trace-detail-facts">
            <span className={"trace-pill trace-pill-" + status}>
              {run === null ? status : run.status}
            </span>
            <span>{formatDuration(durationMs)}</span>
            <span>{eventCount} events</span>
            {run !== null && <span>{formatStarted(run.startedAt ?? run.createdAt)}</span>}
          </p>
        </div>
        <div className="trace-head-actions">
          <div className="insights-range">
            {trace?.failingStep && (
              <button type="button" className="button" onClick={jumpToFailing}>
                Jump to failing step
              </button>
            )}
            <button type="button" className="button" onClick={onBack}>
              {backLabel}
            </button>
          </div>
        </div>
      </header>

      {error && <p className="trace-error">{error}</p>}
      {run?.error && (
        <p className="trace-error">{run.error}</p>
      )}

      {trace === null ? (
        <p className="usage-empty">This Run recorded no trace events.</p>
      ) : (
      <>
      <AuditEvidence spans={spans} />
      <div className="trace-panes">
        <section className="trace-timeline" aria-label="Timeline">
          {spans.map((span, index) => {
            const bar = bars[index];
            return (
              <div key={span.spanId} className="trace-timeline-row">
                <span className="trace-timeline-label" style={{ paddingLeft: span.depth * 10 }}>
                  {span.label}
                </span>
                <span className="trace-timeline-track">
                  <span
                    className="trace-timeline-bar"
                    style={{
                      left: (bar?.leftPct ?? 0) + "%",
                      width: (bar?.widthPct ?? 0) + "%",
                      background: `var(${categoryColorVar(span.category)})`,
                    }}
                    title={span.label + " · " + formatDuration(span.durationMs)}
                  />
                </span>
              </div>
            );
          })}
          {spans.length === 0 && <p className="usage-empty">No spans in this trace.</p>}
        </section>

        <section className="trace-tree" aria-label="Spans">
          {trace.root && renderNode(trace.root, 0)}
          {trace.orphans.map((orphan) => renderNode(orphan, 0))}
        </section>
      </div>
      </>
      )}
    </div>
  );
}
