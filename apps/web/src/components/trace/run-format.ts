/** Shared formatting for the Run and Trace observability views. */
import type { RunContextWindow, RunTokenTotals } from "../../types";
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
/**
 * The headline figure: what the model actually processed.
 *
 * Not the billed total. Runs resume a Codex thread and each turn re-sends the
 * conversation so far, so the billed figure grows with a thread's age whether
 * or not the work did. `describeTokens` carries the billed number.
 */
export function formatTokenCell(tokens: RunTokenTotals | undefined): string {
  if (!tokens || tokens.availability === "unavailable") return "—";
  const total = formatCount(tokens.netNewTokens);
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
    ? ` (${formatPercent(tokens.cachedInputTokens, tokens.inputTokens)} of the input was re-sent and served from cache)`
    : "";
  const caveat = tokens.availability === "partial"
    ? ` — incomplete, ${tokens.runsMissing} of ${
        tokens.runsReporting + tokens.runsMissing
      } Runs reported nothing`
    : "";
  return (
    `${formatCount(tokens.netNewInputTokens)} fresh input · ` +
    `${formatCount(tokens.outputTokens)} output · ` +
    `${formatCount(tokens.netNewTokens)} processed · ` +
    `${formatCount(tokens.totalTokens)} billed${cachedShare}${caveat}`
  );
}

/**
 * Context left in the model after a Run, for a table cell.
 *
 * Quoted in billed tokens because context is space rather than price: a prompt
 * the provider served from cache still occupied the window it was read from.
 */
export function formatContextRemaining(
  context: RunContextWindow | null,
): string {
  if (context === null) return "—";
  return formatCount(context.remainingTokens);
}

/** Long-form headroom for the same cell's tooltip. */
export function describeContext(context: RunContextWindow | null): string {
  if (context === null) {
    return (
      "No context window is configured for this Run's model, so how much of " +
      "it remains cannot be stated. Set MODEL_CONTEXT_WINDOWS to enable this."
    );
  }
  return (
    `${formatCount(context.usedTokens)} of ${formatCount(context.windowTokens)} used ` +
    `(${formatPercent(context.usedTokens, context.windowTokens)}) · ` +
    `${formatCount(context.remainingTokens)} left. Counted in billed tokens: ` +
    "input served from cache still occupies the window."
  );
}
