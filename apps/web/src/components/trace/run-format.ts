/** Shared formatting for the Run and Trace observability views. */
import type { RunTokenTotals } from "../../types";
import { formatCount, formatPercent } from "../insights/usage-format";


export function formatStarted(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Token count for one table cell.
 *
 * An em dash means the provider reported nothing, which is deliberately
 * distinct from a genuine zero; a trailing "~" marks an incomplete rollup so
 * a partial total is never read as exact.
 */
export function formatTokenCell(tokens: RunTokenTotals | undefined): string {
  if (!tokens || tokens.availability === "unavailable") return "—";
  const total = formatCount(tokens.totalTokens);
  return tokens.availability === "partial" ? total + "~" : total;
}

/**
 * Long-form breakdown for a title/tooltip on the same cell.
 *
 * The billed total is input plus output. Cached input is a slice of the input
 * counter rather than a third addend, so it is reported as a share of input —
 * quoting it against the total would imply the cache added to the bill.
 */
export function describeTokens(tokens: RunTokenTotals | undefined): string {
  if (!tokens || tokens.availability === "unavailable") {
    return "No token usage was reported for this Run.";
  }
  const cachedShare = tokens.inputTokens > 0
    ? ` (${formatPercent(tokens.cachedInputTokens, tokens.inputTokens)} of it served from cache)`
    : "";
  const caveat = tokens.availability === "partial"
    ? ` — incomplete, ${tokens.runsMissing} of ${
        tokens.runsReporting + tokens.runsMissing
      } Runs reported nothing`
    : "";
  return (
    `${formatCount(tokens.inputTokens)} input${cachedShare} · ` +
    `${formatCount(tokens.outputTokens)} output · ` +
    `${formatCount(tokens.totalTokens)} billed${caveat}`
  );
}
