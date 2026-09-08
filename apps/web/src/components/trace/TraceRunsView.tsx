import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import type { AuditTraceSummary, RunHistoryEntry } from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatDuration, formatPercent } from "../insights/usage-format";
import { RunListView } from "./RunListView";
import { describeTokens, formatStarted, formatTokenCell, shortId } from "./run-format";
import { statusFilter } from "./trace-tree";
import {
  TokenHotspots,
  TokenSplitBar,
  addTokens,
  emptyHotspot,
  type TokenHotspot,
} from "./TokenHotspots";

interface TraceRunsViewProps {
  projectId?: string;
  agentId?: string;
  onOpenTrace: (traceId: string) => void;
  onOpenRun: (runId: string) => void;
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "success", label: "Success" },
  { value: "failure", label: "Failure" },
] as const;

const TRACE_SORTS = [
  { value: "recent", label: "Recent" },
  { value: "tokens", label: "Most tokens" },
  { value: "duration", label: "Slowest" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];
type TraceSort = (typeof TRACE_SORTS)[number]["value"];
type Tab = "runs" | "traces";

/**
 * What a trace made the model process, for ranking and for the bar.
 *
 * Not the billed total: each turn re-sends the conversation so far, so billing
 * rises with a thread's age rather than with the work. The billed figure stays
 * in the cell's tooltip.
 */
function traceTokens(trace: AuditTraceSummary): number {
  return trace.tokens.availability === "unavailable" ? -1 : trace.tokens.netNewTokens;
}

function sortTraces(
  traces: readonly AuditTraceSummary[],
  sort: TraceSort,
): AuditTraceSummary[] {
  const rows = [...traces];
  if (sort === "tokens") {
    return rows.sort((left, right) => traceTokens(right) - traceTokens(left));
  }
  if (sort === "duration") {
    return rows.sort((left, right) => right.durationMs - left.durationMs);
  }
  return rows.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/**
 * Token spend per trace.
 *
 * A trace can span several Agents, and the rollup does not say which of them
 * spent what — so the ranking stays at the level the counters were actually
 * reported at rather than inventing a per-Agent split.
 */
function traceHotspots(
  traces: readonly AuditTraceSummary[],
  labelFor: (trace: AuditTraceSummary) => string | null,
): TokenHotspot[] {
  return traces.map((trace) => {
    const row = emptyHotspot(
      trace.traceId,
      trace.rootSummary || trace.rootType || shortId(trace.traceId),
      labelFor(trace),
    );
    addTokens(row, trace.tokens);
    return row;
  });
}

interface AgentLabel {
  name: string;
  deleted: boolean;
}

/**
 * Agent identity for the trace table.
 *
 * Names come from the Run records rather than the live Agent directory, so a
 * deleted Agent still reads as itself instead of as an unknown ID.
 */
function agentLabels(runs: readonly RunHistoryEntry[]): Map<string, AgentLabel> {
  const labels = new Map<string, AgentLabel>();
  for (const run of runs) {
    if (labels.has(run.agentId)) continue;
    labels.set(run.agentId, { name: run.agentName, deleted: run.agentDeleted });
  }
  return labels;
}

export function TraceRunsView({
  projectId,
  agentId,
  onOpenTrace,
  onOpenRun,
}: TraceRunsViewProps) {
  const [tab, setTab] = useState<Tab>("runs");
  const [traces, setTraces] = useState<AuditTraceSummary[] | null>(null);
  const [labels, setLabels] = useState<Map<string, AgentLabel>>(new Map());
  const [status, setStatus] = useState<FilterValue>("all");
  const [sort, setSort] = useState<TraceSort>("recent");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"jsonl" | "csv" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [result, history] = await Promise.all([
        api.traces({ projectId, agentId }),
        api.runHistory({ ...(agentId === undefined ? {} : { agentId }), limit: 200 }),
      ]);
      setTraces(result.traces);
      setLabels(agentLabels(history.runs));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load traces");
    } finally {
      setLoading(false);
    }
  }, [projectId, agentId]);

  useEffect(() => {
    if (tab === "traces") void load();
  }, [load, tab]);

  const rows = useMemo(
    () => sortTraces(statusFilter(traces ?? [], status), sort),
    [traces, status, sort],
  );
  const agentNames = useCallback(
    (trace: AuditTraceSummary) =>
      trace.agentIds.map((id) => labels.get(id)?.name ?? shortId(id)).join(", ") || null,
    [labels],
  );
  const hotspots = useMemo(() => traceHotspots(rows, agentNames), [rows, agentNames]);
  const peakTokens = useMemo(
    () => rows.reduce((peak, trace) => Math.max(peak, traceTokens(trace)), 0),
    [rows],
  );
  const windowTokens = useMemo(
    () => rows.reduce((sum, trace) => sum + Math.max(0, traceTokens(trace)), 0),
    [rows],
  );

  const runExport = async (format: "jsonl" | "csv") => {
    setExporting(format);
    try {
      const blob = await api.auditExport({ format, projectId, agentId });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "audit-export." + format;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not export audit records");
    } finally {
      setExporting(null);
    }
  };

  const renderAgents = (trace: AuditTraceSummary) => {
    if (trace.agentIds.length === 0) return "—";
    return trace.agentIds.map((id) => {
      const label = labels.get(id);
      return (
        <span key={id} className="trace-agent-label">
          {label?.name ?? shortId(id)}
          {label?.deleted && <span className="trace-deleted-badge">Deleted</span>}
        </span>
      );
    });
  };

  return (
    <div className="insights-view trace-runs">
      <header className="insights-head">
        <div>
          <span className="eyebrow">Observability</span>
          <h2>Runs &amp; traces</h2>
          <p>
            Every execution across every Agent, end to end — the steps it took and where it
            stopped. History is kept after an Agent is deleted.
          </p>
        </div>
        <div className="trace-head-actions">
          <div className="insights-range" role="group" aria-label="Observability view">
            <button
              type="button"
              className={"button" + (tab === "runs" ? " is-active" : "")}
              aria-pressed={tab === "runs"}
              onClick={() => setTab("runs")}
            >
              Runs
            </button>
            <button
              type="button"
              className={"button" + (tab === "traces" ? " is-active" : "")}
              aria-pressed={tab === "traces"}
              onClick={() => setTab("traces")}
            >
              Traces
            </button>
          </div>
          <div className="insights-range" role="group" aria-label="Export">
            <button
              type="button"
              className="button"
              disabled={exporting !== null}
              onClick={() => void runExport("jsonl")}
            >
              JSONL
            </button>
            <button
              type="button"
              className="button"
              disabled={exporting !== null}
              onClick={() => void runExport("csv")}
            >
              CSV
            </button>
          </div>
        </div>
      </header>

      {error && <p className="trace-error">{error}</p>}

      {tab === "runs" ? (
        <RunListView onOpenRun={onOpenRun} {...(agentId === undefined ? {} : { agentId })} />
      ) : (
        <>
          <div className="run-list-toolbar">
            <div className="insights-range" role="group" aria-label="Status filter">
              {FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={"button" + (status === filter.value ? " is-active" : "")}
                  aria-pressed={status === filter.value}
                  onClick={() => setStatus(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="insights-range" role="group" aria-label="Sort traces">
              {TRACE_SORTS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={"button" + (sort === option.value ? " is-active" : "")}
                  aria-pressed={sort === option.value}
                  onClick={() => setSort(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button type="button" className="button" onClick={() => void load()}>
              Refresh
            </button>
          </div>

          {loading && traces === null ? (
            <div className="insights-centered">
              <Spinner />
              <p>Loading traces…</p>
            </div>
          ) : rows.length === 0 ? (
            <p className="usage-empty">No traces recorded yet.</p>
          ) : (
            <>
            <TokenHotspots
              title="Where the tokens went"
              subject="trace"
              rows={hotspots}
              onSelect={(traceId) => {
                const trace = rows.find((item) => item.traceId === traceId);
                const runId = trace?.runIds.length === 1 ? trace.runIds[0] : undefined;
                if (runId === undefined) onOpenTrace(traceId);
                else onOpenRun(runId);
              }}
            />
            <div className="usage-table-scroll">
              <table className="usage-table trace-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Root</th>
                    <th>Agents</th>
                    <th>Status</th>
                    <th className="numeric">Duration</th>
                    <th className="token-column">Processed</th>
                    <th className="numeric">Events</th>
                    <th className="numeric">Tools</th>
                    <th className="numeric">Sandbox</th>
                    <th className="numeric">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((trace) => {
                    // A trace of a single Run opens the Run detail, so both
                    // entry points land on the same page.
                    const open = () => {
                      const runId = trace.runIds.length === 1 ? trace.runIds[0] : undefined;
                      if (runId === undefined) onOpenTrace(trace.traceId);
                      else onOpenRun(runId);
                    };
                    return (
                      <tr
                        key={trace.traceId}
                        className="trace-row"
                        tabIndex={0}
                        role="button"
                        onClick={open}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            open();
                          }
                        }}
                      >
                        <td>{formatStarted(trace.startedAt)}</td>
                        <td>
                          <strong>{trace.rootType ?? "—"}</strong>
                          <span className="trace-row-sub">{trace.rootSummary}</span>
                        </td>
                        <td>{renderAgents(trace)}</td>
                        <td>
                          <span className={"trace-pill trace-pill-" + trace.status}>
                            {trace.status}
                          </span>
                        </td>
                        <td className="numeric">{formatDuration(trace.durationMs)}</td>
                        <td className="token-column" title={describeTokens(trace.tokens)}>
                          <span className="token-cell">
                            <span className="token-cell-figures">
                              <strong>{formatTokenCell(trace.tokens)}</strong>
                              {windowTokens > 0 && traceTokens(trace) > 0 && (
                                <span className="token-cell-share">
                                  {formatPercent(trace.tokens.netNewTokens, windowTokens)}
                                </span>
                              )}
                            </span>
                            {peakTokens > 0 && traceTokens(trace) > 0 && (
                              <span
                                className="token-cell-bar"
                                style={{
                                  width: (trace.tokens.netNewTokens / peakTokens) * 100 + "%",
                                }}
                              >
                                <TokenSplitBar hotspot={trace.tokens} />
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="numeric">{trace.eventCount}</td>
                        <td className="numeric">{trace.countsByCategory.tool_call ?? 0}</td>
                        <td className="numeric">{trace.countsByCategory.sandbox_execution ?? 0}</td>
                        <td className="numeric">{trace.failingStep ? "!" : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
