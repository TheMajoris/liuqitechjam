/**
 * A token receipt: where a trace's billed tokens actually went.
 *
 * The tree beside this answers "which step", which is the wrong question when
 * every step on a resumed thread re-sends the conversation before it. A reader
 * looking at 20K, 115K, 20K cannot tell that the 115K is mostly the same
 * prompt again. This turns the same counters into line items that sum to the
 * bill, so "what should I cut" has an answer.
 *
 * The identity every figure is built to preserve:
 *
 *     opening + added + resent + output === billed
 *
 * Cache is deliberately not a line item. It is the slice of `resent` the
 * provider served cheaply, so it is reported against that line as a memo;
 * adding it would invent tokens nobody was charged for, which is exactly the
 * confusion this view exists to remove.
 */
import type { AuditEventRecord, ModelPrices } from "../../types";
import type { FlatSpan } from "./trace-tree";

/** Rough bytes-per-token for tool output, used only for the estimated split. */
const BYTES_PER_TOKEN = 4;

export type ReceiptAvailability = "available" | "partial" | "unavailable";

/** Money for one receipt line, and for the receipt as a whole. */
export interface ReceiptCost {
  opening: number;
  added: number;
  resent: number;
  output: number;
  total: number;
  /**
   * What the same tokens would have cost with every cache read priced as a
   * miss — the saving caching actually produced, rather than a list price.
   */
  withoutCache: number;
  /** Turns whose model had no configured rate, so they are missing from cost. */
  unpricedTurns: number;
}

/** One tool's estimated share of the context it appended. */
export interface ReceiptToolLine {
  id: string;
  label: string;
  kind: "sandbox" | "mcp";
  calls: number;
  bytes: number;
  /** Estimated from bytes, then fitted to the measured `added` total. */
  estimatedTokens: number;
}

/** One agent's thread, so a big line can be traced to who ran up. */
export interface ReceiptChain {
  id: string;
  label: string;
  turns: number;
  openingTokens: number;
  addedTokens: number;
  resentTokens: number;
  outputTokens: number;
  billedTokens: number;
}

export interface TokenReceiptScope {
  /**
   * Bill only this Run's turns.
   *
   * Turns outside the scope still advance their thread's running prompt size:
   * a Run that resumes a thread inherits a prefix it did not send, and reading
   * that prefix as this Run's opening would blame it for the whole history.
   */
  runId?: string | undefined;
}

export interface TokenReceipt {
  availability: ReceiptAvailability;
  /** Model turns that reported counters, and turns that reported nothing. */
  turnsReporting: number;
  turnsMissing: number;
  /** Independent turn chains: one per agent, plus one per context restart. */
  chains: number;
  /**
   * A turn whose prompt was smaller than the turn before it, meaning the
   * thread was compacted or restarted. Its prompt is counted as a new opening
   * rather than as growth, so the receipt still balances.
   */
  restarts: number;

  /** First prompt of each chain: system prompt, tool definitions, instruction. */
  openingTokens: number;
  /** Context appended between turns: tool results and new instructions. */
  addedTokens: number;
  /** The conversation replayed as the prefix of every later turn. */
  resentTokens: number;
  /** Everything the model generated. */
  outputTokens: number;
  /** Slice of output spent thinking rather than answering, when reported. */
  reasoningOutputTokens: number | null;
  /** Memo against `resentTokens`, never added to the total. */
  cachedInputTokens: number;
  /**
   * Whether any turn reported a cache counter at all.
   *
   * A provider that never reports one is not a provider that read nothing from
   * cache. Collapsing those two into a bare zero would claim the re-sent
   * conversation was charged at full price when nobody measured whether it
   * was — so the distinction is carried and the panel says which it has.
   */
  cacheReported: boolean;

  /** openingTokens + addedTokens + resentTokens + outputTokens. */
  billedTokens: number;
  /** What entered the context exactly once: opening + added + output. */
  uniqueTokens: number;

  /** Money, when every model in the trace has a configured rate. */
  cost: ReceiptCost | null;

  /** Per-thread detail behind the lines, heaviest first. */
  chainLines: ReceiptChain[];
  /**
   * Billed minus cache reads: what the model processed fresh.
   *
   * Carried so the receipt can reconcile itself against the Run list, which
   * ranks by this figure rather than by the bill.
   */
  processedTokens: number;

  /** Estimated split of `addedTokens` by the tool that produced it. */
  toolLines: ReceiptToolLine[];
  /** The part of `addedTokens` no tool output accounts for. */
  otherAddedTokens: number;
  /**
   * Tool output measured larger than the context actually grew, so the
   * estimates were scaled down to fit. Usually means the runtime truncated
   * tool output before appending it.
   */
  toolEstimateScaled: boolean;
}

interface TurnRecord {
  chainKey: string;
  runId: string | null;
  modelId: string | null;
  at: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

function metadataNumber(
  event: AuditEventRecord,
  key: string,
): number | undefined {
  const value = event.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function metadataString(event: AuditEventRecord, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Turns in the order the model saw them.
 *
 * A turn is attributed to its Agent rather than its Run: one Agent dispatched
 * repeatedly resumes the same Codex thread, so its turns form one growing
 * prompt. Two Agents in one orchestration hold separate threads, and
 * interleaving them would read one Agent's growth as another's.
 */
function collectTurns(spans: readonly FlatSpan[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  const seen = new Set<string>();
  // `model_turn` records counters but not which model produced them; the Run's
  // own events carry that. Resolved per Run so a trace whose Runs fell back to
  // different models is still priced with the rates each one actually ran on.
  const modelByRun = new Map<string, string>();
  for (const span of spans) {
    for (const event of span.events) {
      const runId = event.runId ?? span.runId;
      if (runId === undefined || modelByRun.has(runId)) continue;
      const model =
        metadataString(event, "modelUsed") ??
        metadataString(event, "resolvedModel") ??
        metadataString(event, "model");
      if (model !== undefined) modelByRun.set(runId, model);
    }
  }
  for (const span of spans) {
    for (const event of span.events) {
      if (event.type !== "model_turn" || seen.has(event.id)) continue;
      seen.add(event.id);
      const at = Date.parse(event.createdAt);
      const runId = event.runId ?? span.runId ?? null;
      const record: TurnRecord = {
        chainKey: event.agentId ?? span.runId ?? span.spanId,
        runId,
        modelId: runId === null ? null : modelByRun.get(runId) ?? null,
        at: Number.isFinite(at) ? at : 0,
      };
      const input = metadataNumber(event, "inputTokens");
      const cached = metadataNumber(event, "cachedInputTokens");
      const output = metadataNumber(event, "outputTokens");
      const reasoning = metadataNumber(event, "reasoningOutputTokens");
      if (input !== undefined) record.inputTokens = input;
      if (cached !== undefined) record.cachedInputTokens = cached;
      if (output !== undefined) record.outputTokens = output;
      if (reasoning !== undefined) record.reasoningOutputTokens = reasoning;
      turns.push(record);
    }
  }
  return turns.sort((left, right) => left.at - right.at);
}

/** Sandbox and MCP calls, keyed so repeat calls of one tool share a line. */
function collectToolLines(spans: readonly FlatSpan[]): ReceiptToolLine[] {
  const lines = new Map<string, ReceiptToolLine>();
  const seen = new Set<string>();
  for (const span of spans) {
    for (const event of span.events) {
      if (seen.has(event.id)) continue;
      const sandbox = event.type === "sandbox_command";
      const mcp = event.type === "mcp_tool_call";
      if (!sandbox && !mcp) continue;
      const bytes = metadataNumber(event, sandbox ? "stdoutBytes" : "resultBytes");
      if (bytes === undefined) continue;
      seen.add(event.id);
      const label = sandbox
        ? metadataString(event, "program") ?? "sandbox command"
        : metadataString(event, "toolId") ?? "MCP tool";
      const id = (sandbox ? "sandbox:" : "mcp:") + label;
      const line = lines.get(id) ?? {
        id,
        label,
        kind: sandbox ? ("sandbox" as const) : ("mcp" as const),
        calls: 0,
        bytes: 0,
        estimatedTokens: 0,
      };
      line.calls += 1;
      line.bytes += bytes;
      lines.set(id, line);
    }
  }
  return [...lines.values()];
}

/**
 * Fit byte-derived estimates inside the growth actually measured.
 *
 * Bytes are a proxy, so the estimates are scaled to the `added` total rather
 * than being allowed to overrun it: a receipt whose line items exceed its own
 * subtotal is worse than no breakdown at all. Any shortfall stays visible as
 * unattributed content instead of being spread across the tools to hide it.
 */
function fitToolLines(
  lines: ReceiptToolLine[],
  addedTokens: number,
): { lines: ReceiptToolLine[]; other: number; scaled: boolean } {
  const raw = lines.map((line) => ({
    line,
    tokens: line.bytes / BYTES_PER_TOKEN,
  }));
  const rawTotal = raw.reduce((sum, entry) => sum + entry.tokens, 0);
  if (rawTotal === 0 || addedTokens <= 0) {
    return { lines: [], other: Math.max(0, addedTokens), scaled: false };
  }
  const scaled = rawTotal > addedTokens;
  const factor = scaled ? addedTokens / rawTotal : 1;
  const fitted = raw
    .map((entry) => ({
      ...entry.line,
      estimatedTokens: Math.round(entry.tokens * factor),
    }))
    .filter((line) => line.estimatedTokens > 0)
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens);
  const attributed = fitted.reduce((sum, line) => sum + line.estimatedTokens, 0);
  return {
    lines: fitted,
    other: Math.max(0, addedTokens - attributed),
    scaled,
  };
}

/**
 * Build the receipt for one trace.
 *
 * Turns that reported nothing are counted and excluded rather than treated as
 * zero, so a partial trace understates its bill visibly instead of silently.
 */
export function buildTokenReceipt(
  spans: readonly FlatSpan[],
  scope: TokenReceiptScope = {},
  /** Rates by model. Omitted, or missing a model, means no cost is shown. */
  prices: ModelPrices = {},
): TokenReceipt {
  const scopeRunId = scope.runId;
  const inScope = (runId: string | null): boolean =>
    scopeRunId === undefined || runId === scopeRunId;
  const turns = collectTurns(spans);
  const chains = new Map<string, { input: number; output: number }>();
  // Per-thread rows are keyed by Agent so a restart folds back into the Agent
  // that restarted rather than appearing as a stranger in the breakdown.
  const detail = new Map<string, ReceiptChain>();
  const chainRow = (key: string): ReceiptChain => {
    const existing = detail.get(key);
    if (existing) return existing;
    const created: ReceiptChain = {
      id: key,
      label: key.slice(0, 8),
      turns: 0,
      openingTokens: 0,
      addedTokens: 0,
      resentTokens: 0,
      outputTokens: 0,
      billedTokens: 0,
    };
    detail.set(key, created);
    return created;
  };

  let openingTokens = 0;
  let addedTokens = 0;
  let resentTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoning = 0;
  let reasoningReported = false;
  let cacheReported = false;
  let turnsReporting = 0;
  let turnsMissing = 0;
  let turnsPartial = 0;
  let restarts = 0;
  let chainCount = 0;
  const cost: ReceiptCost = {
    opening: 0,
    added: 0,
    resent: 0,
    output: 0,
    total: 0,
    withoutCache: 0,
    unpricedTurns: 0,
  };
  let pricedTurns = 0;

  /**
   * Price one turn, splitting its cache read across the lines it belongs to.
   *
   * A prompt cache serves a prefix, and a turn's prompt begins with whatever it
   * carried in: the opening on a thread's first turn, the re-sent conversation
   * on every turn after. Filling those before `added` therefore follows the
   * order the provider actually matched, rather than spreading the discount
   * evenly over lines that never saw it.
   */
  const priceTurn = (
    modelId: string | null,
    parts: { opening: number; added: number; resent: number },
    outputTokens: number,
    cachedTokens: number,
  ): void => {
    const rates = modelId === null ? undefined : prices[modelId];
    if (rates === undefined) {
      cost.unpricedTurns += 1;
      return;
    }
    pricedTurns += 1;
    const input = parts.opening + parts.added + parts.resent;
    let remaining = Math.min(cachedTokens, input);
    const take = (available: number): number => {
      const used = Math.min(remaining, available);
      remaining -= used;
      return used;
    };
    const openingHit = take(parts.opening);
    const resentHit = take(parts.resent);
    const addedHit = take(parts.added);
    const priced = (tokens: number, hit: number): number =>
      ((tokens - hit) * rates.inputMiss + hit * rates.inputHit) / 1000;
    cost.opening += priced(parts.opening, openingHit);
    cost.resent += priced(parts.resent, resentHit);
    cost.added += priced(parts.added, addedHit);
    cost.output += (outputTokens * rates.output) / 1000;
    cost.withoutCache +=
      (input * rates.inputMiss + outputTokens * rates.output) / 1000;
  };

  for (const turn of turns) {
    const input = turn.inputTokens;
    const output = turn.outputTokens ?? 0;
    const counted = inScope(turn.runId);
    if (turn.inputTokens === undefined && turn.outputTokens === undefined) {
      if (counted) turnsMissing += 1;
      continue;
    }
    if (counted) {
      turnsReporting += 1;
      if (turn.inputTokens === undefined || turn.outputTokens === undefined) {
        turnsPartial += 1;
      }
      outputTokens += output;
      if (turn.cachedInputTokens !== undefined) {
        cachedInputTokens += turn.cachedInputTokens;
        cacheReported = true;
      }
      if (turn.reasoningOutputTokens !== undefined) {
        reasoning += turn.reasoningOutputTokens;
        reasoningReported = true;
      }
    }
    const row = chainRow(turn.chainKey);
    if (counted) {
      row.turns += 1;
      row.outputTokens += output;
      row.billedTokens += output;
    }

    if (input === undefined) continue;
    const previous = chains.get(turn.chainKey);
    // A prompt no larger than the one before it cannot be carrying that prompt
    // as its prefix: the thread was compacted or restarted. Counting it as an
    // opening keeps the identity intact and surfaces the restart.
    if (previous === undefined || input < previous.input) {
      if (counted) {
        if (previous === undefined) chainCount += 1;
        else restarts += 1;
        openingTokens += input;
        row.openingTokens += input;
        priceTurn(
          turn.modelId,
          { opening: input, added: 0, resent: 0 },
          output,
          turn.cachedInputTokens ?? 0,
        );
      }
    } else {
      const added = Math.max(0, input - previous.input - previous.output);
      if (counted) {
        addedTokens += added;
        resentTokens += input - added;
        row.addedTokens += added;
        row.resentTokens += input - added;
        priceTurn(
          turn.modelId,
          { opening: 0, added, resent: input - added },
          output,
          turn.cachedInputTokens ?? 0,
        );
      }
    }
    if (counted) row.billedTokens += input;
    chains.set(turn.chainKey, { input, output });
  }

  const billedTokens = openingTokens + addedTokens + resentTokens + outputTokens;
  const scopedSpans = scopeRunId === undefined
    ? spans
    : spans.filter((span) => span.runId === scopeRunId);
  const fit = fitToolLines(collectToolLines(scopedSpans), addedTokens);

  return {
    availability: turnsReporting === 0
      ? "unavailable"
      : turnsMissing > 0 || turnsPartial > 0
        ? "partial"
        : "available",
    turnsReporting,
    turnsMissing,
    chains: chainCount + restarts,
    restarts,
    openingTokens,
    addedTokens,
    resentTokens,
    outputTokens,
    reasoningOutputTokens: reasoningReported ? reasoning : null,
    cachedInputTokens: Math.min(cachedInputTokens, openingTokens + addedTokens + resentTokens),
    cacheReported,
    billedTokens,
    uniqueTokens: openingTokens + addedTokens + outputTokens,
    processedTokens: cacheReported
      ? Math.max(
          0,
          openingTokens + addedTokens + resentTokens + outputTokens -
            Math.min(cachedInputTokens, openingTokens + addedTokens + resentTokens),
        )
      : openingTokens + addedTokens + resentTokens + outputTokens,
    // All or nothing: a total missing some turns would read as the trace's
    // cost while understating it, which is worse than showing no price.
    cost: pricedTurns > 0 && cost.unpricedTurns === 0
      ? {
          ...cost,
          total: cost.opening + cost.added + cost.resent + cost.output,
        }
      : null,
    chainLines: [...detail.values()]
      .filter((chain) => chain.billedTokens > 0).sort(
      (left, right) => right.billedTokens - left.billedTokens,
    ),
    toolLines: fit.lines,
    otherAddedTokens: fit.other,
    toolEstimateScaled: fit.scaled,
  };
}
