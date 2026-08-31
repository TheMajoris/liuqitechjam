import type { UsageTotals } from "../../types";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
} from "./usage-format";

export interface UsageBreakdownRow extends UsageTotals {
  id: string;
  name: string | null;
  fallbackName: string;
  meta: string | null;
  lastActiveAt: string | null;
}

interface UsageBreakdownTableProps {
  caption: string;
  rows: UsageBreakdownRow[];
  emptyMessage: string;
  onSelect?: (id: string) => void;
}

export function UsageBreakdownTable({
  caption,
  rows,
  emptyMessage,
  onSelect,
}: UsageBreakdownTableProps) {
  // Share bars are relative to the busiest row, so the ranking is readable
  // even when every row is small in absolute terms.
  const peak = rows.reduce((max, row) => Math.max(max, row.tokens.totalTokens), 0);

  if (rows.length === 0) {
    return (
      <section className="usage-section">
        <h3>{caption}</h3>
        <p className="usage-empty">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section className="usage-section">
      <h3>{caption}</h3>
      <div className="usage-table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="numeric">Runs</th>
              <th scope="col" className="numeric">Success</th>
              <th scope="col" className="numeric">Tokens</th>
              <th scope="col" className="numeric">Tools</th>
              <th scope="col" className="numeric">Avg run</th>
              <th scope="col" className="numeric">Last active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const name = row.name ?? row.fallbackName;
              const share = peak === 0 ? 0 : (row.tokens.totalTokens / peak) * 100;
              return (
                <tr key={row.id}>
                  <th scope="row">
                    {onSelect ? (
                      <button
                        type="button"
                        className="usage-row-link"
                        onClick={() => onSelect(row.id)}
                      >
                        {name}
                      </button>
                    ) : (
                      <span className={row.name === null ? "usage-row-gone" : ""}>{name}</span>
                    )}
                    {row.meta !== null && <span className="usage-row-meta">{row.meta}</span>}
                  </th>
                  <td className="numeric">{row.runs.total}</td>
                  <td className="numeric">
                    {formatPercent(row.runs.completed, row.runs.total)}
                    {row.runs.failed > 0 && (
                      <span className="usage-row-fail"> · {row.runs.failed} failed</span>
                    )}
                  </td>
                  <td className="numeric">
                    <span className="usage-bar-cell">
                      <span className="usage-bar-track" aria-hidden="true">
                        <span className="usage-bar-fill" style={{ width: share + "%" }} />
                      </span>
                      {row.tokens.availability === "unavailable"
                        ? "—"
                        : formatCount(row.tokens.totalTokens)}
                    </span>
                  </td>
                  <td className="numeric">{row.activity.toolCalls}</td>
                  <td className="numeric">
                    {row.latency.samples === 0 ? "—" : formatDuration(row.latency.averageMs)}
                  </td>
                  <td className="numeric">{formatRelative(row.lastActiveAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
