import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import type { UsageReport } from "../../types";
import { Spinner } from "../playground/Spinner";
import { UsageSparkline } from "./UsageSparkline";
import { UsageBreakdownTable, type UsageBreakdownRow } from "./UsageBreakdownTable";
import {
  availabilityLabel,
  formatCount,
  formatDuration,
  formatPercent,
  tokenCaveat,
} from "./usage-format";

/** Windows offered by the range picker, in days. */
const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

interface InsightsViewProps {
  onSelectAgent: (agentId: string) => void;
  onSelectSession: (sessionId: string) => void;
}

function windowStart(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function InsightsView({ onSelectAgent, onSelectSession }: InsightsViewProps) {
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (windowDays: number, showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const result = await api.usage({ since: windowStart(windowDays), days: windowDays });
      setReport(result.usage);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days, true);
  }, [days, load]);

  // Refresh quietly while the tab is open; a run finishing should show up
  // without the viewer reaching for a reload.
  useEffect(() => {
    const timer = window.setInterval(() => void load(days, false), 20_000);
    return () => window.clearInterval(timer);
  }, [days, load]);

  const agentRows = useMemo<UsageBreakdownRow[]>(
    () =>
      (report?.agents ?? []).map((agent) => ({
        ...agent,
        id: agent.agentId,
        fallbackName: "Deleted Agent",
        meta: agent.modelLabel,
      })),
    [report],
  );

  const workspaceRows = useMemo<UsageBreakdownRow[]>(
    () =>
      (report?.workspaces ?? []).map((workspace) => ({
        ...workspace,
        id: workspace.orchestrationId,
        fallbackName: "Deleted workspace",
        meta: workspace.participants > 0 ? workspace.participants + " Agents" : null,
      })),
    [report],
  );

  const projectRows = useMemo<UsageBreakdownRow[]>(
    () =>
      (report?.projects ?? []).map((project) => ({
        ...project,
        id: project.projectId,
        fallbackName: "Deleted Project",
        meta: null,
      })),
    [report],
  );

  if (loading && report === null) {
    return (
      <div className="insights-view insights-centered">
        <Spinner />
        <p>Loading usage…</p>
      </div>
    );
  }

  if (report === null) {
    return (
      <div className="insights-view insights-centered">
        <h2>Usage is unavailable</h2>
        <p>{error ?? "No usage has been recorded yet."}</p>
        <button className="button button-primary" onClick={() => void load(days, true)}>
          Retry
        </button>
      </div>
    );
  }

  const { totals } = report;
  const caveat = tokenCaveat(totals.tokens, totals.runs.total);

  return (
    <div className="insights-view">
      <header className="insights-head">
        <div>
          <span className="eyebrow">Observability</span>
          <h2>Insights</h2>
          <p>
            Runs, tokens, and tool calls across every Agent and shared workspace.
          </p>
        </div>
        <div className="insights-range" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              className={"button button-ghost" + (days === range.days ? " is-active" : "")}
              aria-pressed={days === range.days}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </header>

      {error !== null && (
        <p className="usage-stale" role="status">
          Showing the last successful load — {error}
        </p>
      )}

      <div className="usage-tiles">
        <article className="usage-tile">
          <span className="usage-tile-label">Runs</span>
          <strong>{formatCount(totals.runs.total)}</strong>
          <span className="usage-tile-foot">
            {formatPercent(totals.runs.completed, totals.runs.total)} completed
            {totals.runs.active > 0 && ` · ${totals.runs.active} active`}
          </span>
        </article>

        <article className="usage-tile">
          <span className="usage-tile-label">
            Tokens
            <span className={"usage-chip usage-chip-" + totals.tokens.availability}>
              {availabilityLabel(totals.tokens.availability)}
            </span>
          </span>
          <strong>
            {totals.tokens.availability === "unavailable"
              ? "—"
              : formatCount(totals.tokens.totalTokens)}
          </strong>
          <span className="usage-tile-foot">
            {totals.tokens.availability === "unavailable"
              ? (caveat ?? "No counters reported")
              : `${formatCount(totals.tokens.inputTokens)} in · ` +
                `${formatCount(totals.tokens.outputTokens)} out · ` +
                `${formatCount(totals.tokens.cachedInputTokens)} cached`}
          </span>
        </article>

        <article className="usage-tile">
          <span className="usage-tile-label">Tool calls</span>
          <strong>{formatCount(totals.activity.toolCalls)}</strong>
          <span className="usage-tile-foot">
            {totals.activity.toolFailures} failed ·{" "}
            {totals.activity.approvalsRequired} needed approval
          </span>
        </article>

        <article className="usage-tile">
          <span className="usage-tile-label">Avg run</span>
          <strong>
            {totals.latency.samples === 0 ? "—" : formatDuration(totals.latency.averageMs)}
          </strong>
          <span className="usage-tile-foot">
            {totals.latency.samples === 0
              ? "No completed runs timed"
              : `p95 ${formatDuration(totals.latency.p95Ms)} · max ${formatDuration(totals.latency.maxMs)}`}
          </span>
        </article>
      </div>

      {caveat !== null && totals.tokens.availability === "partial" && (
        <p className="usage-caveat" role="note">{caveat}</p>
      )}

      <div className="usage-charts">
        <UsageSparkline points={report.daily} metric="runs" label="Runs" />
        <UsageSparkline points={report.daily} metric="totalTokens" label="Tokens" />
        <UsageSparkline points={report.daily} metric="toolCalls" label="Tool calls" />
      </div>

      <UsageBreakdownTable
        caption="By Agent"
        rows={agentRows}
        emptyMessage="No Agent has run in this window."
        onSelect={onSelectAgent}
      />
      <UsageBreakdownTable
        caption="By workspace"
        rows={workspaceRows}
        emptyMessage="No shared workspace has run in this window."
        onSelect={onSelectSession}
      />
      <UsageBreakdownTable
        caption="By Project"
        rows={projectRows}
        emptyMessage="No Project-scoped work in this window."
      />

      <footer className="insights-foot">
        Skills invoked: {totals.activity.skillInvocations} · Messages:{" "}
        {formatCount(totals.messages)} · Authorization denials:{" "}
        {totals.activity.authorizationDenials}
      </footer>
    </div>
  );
}
