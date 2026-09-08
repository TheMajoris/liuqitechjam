import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import type { RunHistoryEntry, RunStatus } from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatCount, formatDuration, formatPercent } from "../insights/usage-format";
import {
  describeContext,
  describeTokens,
  formatContextRemaining,
  formatStarted,
  formatTokenCell,
  shortId,
} from "./run-format";
import {
  TokenHotspots,
  TokenSplitBar,
  addTokens,
  emptyHotspot,
  type TokenHotspot,
} from "./TokenHotspots";

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

/**
 * Sort orders.
 *
 * Recency answers "what just happened"; token order answers "what is this
 * costing", which is a different question and needs its own entry point rather
 * than a mental scan down a column of numbers.
 */
const SORTS = [
  { value: "recent", label: "Recent" },
  { value: "tokens", label: "Most tokens" },
  { value: "duration", label: "Slowest" },
] as const;

type SortValue = (typeof SORTS)[number]["value"];

function startedAt(run: RunHistoryEntry): number {
  const parsed = Date.parse(run.startedAt ?? run.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * What a Run made the model process, for ranking and for the bar.
 *
 * Not the billed total: a Run resuming a long thread re-sends the conversation
 * so far, so billing rises with the thread's age rather than with the work.
 * The billed figure stays in the cell's tooltip.
 */
function reportedTokens(run: RunHistoryEntry): number {
  return run.tokens.availability === "unavailable" ? -1 : run.tokens.netNewTokens;
}

function sortRuns(runs: readonly RunHistoryEntry[], sort: SortValue): RunHistoryEntry[] {
  const rows = [...runs];
  if (sort === "tokens") {
    return rows.sort((left, right) => reportedTokens(right) - reportedTokens(left));
  }
  if (sort === "duration") {
    return rows.sort((left, right) => (right.durationMs ?? -1) - (left.durationMs ?? -1));
  }
  return rows.sort((left, right) => startedAt(right) - startedAt(left));
}

/** Token spend per Agent across the loaded window. */
function hotspotsByAgent(runs: readonly RunHistoryEntry[]): TokenHotspot[] {
  const rows = new Map<string, TokenHotspot>();
  for (const run of runs) {
    const existing =
      rows.get(run.agentId) ??
      emptyHotspot(run.agentId, run.agentName, run.agentDeleted ? "Deleted" : null);
    addTokens(existing, run.tokens);
    rows.set(run.agentId, existing);
  }
  return [...rows.values()];
}

export function RunListView({
  agentId,
  onOpenRun,
  hideAgent = false,
  emptyMessage = "No runs recorded yet.",
}: RunListViewProps) {
  const [runs, setRuns] = useState<RunHistoryEntry[] | null>(null);
  const [status, setStatus] = useState<"all" | RunStatus>("all");
  const [sort, setSort] = useState<SortValue>("recent");
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

  const rows = useMemo(() => sortRuns(runs ?? [], sort), [runs, sort]);
  const hotspots = useMemo(() => hotspotsByAgent(runs ?? []), [runs]);
  // Bars are drawn against the heaviest Run in view, so the outlier that
  // deserves attention is the one that fills its cell.
  const peakTokens = useMemo(
    () => rows.reduce((peak, run) => Math.max(peak, reportedTokens(run)), 0),
    [rows],
  );
  const windowTokens = useMemo(
    () => rows.reduce((sum, run) => sum + Math.max(0, reportedTokens(run)), 0),
    [rows],
  );

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
        <div className="insights-range" role="group" aria-label="Sort runs">
          {SORTS.map((option) => (
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

      {error && <p className="trace-error">{error}</p>}

      {loading && runs === null ? (
        <div className="insights-centered">
          <Spinner />
          <p>Loading runs…</p>
        </div>
      ) : rows.length === 0 ? (
        <p className="usage-empty">{emptyMessage}</p>
      ) : (
        <>
          {!hideAgent && (
            <TokenHotspots
              title="Where the tokens went"
              subject="Agent"
              rows={hotspots}
            />
          )}

          <div className="usage-table-scroll">
            <table className="usage-table trace-table run-table">
              <thead>
                <tr>
                  <th>Run</th>
                  {!hideAgent && <th>Agent</th>}
                  <th>Status</th>
                  <th>Started</th>
                  <th className="numeric">Duration</th>
                  <th className="token-column">Processed</th>
                  <th className="numeric">Context left</th>
                  <th className="numeric">Events</th>
                  <th className="numeric">Errors</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((run) => (
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
                      <span
                        className={"trace-pill trace-pill-" + (run.failed ? "failure" : "success")}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td>{formatStarted(run.startedAt ?? run.createdAt)}</td>
                    <td className="numeric">
                      {run.durationMs === null ? "—" : formatDuration(run.durationMs)}
                    </td>
                    <td className="token-column" title={describeTokens(run.tokens)}>
                      <span className="token-cell">
                        <span className="token-cell-figures">
                          <strong>{formatTokenCell(run.tokens)}</strong>
                          {windowTokens > 0 && reportedTokens(run) > 0 && (
                            <span className="token-cell-share">
                              {formatPercent(run.tokens.netNewTokens, windowTokens)}
                            </span>
                          )}
                        </span>
                        {peakTokens > 0 && reportedTokens(run) > 0 && (
                          <span
                            className="token-cell-bar"
                            style={{
                              width: (run.tokens.netNewTokens / peakTokens) * 100 + "%",
                            }}
                          >
                            <TokenSplitBar hotspot={run.tokens} />
                          </span>
                        )}
                      </span>
                    </td>
                    <td
                      className={
                        "numeric" + (run.context === null ? " is-absent" : "")
                      }
                      title={describeContext(run.context)}
                    >
                      {formatContextRemaining(run.context)}
                    </td>
                    <td className="numeric">{run.eventCount}</td>
                    <td className="numeric">{run.errorCount > 0 ? run.errorCount : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="run-list-foot">
            {rows.length} {rows.length === 1 ? "run" : "runs"} ·{" "}
            {formatCount(windowTokens)} tokens in view
          </p>
        </>
      )}
    </div>
  );
}
