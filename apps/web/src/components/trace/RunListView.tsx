import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import type { RunHistoryEntry, RunStatus, RunToolUsage } from "../../types";
import { Spinner } from "../playground/Spinner";
import { formatCount, formatDuration, formatPercent } from "../insights/usage-format";
import {
  addTools,
  conversationKey,
  conversationKindLabel,
  conversationLabel,
  describeContext,
  describeConversation,
  describeTokens,
  describeTools,
  emptyTools,
  formatContextRemaining,
  formatStarted,
  formatTokenCell,
  formatToolCell,
  shortId,
  matchesQuery,
  summarizeTools,
  toolNamesInCell,
  toolTotal,
} from "./run-format";
import { CloseIcon, GroupIcon, RefreshIcon, SearchIcon, SortIcon } from "./icons";
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
  /**
   * Opens one Run. The Runs currently in view are handed over with it so the
   * detail page can step to the next one in the order the reader was already
   * reading, rather than in some order of its own.
   */
  onOpenRun: (runId: string, siblings: readonly string[]) => void;
  /** Suppresses the Agent column when the caller already names the Agent. */
  hideAgent?: boolean;
  emptyMessage?: string;
}

/**
 * Outcome filter, in words.
 *
 * These stayed labelled while sort and grouping became menus. A glyph can
 * stand in for a label only where one is conventional, and there is no
 * conventional trio for all/succeeded/failed: a tick and a cross next to a
 * search box read as confirm and cancel, which is the opposite of a filter.
 */
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

/**
 * What the token panel ranks.
 *
 * "Which Agent is expensive" and "which conversation is expensive" are
 * different questions with different answers — one Agent can be cheap in every
 * conversation but present in all of them — so the panel answers whichever one
 * the reader is asking rather than picking for them.
 */
const GROUPINGS = [
  { value: "conversation", label: "By conversation" },
  { value: "agent", label: "By Agent" },
] as const;

type SortValue = (typeof SORTS)[number]["value"];
type Grouping = (typeof GROUPINGS)[number]["value"];

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
  const tools = new Map<string, RunToolUsage>();
  for (const run of runs) {
    const existing =
      rows.get(run.agentId) ??
      emptyHotspot(run.agentId, run.agentName, run.agentDeleted ? "Deleted" : null);
    addTokens(existing, run.tokens);
    rows.set(run.agentId, existing);
    const calls = tools.get(run.agentId) ?? emptyTools();
    addTools(calls, run.tools);
    tools.set(run.agentId, calls);
  }
  for (const [agentId, row] of rows) {
    row.note = summarizeTools(tools.get(agentId) ?? emptyTools());
  }
  return [...rows.values()];
}

/**
 * Token spend per conversation across the loaded window.
 *
 * This is the rollup the Run table cannot give: a Team conversation is spread
 * over one Run per participant per turn, so its real cost is only visible once
 * those Runs are added back together. The Agents that took part become the
 * row's secondary identity, since a conversation is not owned by one of them.
 */
function hotspotsByConversation(runs: readonly RunHistoryEntry[]): TokenHotspot[] {
  const rows = new Map<string, TokenHotspot>();
  const agents = new Map<string, Set<string>>();
  const tools = new Map<string, RunToolUsage>();
  for (const run of runs) {
    const key = conversationKey(run);
    const existing = rows.get(key) ?? emptyHotspot(key, conversationLabel(run));
    addTokens(existing, run.tokens);
    rows.set(key, existing);
    const named = agents.get(key) ?? new Set<string>();
    named.add(run.agentName);
    agents.set(key, named);
    const calls = tools.get(key) ?? emptyTools();
    addTools(calls, run.tools);
    tools.set(key, calls);
  }
  for (const [key, row] of rows) {
    row.meta = [...(agents.get(key) ?? [])].join(", ");
    row.note = summarizeTools(tools.get(key) ?? emptyTools());
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
  // Grouping by Agent says nothing when the caller already named the Agent.
  const [grouping, setGrouping] = useState<Grouping>("conversation");
  const [scope, setScope] = useState<string | null>(null);
  const [query, setQuery] = useState("");
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

  const sorted = useMemo(() => sortRuns(runs ?? [], sort), [runs, sort]);
  // Selecting a conversation in the panel opens it: the table below becomes
  // that conversation's Runs, in the same columns, rather than a separate page.
  const rows = useMemo(() => {
    const scoped =
      scope === null ? sorted : sorted.filter((run) => conversationKey(run) === scope);
    return query.trim() === "" ? scoped : scoped.filter((run) => matchesQuery(run, query));
  }, [sorted, scope, query]);
  // The panel ranks what the search left in view, so a filtered list and the
  // totals above it never describe different sets of Runs.
  const searched = useMemo(
    () =>
      query.trim() === ""
        ? runs ?? []
        : (runs ?? []).filter((run) => matchesQuery(run, query)),
    [runs, query],
  );
  const hotspots = useMemo(
    () =>
      grouping === "agent" && !hideAgent
        ? hotspotsByAgent(searched)
        : hotspotsByConversation(searched),
    [searched, grouping, hideAgent],
  );
  const scopeLabel = useMemo(
    () => (scope === null ? null : hotspots.find((row) => row.id === scope)?.label ?? null),
    [hotspots, scope],
  );
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
  const visibleRunIds = useMemo(() => rows.map((run) => run.runId), [rows]);

  // A scope set on one grouping does not survive the other: a conversation key
  // has no meaning among Agent rows, and a stale scope would silently empty
  // the table.
  useEffect(() => {
    setScope(null);
  }, [grouping, status]);

  return (
    <div className="run-list">
      <div className="run-list-toolbar">
        <div className="control-search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            placeholder="Search runs, conversations, Agents, tools"
            aria-label="Search runs"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== "" && (
            <button
              type="button"
              className="control-search-clear"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => setQuery("")}
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>

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

        {/*
          * Sort and grouping became menus rather than nine buttons: they are
          * settings a reader changes rarely, and spelling every option out
          * left no room for the search box they reach for first.
          */}
        <label className="control-select" title="Sort runs">
          <SortIcon />
          <select
            value={sort}
            aria-label="Sort runs"
            onChange={(event) => setSort(event.target.value as SortValue)}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {!hideAgent && (
          <label className="control-select" title="Group token spend">
            <GroupIcon />
            <select
              value={grouping}
              aria-label="Group token spend"
              onChange={(event) => setGrouping(event.target.value as Grouping)}
            >
              {GROUPINGS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="button"
          className="button is-iconic"
          aria-label="Refresh runs"
          title="Refresh runs"
          onClick={() => void load()}
        >
          <RefreshIcon />
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
      ) : rows.length === 0 ? (
        // A search that matches nothing is a different state from no history:
        // the reader needs to be told which of the two they are looking at.
        <p className="usage-empty">
          No runs match “{query}”.{" "}
          <button type="button" className="link-button" onClick={() => setQuery("")}>
            Clear the search
          </button>
        </p>
      ) : (
        <>
          <TokenHotspots
            title="Where the tokens went"
            subject={grouping === "agent" && !hideAgent ? "Agent" : "conversation"}
            rows={hotspots}
            selectedId={scope}
            onSelect={(id) => setScope((current) => (current === id ? null : id))}
          />

          {scope !== null && (
            <p className="run-list-scope">
              <span>
                Showing the {rows.length} {rows.length === 1 ? "run" : "runs"} in{" "}
                <strong>{scopeLabel ?? "this group"}</strong>
              </span>
              <button type="button" className="button" onClick={() => setScope(null)}>
                Show all runs
              </button>
            </p>
          )}

          <div className="usage-table-scroll">
            <table className="usage-table trace-table run-table">
              <thead>
                <tr>
                  <th className="run-column">Run</th>
                  <th className="conversation-column">Conversation</th>
                  {!hideAgent && <th>Agent</th>}
                  <th>Status</th>
                  <th>Started</th>
                  <th className="numeric">Duration</th>
                  <th className="token-column">Processed</th>
                  <th className="tool-column">Tools</th>
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
                    onClick={() => onOpenRun(run.runId, visibleRunIds)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenRun(run.runId, visibleRunIds);
                      }
                    }}
                  >
                    <td className="run-column" title={run.title}>
                      <strong>{run.title}</strong>
                      <span className="trace-row-sub">Run {shortId(run.runId)}</span>
                    </td>
                    <td
                      className="conversation-column"
                      title={
                        (run.conversation === null ? "" : run.conversation.title + " — ") +
                        describeConversation(run)
                      }
                    >
                      {run.conversation === null ? (
                        <span className="trace-row-sub">Not in a conversation</span>
                      ) : (
                        <>
                          <strong>{run.conversation.title}</strong>
                          <span className="trace-row-sub">
                            <span
                              className={
                                "conversation-kind is-" + run.conversation.kind
                              }
                            >
                              {conversationKindLabel(run.conversation)}
                            </span>
                            {shortId(run.conversation.id)}
                          </span>
                        </>
                      )}
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
                    <td className="tool-column" title={describeTools(run.tools)}>
                      {toolTotal(run.tools) === 0 ? (
                        <span className="is-absent">{formatToolCell(run.tools)}</span>
                      ) : (
                        <>
                          <strong>{formatToolCell(run.tools)}</strong>
                          <span className="trace-row-sub">
                            {toolNamesInCell(run.tools)}
                          </span>
                        </>
                      )}
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
            {formatCount(windowTokens)} tokens in view ·{" "}
            {formatCount(
              rows.reduce((sum, run) => sum + toolTotal(run.tools), 0),
            )}{" "}
            tool calls
          </p>
        </>
      )}
    </div>
  );
}
