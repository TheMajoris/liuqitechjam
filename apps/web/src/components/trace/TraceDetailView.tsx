import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type {
  AuditEventRecord,
  AuditTrace,
  AuditTraceNode,
  RunHistoryEntry,
} from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatCount, formatDuration, formatPercent } from "../insights/usage-format";
import { describeTokens, formatStarted, formatTokenCell, shortId } from "./run-format";
import {
  categoryColorVar,
  flattenTrace,
  modelEvidenceFromSpans,
  pathToSpan,
  spanLabel,
  spanTokens,
  timelineBars,
  type FlatSpan,
  type TraceModelEvidence,
} from "./trace-tree";
import {
  CACHED_TOKENS_HELP,
  TokenHotspots,
  TokenSplitBar,
  TokenSplitLegend,
  type TokenHotspot,
} from "./TokenHotspots";

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

/**
 * Per-model spend inside one trace.
 *
 * A trace's headline total says what was spent; this says which model spent
 * it, and how the spend split between fresh input, cache reads, and generated
 * output — the three things a reader can actually act on. Counters the
 * provider never reported stay absent rather than being shown as zero.
 */
function modelHotspots(evidence: readonly TraceModelEvidence[]): TokenHotspot[] {
  const rows = new Map<string, TokenHotspot>();
  for (const item of evidence) {
    const model = item.resolvedModel ?? item.requestedModel ?? "Unnamed model";
    const key = model + "::" + (item.providerId ?? "");
    const row = rows.get(key) ?? {
      id: key,
      label: model,
      meta: item.providerId,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      runs: 0,
      runsMissing: 0,
    };
    row.runs += 1;
    const input = item.inputTokens ?? 0;
    const cached = item.cachedInputTokens ?? 0;
    const output = item.outputTokens ?? 0;
    // Cached input is already inside `input`, so the billed total is input
    // plus output. Adding cache back in would count it twice.
    const total = item.totalTokens ?? input + output;
    if (total === 0 && item.totalTokens === undefined) {
      row.runsMissing = (row.runsMissing ?? 0) + 1;
    }
    row.inputTokens += input;
    row.cachedInputTokens += cached;
    row.outputTokens += output;
    row.totalTokens += total;
    rows.set(key, row);
  }
  return [...rows.values()];
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
  const [scale, setScale] = useState<"time" | "tokens">("time");
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
  const modelRows = useMemo(() => modelHotspots(modelEvidence), [modelEvidence]);
  // Token bars are scaled against the heaviest span, not the trace total, so a
  // single dominant step is visible rather than being flattened by the rest.
  const spanTokenTotals = useMemo(() => spans.map(spanTokens), [spans]);
  const peakSpanTokens = useMemo(
    () => spanTokenTotals.reduce<number>((peak, value) => Math.max(peak, value ?? 0), 0),
    [spanTokenTotals],
  );
  const measuredSpans = useMemo(
    () => spanTokenTotals.filter((value) => value !== null).length,
    [spanTokenTotals],
  );
  const tokensBySpan = useMemo(
    () => new Map(spans.map((span, index) => [span.spanId, spanTokenTotals[index] ?? null])),
    [spans, spanTokenTotals],
  );
  const traceStepTokens = useMemo(
    () => spanTokenTotals.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    [spanTokenTotals],
  );

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
    // Only a model call is charged tokens; a tool or sandbox step reports none,
    // and saying so is more useful than printing a zero it did not spend.
    const stepTokens = tokensBySpan.get(spanId) ?? null;
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
          <span
            className={"trace-node-tokens" + (stepTokens === null ? " is-absent" : "")}
            title={
              stepTokens === null
                ? "This step reported no token counters."
                : `${formatCount(stepTokens)} tokens, ${formatPercent(
                    stepTokens,
                    traceStepTokens,
                  )} of every counted step in this trace`
            }
          >
            {stepTokens === null ? "—" : formatCount(stepTokens) + " tok"}
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
  // A Run's own counters are the precise figure; the trace rollup covers every
  // Run beneath it and is the right total when no single Run is in view.
  const tokens = run?.tokens ?? trace?.tokens;
  const toolCalls = trace?.countsByCategory.tool_call ?? 0;
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
            <span title={describeTokens(tokens)}>
              {formatTokenCell(tokens)} tokens
            </span>
            <span>{eventCount} events</span>
            {toolCalls > 0 && <span>{toolCalls} tool calls</span>}
            {run !== null && <span>{formatStarted(run.startedAt ?? run.createdAt)}</span>}
          </p>
          {tokens && tokens.availability !== "unavailable" && tokens.totalTokens > 0 && (
            <div className="trace-token-summary">
              <span className="trace-token-bar">
                <TokenSplitBar hotspot={tokens} />
              </span>
              <span className="trace-token-parts">
                <span>
                  <strong>{formatCount(tokens.inputTokens)}</strong> input ·{" "}
                  {formatPercent(tokens.inputTokens, tokens.totalTokens)}
                </span>
                <span>
                  <strong>{formatCount(tokens.outputTokens)}</strong> output ·{" "}
                  {formatPercent(tokens.outputTokens, tokens.totalTokens)}
                </span>
                {/* A different denominator: the cache share is of the input it
                    came from, never of the billed total. */}
                <span title={CACHED_TOKENS_HELP}>
                  <strong>{formatCount(tokens.cachedInputTokens)}</strong> of that input
                  was cached ·{" "}
                  {formatPercent(tokens.cachedInputTokens, tokens.inputTokens)}
                </span>
              </span>
            </div>
          )}
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

      {modelRows.length > 0 && (
        <TokenHotspots title="Token spend by model" subject="model" rows={modelRows} />
      )}

      <div className="trace-panes">
        <section className="trace-timeline" aria-label="Timeline">
          <div className="trace-timeline-toolbar">
            <div className="insights-range" role="group" aria-label="Timeline scale">
              <button
                type="button"
                className={"button" + (scale === "time" ? " is-active" : "")}
                aria-pressed={scale === "time"}
                onClick={() => setScale("time")}
              >
                Time
              </button>
              <button
                type="button"
                className={"button" + (scale === "tokens" ? " is-active" : "")}
                aria-pressed={scale === "tokens"}
                disabled={peakSpanTokens === 0}
                title={
                  peakSpanTokens === 0
                    ? "No step in this trace reported token counters"
                    : "Scale each bar by the tokens that step reported"
                }
                onClick={() => setScale("tokens")}
              >
                Tokens
              </button>
            </div>
            {scale === "tokens" ? (
              <>
                <span className="trace-timeline-note">
                  {measuredSpans} of {spans.length} steps reported counters
                </span>
                <TokenSplitLegend />
              </>
            ) : (
              <span className="trace-timeline-note">
                Each bar spans when the step ran inside {formatDuration(durationMs)}
              </span>
            )}
          </div>
          {spans.map((span, index) => {
            const bar = bars[index];
            const stepTokens = spanTokenTotals[index] ?? null;
            const byTokens = scale === "tokens";
            return (
              <div key={span.spanId} className="trace-timeline-row">
                <span className="trace-timeline-label" style={{ paddingLeft: span.depth * 10 }}>
                  {span.label}
                </span>
                <span className="trace-timeline-track">
                  {byTokens ? (
                    stepTokens === null || peakSpanTokens === 0 ? (
                      <span className="trace-timeline-unmeasured">not reported</span>
                    ) : (
                      <span
                        className="trace-timeline-bar is-tokens"
                        style={{ left: 0, width: (stepTokens / peakSpanTokens) * 100 + "%" }}
                        title={`${span.label} · ${formatCount(stepTokens)} tokens`}
                      />
                    )
                  ) : (
                    <span
                      className="trace-timeline-bar"
                      style={{
                        left: (bar?.leftPct ?? 0) + "%",
                        width: (bar?.widthPct ?? 0) + "%",
                        background: `var(${categoryColorVar(span.category)})`,
                      }}
                      title={span.label + " · " + formatDuration(span.durationMs)}
                    />
                  )}
                </span>
                <span className="trace-timeline-figure">
                  {byTokens
                    ? stepTokens === null
                      ? "—"
                      : formatCount(stepTokens)
                    : formatDuration(span.durationMs)}
                </span>
              </div>
            );
          })}
          {spans.length === 0 && <p className="usage-empty">No spans in this trace.</p>}
        </section>

        <section className="trace-tree" aria-label="Spans">
          <p className="trace-tree-note">
            Tokens are charged per model call, so a tool or sandbox step shows
            no figure. <span title={CACHED_TOKENS_HELP}>Cached input</span> is
            part of the input it is quoted against, not an extra charge.
          </p>
          {trace.root && renderNode(trace.root, 0)}
          {trace.orphans.map((orphan) => renderNode(orphan, 0))}
        </section>
      </div>
      </>
      )}
    </div>
  );
}
