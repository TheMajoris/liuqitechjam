import { formatCount, formatPercent } from "../insights/usage-format";
import type { RunTokenTotals } from "../../types";

export interface TokenHotspot {
  id: string;
  label: string;
  /** Secondary identity: the model, the provider, the Agent. */
  meta?: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Fresh input across this row's Runs, each Run's cache reads removed. */
  netNewInputTokens: number;
  /** Fresh input plus output: what the model actually worked through. */
  netNewTokens: number;
  /** How many Runs this row rolls up, shown so a big row can be explained. */
  runs: number;
  /** Runs that reported no counters, which is why a total can be an undercount. */
  runsMissing?: number;
  /**
   * One extra clause for this row's footer, e.g. what it called.
   *
   * Tokens say how much a row cost; they never say what it did. A row that
   * knows what it did says so here rather than making a reader open it.
   */
  note?: string | null;
}

interface TokenHotspotsProps {
  title: string;
  /** What the rows are, e.g. "Agent" or "Model". Used in the empty state. */
  subject: string;
  rows: TokenHotspot[];
  /** Rows beyond this fold into a single "everything else" bar. */
  limit?: number;
  onSelect?: (id: string) => void;
  /** Marks the row a selection elsewhere is currently scoped to. */
  selectedId?: string | null;
}

/**
 * Token vocabulary, in one place.
 *
 * A provider reports three counters, and only two of them add up: the total
 * charged for a call is `input + output`. `cached` is not a third bucket — it
 * is the slice of the input that was served from the provider's prompt cache
 * instead of being processed fresh, so it is already inside `input` and is
 * billed at a lower rate. Summing all three double-counts the cache.
 */
export const CACHED_TOKENS_HELP =
  "Cached input is the part of the prompt the provider served from its prompt " +
  "cache instead of processing again. It is already counted inside input, not " +
  "added to it, and is billed at a lower rate — so a high cache share on a " +
  "large prompt is cheap, and a low one is not.";

/**
 * Why these rows count fresh input rather than billed input.
 *
 * Runs resume a Codex thread, and every turn re-sends the conversation so far
 * as its prompt. Ranking by billed input therefore ranks by how long a
 * conversation has run rather than by how much work it caused: a thread's
 * opening prompt is counted again in every turn that follows it.
 */
export const NET_NEW_TOKENS_HELP =
  "Fresh input plus output — what the model actually had to process for these " +
  "runs. Because each turn re-sends the conversation so far, the billed input " +
  "counts the same prefix once per turn; this counts it once.";

export interface TokenParts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** What a reader is actually charged for: fresh input, cache reads, output. */
export function tokenSegments(parts: TokenParts) {
  const cached = Math.max(0, Math.min(parts.cachedInputTokens, parts.inputTokens));
  const fresh = Math.max(0, parts.inputTokens - cached);
  const output = Math.max(0, parts.outputTokens);
  return {
    fresh,
    cached,
    output,
    /** Matches the server: the total is input plus output, cache included in input. */
    total: Math.max(0, parts.inputTokens) + output,
    /** What the model worked through, with the re-sent cached prefix removed. */
    netNew: fresh + output,
  };
}

interface SplitProps {
  hotspot: TokenParts;
}

/**
 * Where the model's work actually went.
 *
 * The bar is the net-new total — fresh input plus output — split into the two
 * things the model had to process. Cache reads are deliberately absent: they
 * are prompt the model did not reprocess, and on a resumed thread they are the
 * same prefix arriving again every turn, so giving them bar width would make a
 * long conversation look like a busy one. The footer reports them instead.
 */
export function TokenSplitBar({ hotspot }: SplitProps) {
  const { fresh, output, netNew } = tokenSegments(hotspot);
  if (netNew <= 0) return null;
  const parts = [
    { key: "input", label: "Fresh input", value: fresh },
    { key: "output", label: "Output", value: output },
  ];
  return (
    <span
      className="token-split"
      role="img"
      aria-label={parts
        .map((part) => `${part.label} ${formatCount(part.value)}`)
        .join(", ")}
    >
      {parts.map((part) => (
        <span
          key={part.key}
          className={"token-split-part is-" + part.key}
          style={{ width: (part.value / netNew) * 100 + "%" }}
          title={`${part.label}: ${formatCount(part.value)} (${formatPercent(part.value, netNew)} of what the model processed)`}
        />
      ))}
    </span>
  );
}

/** The legend for what the bar shows, stated once per panel rather than per row. */
export function TokenSplitLegend() {
  return (
    <ul className="token-split-legend">
      <li><span className="token-split-part is-input" aria-hidden="true" /> Fresh input</li>
      <li><span className="token-split-part is-output" aria-hidden="true" /> Output</li>
    </ul>
  );
}

/** Rolls a Run's reported totals into a hotspot accumulator. */
export function addTokens(into: TokenHotspot, tokens: RunTokenTotals | undefined): void {
  into.runs += 1;
  if (!tokens || tokens.availability === "unavailable") {
    into.runsMissing = (into.runsMissing ?? 0) + 1;
    return;
  }
  into.inputTokens += tokens.inputTokens;
  into.cachedInputTokens += tokens.cachedInputTokens;
  into.outputTokens += tokens.outputTokens;
  into.totalTokens += tokens.totalTokens;
  // Taken from the server rather than recomputed here: the cache clamp has to
  // happen per Run, and by this point the counters are already summed.
  into.netNewInputTokens += tokens.netNewInputTokens;
  into.netNewTokens += tokens.netNewTokens;
  if (tokens.availability === "partial") {
    into.runsMissing = (into.runsMissing ?? 0) + tokens.runsMissing;
  }
}

export function emptyHotspot(id: string, label: string, meta?: string | null): TokenHotspot {
  return {
    id,
    label,
    ...(meta === undefined ? {} : { meta }),
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    netNewInputTokens: 0,
    netNewTokens: 0,
    runs: 0,
    runsMissing: 0,
  };
}

/**
 * Ranked token consumption.
 *
 * The question this answers is "where did the tokens go", so rows are ordered
 * by consumption rather than by time, and each bar is drawn against the largest
 * row so the leader is obvious at a glance instead of requiring arithmetic
 * across a column of numbers.
 *
 * Rows rank by net-new tokens, not billed tokens. Runs resume a Codex thread
 * and each turn re-sends the conversation so far, so billed input rises with a
 * thread's age whether or not the work grew. The billed figure stays on the
 * row, where it explains cost rather than dictating rank.
 */
export function TokenHotspots({
  title,
  subject,
  rows,
  limit = 6,
  onSelect,
  selectedId = null,
}: TokenHotspotsProps) {
  const ranked = [...rows]
    .filter((row) => row.netNewTokens > 0)
    .sort((left, right) => right.netNewTokens - left.netNewTokens);
  const total = ranked.reduce((sum, row) => sum + row.netNewTokens, 0);

  if (ranked.length === 0) {
    return (
      <section className="token-hotspots" aria-label={title}>
        <div className="token-hotspots-head">
          <h3>{title}</h3>
        </div>
        <p className="usage-empty">
          No {subject.toLowerCase()}s reported token counters in this view.
        </p>
      </section>
    );
  }

  const shown = ranked.slice(0, limit);
  const rest = ranked.slice(limit);
  const restTokens = rest.reduce((sum, row) => sum + row.netNewTokens, 0);
  // One scale for the whole column, the folded tail included. The tail sums
  // many rows and is regularly larger than any single one, so drawing it
  // against the leader ran it past the panel edge while implying the two were
  // the same kind of quantity. Sharing a scale keeps every length comparable:
  // when the tail is the biggest thing here, it is the bar that fills the row.
  const peak = Math.max(shown[0]?.netNewTokens ?? 0, restTokens, 1);

  return (
    <section className="token-hotspots" aria-label={title}>
      <div className="token-hotspots-head">
        <h3>{title}</h3>
        <div className="token-hotspots-head-side">
          <span className="token-hotspots-total" title={NET_NEW_TOKENS_HELP}>
            {formatCount(total)} tokens processed
          </span>
          <TokenSplitLegend />
        </div>
      </div>

      <ol className="token-hotspot-list">
        {shown.map((row) => {
          const share = formatPercent(row.netNewTokens, total);
          const body = (
            <>
              {/*
                * The label is its own element so it can be clipped: a task
                * prompt runs to any length, and a row that grows with it
                * pushes the figure a reader came for off to one side. The
                * full text stays reachable on hover.
                */}
              <span
                className="token-hotspot-name"
                title={row.meta ? row.label + " · " + row.meta : row.label}
              >
                <span className="token-hotspot-label">{row.label}</span>
                {row.meta && <span className="token-hotspot-meta">{row.meta}</span>}
              </span>
              <span className="token-hotspot-figures">
                <strong title={NET_NEW_TOKENS_HELP}>{formatCount(row.netNewTokens)}</strong>
                <span className="token-hotspot-share">{share}</span>
              </span>
              <span
                className="token-hotspot-bar"
                style={{ width: (row.netNewTokens / peak) * 100 + "%" }}
              >
                <TokenSplitBar hotspot={row} />
              </span>
              <span className="token-hotspot-foot">
                {row.runs} {row.runs === 1 ? "run" : "runs"}
                {row.runsMissing ? ` · ${row.runsMissing} reported nothing` : ""}
                {" · "}
                {formatCount(row.netNewInputTokens)} fresh input ·{" "}
                {formatCount(row.outputTokens)} output ·{" "}
                <span title={CACHED_TOKENS_HELP}>
                  {formatCount(row.cachedInputTokens)} re-sent from cache
                </span>
                {" · "}
                {formatCount(row.totalTokens)} billed
                {row.note ? " · " + row.note : ""}
              </span>
            </>
          );
          const selected = selectedId !== null && selectedId === row.id;
          return (
            <li key={row.id} className={"token-hotspot" + (selected ? " is-selected" : "")}>
              {onSelect ? (
                <button
                  type="button"
                  aria-pressed={selectedId === null ? undefined : selected}
                  onClick={() => onSelect(row.id)}
                >
                  {body}
                </button>
              ) : (
                <div>{body}</div>
              )}
            </li>
          );
        })}
        {rest.length > 0 && (
          <li className="token-hotspot is-rest">
            <div>
              <span className="token-hotspot-name">
                {rest.length} other {rest.length === 1 ? subject : subject + "s"}
              </span>
              <span className="token-hotspot-figures">
                <strong>{formatCount(restTokens)}</strong>
                <span className="token-hotspot-share">
                  {formatPercent(restTokens, total)}
                </span>
              </span>
              <span
                className="token-hotspot-bar"
                style={{ width: (restTokens / peak) * 100 + "%" }}
              >
                <span className="token-split">
                  <span className="token-split-part is-rest" style={{ width: "100%" }} />
                </span>
              </span>
            </div>
          </li>
        )}
      </ol>
    </section>
  );
}
