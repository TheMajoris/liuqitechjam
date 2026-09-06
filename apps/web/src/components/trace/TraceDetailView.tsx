import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { AuditEventRecord, AuditTrace, AuditTraceNode } from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatCount, formatDuration } from "../insights/usage-format";
import {
  categoryColorVar,
  flattenTrace,
  modelEvidenceFromSpans,
  pathToSpan,
  spanLabel,
  timelineBars,
  type FlatSpan,
} from "./trace-tree";

interface TraceDetailViewProps {
  traceId: string;
  onBack: () => void;
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

export function TraceDetailView({ traceId, onBack }: TraceDetailViewProps) {
  const [trace, setTrace] = useState<AuditTrace | null>(null);
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
      const result = await api.trace(traceId);
      if (requestSequence.current !== requestId) return;
      setTrace(result.trace);
      setError(null);
    } catch (cause) {
      if (requestSequence.current === requestId) {
        setError(cause instanceof ApiError ? cause.message : "Could not load trace");
      }
    } finally {
      if (requestSequence.current === requestId) setLoading(false);
    }
  }, [traceId]);

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

  if (trace === null) {
    return (
      <div className="insights-view insights-centered">
        <h2>Trace is unavailable</h2>
        <p>{error ?? "This trace has no recorded events."}</p>
        <button type="button" className="button" onClick={onBack}>
          Back to traces
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

  return (
    <div className="insights-view trace-detail">
      <header className="insights-head">
        <div>
          <span className="eyebrow">Trace</span>
          <h2>{trace.traceId.slice(0, 12)}</h2>
          <p className="trace-detail-facts">
            <span className={"trace-pill trace-pill-" + trace.status}>{trace.status}</span>
            <span>{formatDuration(trace.durationMs)}</span>
            <span>{trace.eventCount} events</span>
          </p>
        </div>
        <div className="trace-head-actions">
          <div className="insights-range">
            {trace.failingStep && (
              <button type="button" className="button" onClick={jumpToFailing}>
                Jump to failing step
              </button>
            )}
            <button type="button" className="button" onClick={onBack}>
              Back
            </button>
          </div>
        </div>
      </header>

      {error && <p className="trace-error">{error}</p>}

      {modelEvidence.length > 0 && (
        <section className="trace-model-evidence" aria-labelledby="trace-model-evidence-heading">
          <div className="trace-model-evidence-head">
            <div>
              <span className="eyebrow">Execution evidence</span>
              <h3 id="trace-model-evidence-heading">Models used in this run</h3>
            </div>
            <span className="trace-model-evidence-note">Server-reported values</span>
          </div>
          <div className="usage-table-scroll">
            <table className="usage-table trace-model-evidence-table">
              <caption className="sr-only">Per-run model and token evidence</caption>
              <thead>
                <tr>
                  <th scope="col">Run / Agent</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Resolved</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Fallback</th>
                </tr>
              </thead>
              <tbody>
                {modelEvidence.map((evidence) => {
                  const tokenParts = [
                    evidence.totalTokens === undefined ? null : `${formatCount(evidence.totalTokens)} total`,
                    evidence.inputTokens === undefined ? null : `${formatCount(evidence.inputTokens)} in`,
                    evidence.cachedInputTokens === undefined ? null : `${formatCount(evidence.cachedInputTokens)} cached`,
                    evidence.outputTokens === undefined ? null : `${formatCount(evidence.outputTokens)} out`,
                  ].filter((part): part is string => part !== null);
                  return (
                    <tr key={evidence.key}>
                      <th scope="row">
                        <span>{evidence.runId ?? "Run"}</span>
                        {evidence.agentId && <span className="usage-row-meta">{evidence.agentId}</span>}
                      </th>
                      <td>{evidence.providerId ?? "—"}</td>
                      <td className="trace-model-value">{evidence.requestedModel ?? "—"}</td>
                      <td className="trace-model-value">{evidence.resolvedModel ?? "—"}</td>
                      <td>{tokenParts.length > 0 ? tokenParts.join(" · ") : "Not reported"}</td>
                      <td>
                        {evidence.fallback ? "Used" : evidence.retried ? "Retry only" : "No"}
                        {evidence.failed ? " · failed" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
    </div>
  );
}
