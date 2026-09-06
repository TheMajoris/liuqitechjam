import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import type { AuditTraceSummary, RunHistoryEntry } from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatDuration } from "../insights/usage-format";
import { RunListView } from "./RunListView";
import { formatStarted, shortId } from "./run-format";
import { statusFilter } from "./trace-tree";

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

type FilterValue = (typeof FILTERS)[number]["value"];
type Tab = "runs" | "traces";

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

  const rows = useMemo(() => statusFilter(traces ?? [], status), [traces, status]);

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
            <div className="usage-table-scroll">
              <table className="usage-table trace-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Root</th>
                    <th>Agents</th>
                    <th>Status</th>
                    <th className="numeric">Duration</th>
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
          )}
        </>
      )}
    </div>
  );
}
