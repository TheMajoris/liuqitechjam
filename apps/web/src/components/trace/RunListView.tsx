import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type { RunHistoryEntry, RunStatus } from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatDuration } from "../insights/usage-format";
import { formatStarted, shortId } from "./run-format";

interface RunListViewProps {
  /** Scopes the list to one Agent; omitted for the global explorer. */
  agentId?: string;
  onOpenRun: (runId: string) => void;
  /** Suppresses the Agent column when the caller already names the Agent. */
  hideAgent?: boolean;
  emptyMessage?: string;
}

const FILTERS: { value: "all" | RunStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

export function RunListView({
  agentId,
  onOpenRun,
  hideAgent = false,
  emptyMessage = "No runs recorded yet.",
}: RunListViewProps) {
  const [runs, setRuns] = useState<RunHistoryEntry[] | null>(null);
  const [status, setStatus] = useState<"all" | RunStatus>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.runHistory({
        ...(agentId === undefined ? {} : { agentId }),
        ...(status === "all" ? {} : { status }),
      });
      setRuns(result.runs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load runs");
    } finally {
      setLoading(false);
    }
  }, [agentId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="run-list">
      <div className="run-list-toolbar">
        <div className="insights-range" role="group" aria-label="Run status filter">
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

      {error && <p className="trace-error">{error}</p>}

      {loading && runs === null ? (
        <div className="insights-centered">
          <Spinner />
          <p>Loading runs…</p>
        </div>
      ) : (runs ?? []).length === 0 ? (
        <p className="usage-empty">{emptyMessage}</p>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-table trace-table run-table">
            <thead>
              <tr>
                <th>Run</th>
                {!hideAgent && <th>Agent</th>}
                <th>Status</th>
                <th>Started</th>
                <th className="numeric">Duration</th>
                <th className="numeric">Events</th>
                <th className="numeric">Errors</th>
              </tr>
            </thead>
            <tbody>
              {(runs ?? []).map((run) => (
                <tr
                  key={run.runId}
                  className="trace-row"
                  tabIndex={0}
                  role="button"
                  onClick={() => onOpenRun(run.runId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenRun(run.runId);
                    }
                  }}
                >
                  <td>
                    <strong>Run {shortId(run.runId)}</strong>
                    <span className="trace-row-sub">{run.title}</span>
                  </td>
                  {!hideAgent && (
                    <td>
                      <strong>{run.agentName}</strong>
                      {run.agentDeleted && (
                        <span className="trace-row-sub">
                          <span className="trace-deleted-badge">Deleted</span>
                        </span>
                      )}
                    </td>
                  )}
                  <td>
                    <span className={"trace-pill trace-pill-" + (run.failed ? "failure" : "success")}>
                      {run.status}
                    </span>
                  </td>
                  <td>{formatStarted(run.startedAt ?? run.createdAt)}</td>
                  <td className="numeric">
                    {run.durationMs === null ? "—" : formatDuration(run.durationMs)}
                  </td>
                  <td className="numeric">{run.eventCount}</td>
                  <td className="numeric">{run.errorCount > 0 ? run.errorCount : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
