import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import type { AuditTraceSummary } from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatDuration } from "../insights/usage-format";
import { statusFilter } from "./trace-tree";

interface TraceRunsViewProps {
  projectId?: string;
  agentId?: string;
  onOpenTrace: (traceId: string) => void;
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "success", label: "Success" },
  { value: "failure", label: "Failure" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

function formatStarted(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function TraceRunsView({ projectId, agentId, onOpenTrace }: TraceRunsViewProps) {
  const [traces, setTraces] = useState<AuditTraceSummary[] | null>(null);
  const [status, setStatus] = useState<FilterValue>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"jsonl" | "csv" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.traces({ projectId, agentId });
      setTraces(result.traces);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load traces");
    } finally {
      setLoading(false);
    }
  }, [projectId, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="insights-view trace-runs">
      <header className="insights-head">
        <div>
          <span className="eyebrow">Observability</span>
          <h2>Traces</h2>
          <p>Every run, end to end — the steps it took and where it stopped.</p>
        </div>
        <div className="trace-head-actions">
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
            <button type="button" className="button" onClick={() => void load()}>
              Refresh
            </button>
          </div>
        </div>
      </header>

      {error && <p className="trace-error">{error}</p>}

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
              {rows.map((trace) => (
                <tr
                  key={trace.traceId}
                  className="trace-row"
                  tabIndex={0}
                  role="button"
                  onClick={() => onOpenTrace(trace.traceId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenTrace(trace.traceId);
                    }
                  }}
                >
                  <td>{formatStarted(trace.startedAt)}</td>
                  <td>
                    <strong>{trace.rootType ?? "—"}</strong>
                    <span className="trace-row-sub">{trace.rootSummary}</span>
                  </td>
                  <td>
                    {trace.agentIds.length === 0
                      ? "—"
                      : trace.agentIds.length + " · " + trace.agentIds.map(shortId).join(", ")}
                  </td>
                  <td>
                    <span className={"trace-pill trace-pill-" + trace.status}>{trace.status}</span>
                  </td>
                  <td className="numeric">{formatDuration(trace.durationMs)}</td>
                  <td className="numeric">{trace.eventCount}</td>
                  <td className="numeric">{trace.countsByCategory.tool_call ?? 0}</td>
                  <td className="numeric">{trace.countsByCategory.sandbox_execution ?? 0}</td>
                  <td className="numeric">{trace.failingStep ? "!" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
