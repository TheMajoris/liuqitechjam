import { useState } from "react";
import { formatCount, formatPercent } from "../insights/usage-format";
import type {
  ReceiptChain,
  ReceiptToolLine,
  TokenReceipt as Receipt,
} from "./token-receipt";

/**
 * Why this reads as a receipt rather than as a chart.
 *
 * The counters were already on screen; what was missing was that they add up.
 * A reader seeing 20K, 115K, 20K down a tree has no way to tell which of those
 * they could have avoided. Four line items that sum to the total do tell them.
 *
 * There is deliberately no running subtotal. A receipt that accumulates down
 * the page invites the reader to add the same tokens twice — the exact
 * misreading this panel replaced.
 */
const RECEIPT_HELP: Record<string, string> = {
  opening:
    "The first prompt of each thread: the system prompt, the tool definitions, " +
    "and the opening instruction. Paid once per thread — a run that resumes an " +
    "existing thread pays none of it, and reads zero here.",
  added:
    "Context appended between turns: tool results and anything new you sent. " +
    "This is the only line that grows because of work the agent chose to do.",
  output:
    "Everything the model generated: the reply itself plus any thinking it did " +
    "before answering. The only line here that is not prompt.",
  resent:
    "Prompt that had already been sent before and was charged again. A model " +
    "has no memory between turns, so every turn re-sends the conversation so " +
    "far — a run that resumes a thread pays for all of it again on arrival.",
};

const CACHE_MEMO =
  "Served from the provider's prompt cache instead of being processed again. " +
  "Not an extra charge and not an extra line — it is the discounted part of " +
  "the line above it.";

/**
 * Money, at the precision the figure deserves.
 *
 * Sub-cent amounts are ordinary here — a cache read is priced per million —
 * so a plain two-decimal currency format would render most of this receipt as
 * $0.00 and make the cheap lines indistinguishable from free ones.
 */
export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "$" + value.toFixed(4);
  if (value < 1) return "$" + value.toFixed(3);
  return "$" + value.toFixed(2);
}

interface LineProps {
  label: string;
  help: string;
  value: number;
  total: number;
  cost?: number | undefined;
  /** Rendered when the line is opened; absent means the line does not open. */
  detail?: React.ReactNode;
  detailLabel?: string;
  muted?: boolean;
}

function ReceiptLine({
  label,
  help,
  value,
  total,
  cost,
  detail,
  detailLabel = "Break down",
  muted,
}: LineProps) {
  const [open, setOpen] = useState(false);
  const openable = detail !== undefined && value > 0;
  return (
    <>
      <li className={"token-receipt-line" + (muted ? " is-muted" : "")}>
        {openable ? (
          <button
            type="button"
            className="token-receipt-label is-openable"
            aria-expanded={open}
            title={help}
            onClick={() => setOpen((current) => !current)}
          >
            <span className="token-receipt-caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            {label}
            <span className="token-receipt-detail-hint">
              {open ? "Hide" : detailLabel}
            </span>
          </button>
        ) : (
          <span className="token-receipt-label" title={help}>
            {label}
          </span>
        )}
        <span className="token-receipt-share">{formatPercent(value, total)}</span>
        <span className="token-receipt-figure">{formatCount(value)}</span>
        {cost !== undefined && (
          <span className="token-receipt-money">{formatUsd(cost)}</span>
        )}
      </li>
      {open && openable && <li className="token-receipt-detail">{detail}</li>}
    </>
  );
}

/** A detail table: same three columns as the lines above it, indented. */
function DetailRows({
  rows,
  total,
  note,
}: {
  rows: { id: string; left: React.ReactNode; value: number }[];
  total: number;
  note?: string;
}) {
  return (
    <div className="token-receipt-detail-inner">
      <ol className="token-receipt-sublines">
        {rows.map((row) => (
          <li key={row.id}>
            <span className="token-receipt-subline-label">{row.left}</span>
            <span className="token-receipt-share">
              {formatPercent(row.value, total)}
            </span>
            <span className="token-receipt-figure">{formatCount(row.value)}</span>
          </li>
        ))}
      </ol>
      {note && <p className="token-receipt-estimate-note">{note}</p>}
    </div>
  );
}

function threadRows(
  chains: ReceiptChain[],
  pick: (chain: ReceiptChain) => number,
) {
  return chains
    .filter((chain) => pick(chain) > 0)
    .sort((left, right) => pick(right) - pick(left))
    .map((chain) => ({
      id: chain.id,
      value: pick(chain),
      left: (
        <>
          <span className="token-receipt-kind">thread</span>
          <code>{chain.label}</code>
          <span className="token-receipt-calls">
            {chain.turns === 1 ? "1 turn" : chain.turns + " turns"}
          </span>
        </>
      ),
    }));
}

function toolRows(lines: ReceiptToolLine[], other: number) {
  const rows = lines.map((line) => ({
    id: line.id,
    value: line.estimatedTokens,
    left: (
      <>
        <span className={"token-receipt-kind is-" + line.kind}>{line.kind}</span>
        <code>{line.label}</code>
        <span className="token-receipt-calls">
          {line.calls === 1 ? "1 call" : line.calls + " calls"}
        </span>
      </>
    ),
  }));
  if (other > 0) {
    rows.push({
      id: "__other",
      value: other,
      left: <span className="is-other">Instructions and other appended content</span>,
    });
  }
  return rows;
}

/**
 * The billed total, broken into lines that sum to it.
 *
 * Nothing here is ranked or rescaled: a receipt that reorders itself by size
 * stops being checkable against the total, and being checkable is the point.
 */
export function TokenReceipt({
  receipt,
  scope,
}: {
  receipt: Receipt;
  /** Rendered above the lines so the total is never read at the wrong scope. */
  scope?: React.ReactNode;
}) {
  if (receipt.availability === "unavailable" || receipt.billedTokens === 0) {
    return (
      <p className="usage-empty">
        No model call in this trace reported token counters, so there is nothing
        to bill.
      </p>
    );
  }
  const {
    billedTokens,
    openingTokens,
    addedTokens,
    outputTokens,
    resentTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    chainLines,
    toolLines,
  } = receipt;
  const multiThread = chainLines.length > 1;
  const answerTokens =
    reasoningOutputTokens === null ? null : outputTokens - reasoningOutputTokens;

  return (
    <div className="token-receipt">
      {scope}
      <p className="token-receipt-sub">
        {receipt.turnsReporting} model{" "}
        {receipt.turnsReporting === 1 ? "turn" : "turns"}
        {receipt.chains > 1 && ` · ${receipt.chains} threads`}
        {receipt.availability === "partial" &&
          ` · ${receipt.turnsMissing} reported no counters, so this is an undercount`}
      </p>

      <ol className="token-receipt-lines">
        <ReceiptLine
          label="Opening prompt & setup"
          {...(receipt.cost ? { cost: receipt.cost.opening } : {})}
          help={RECEIPT_HELP.opening}
          value={openingTokens}
          total={billedTokens}
          detailLabel="By thread"
          {...(multiThread
            ? {
                detail: (
                  <DetailRows
                    rows={threadRows(chainLines, (chain) => chain.openingTokens)}
                    total={openingTokens}
                    note={
                      "Each thread pays its own opening. Trimming the system " +
                      "prompt or the tool definitions cuts every row at once."
                    }
                  />
                ),
              }
            : {})}
        />

        <ReceiptLine
          label="Added along the way"
          {...(receipt.cost ? { cost: receipt.cost.added } : {})}
          help={RECEIPT_HELP.added}
          value={addedTokens}
          total={billedTokens}
          detailLabel="What added it?"
          {...(toolLines.length > 0 || receipt.otherAddedTokens > 0
            ? {
                detail: (
                  <DetailRows
                    rows={toolRows(toolLines, receipt.otherAddedTokens)}
                    total={addedTokens}
                    note={
                      toolLines.length === 0
                        ? "No tool recorded the size of its result for this " +
                          "scope, so none of this could be attributed. Runs " +
                          "recorded before result sizes were captured will " +
                          "always land here."
                        : "Tool figures are estimated from the size of each " +
                          "result" +
                          (receipt.toolEstimateScaled
                            ? ", scaled to fit the growth actually measured — " +
                              "the runtime truncated some output before " +
                              "appending it."
                            : ". Every other figure here is measured.")
                    }
                  />
                ),
              }
            : {})}
        />

        <ReceiptLine
          label="Model output"
          {...(receipt.cost ? { cost: receipt.cost.output } : {})}
          help={RECEIPT_HELP.output}
          value={outputTokens}
          total={billedTokens}
          detailLabel="Split"
          {...(reasoningOutputTokens !== null && reasoningOutputTokens > 0
            ? {
                detail: (
                  <DetailRows
                    total={outputTokens}
                    rows={[
                      {
                        id: "reasoning",
                        value: reasoningOutputTokens,
                        left: <span>Thinking before answering</span>,
                      },
                      {
                        id: "answer",
                        value: answerTokens ?? 0,
                        left: <span>The answer itself</span>,
                      },
                    ]}
                  />
                ),
              }
            : {})}
        />

        <ReceiptLine
          label="Conversation re-sent"
          {...(receipt.cost ? { cost: receipt.cost.resent } : {})}
          help={RECEIPT_HELP.resent}
          value={resentTokens}
          total={billedTokens}
          muted
          detailLabel="By thread"
          {...(multiThread
            ? {
                detail: (
                  <DetailRows
                    rows={threadRows(chainLines, (chain) => chain.resentTokens)}
                    total={resentTokens}
                    note={
                      "Only threads that inherited a prompt appear here; a " +
                      "thread that opened and stopped re-sends nothing."
                    }
                  />
                ),
              }
            : {})}
        />
        {/* Absent is not zero. A provider that never reported a cache counter
            gets a stated unknown; only a provider that measured one gets a
            figure, even when that figure is zero. */}
        {receipt.cacheReported ? (
          <li className="token-receipt-memo-line" title={CACHE_MEMO}>
            <span className="token-receipt-label">…of which served from cache</span>
            <span className="token-receipt-figure">
              {cachedInputTokens > 0 ? "−" + formatCount(cachedInputTokens) : "0"}
            </span>
          </li>
        ) : (
          resentTokens > 0 && (
            <li className="token-receipt-memo-line is-unknown">
              <span className="token-receipt-label">
                …of which served from cache
              </span>
              <span className="token-receipt-figure">not reported</span>
            </li>
          )
        )}
      </ol>

      <p className={"token-receipt-total" + (receipt.cost ? " has-money" : "")}>
        <span>Billed</span>
        <strong>{formatCount(billedTokens)}</strong>
        {receipt.cost && (
          <strong className="token-receipt-money">
            {formatUsd(receipt.cost.total)}
          </strong>
        )}
      </p>

      {receipt.cost && receipt.cost.withoutCache > receipt.cost.total && (
        // The saving, not the list price. A cache read costs a fraction of a
        // miss, so what caching is worth is invisible unless the counterfactual
        // is stated next to the bill.
        <p className="token-receipt-note">
          Without the cache these same tokens would have cost{" "}
          <strong>{formatUsd(receipt.cost.withoutCache)}</strong> — caching saved{" "}
          <strong>
            {formatUsd(receipt.cost.withoutCache - receipt.cost.total)}
          </strong>{" "}
          ({formatPercent(
            receipt.cost.withoutCache - receipt.cost.total,
            receipt.cost.withoutCache,
          )}).
        </p>
      )}

      {receipt.cacheReported && cachedInputTokens > 0 && (
        // The Run list ranks by what the model processed, not by the bill, so
        // the two figures differ by exactly the cache read. Stated here rather
        // than left for a reader to discover as a contradiction.
        <p className="token-receipt-note">
          Processed fresh, with cache reads taken out:{" "}
          <strong>{formatCount(receipt.processedTokens)}</strong>. That is the
          figure the Run list ranks by; the bill above is what was charged.
        </p>
      )}

      {/* A measured zero against a large re-send is the signal that prompt
          caching is off at the provider, which is worth saying outright: the
          figure is easy to read as "nothing to save here" when it means the
          opposite. */}
      {receipt.cacheReported && cachedInputTokens === 0 && resentTokens > 0 && (
        <p className="token-receipt-note">
          <strong>0% cache hit.</strong> The provider reported the counter and
          measured no cache reads, so all {formatCount(resentTokens)} re-sent
          above was reprocessed at full price. Prompt caching is an
          endpoint-level setting on Volcengine Ark rather than a request
          parameter — if it is enabled, this line should stop reading zero.
        </p>
      )}

      {!receipt.cacheReported && resentTokens > 0 && (
        <p className="token-receipt-note">
          This provider reported no cache counters, so how much of the{" "}
          {formatCount(resentTokens)} re-sent above was discounted is unknown —
          treat it as billed in full until the provider says otherwise.
        </p>
      )}

      {receipt.restarts > 0 && (
        <p className="token-receipt-note">
          {receipt.restarts} {receipt.restarts === 1 ? "turn" : "turns"} started
          from a smaller prompt than the turn before, so the thread was compacted
          or restarted there. Those prompts are billed as a new opening.
        </p>
      )}
    </div>
  );
}
