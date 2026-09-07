import type { RunUsage } from "../types.js";
import type { TelemetryAttributes } from "./telemetry-types.js";

export type UsageAvailability = "available" | "partial" | "unavailable";

export interface NormalizedRunUsage {
  availability: UsageAvailability;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

function finiteTokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Preserve provider truth without filling missing counters. A null result is
 * explicitly unavailable, while a subset of counters is explicitly partial.
 */
export function normalizeRunUsage(
  usage: RunUsage | null | undefined,
): NormalizedRunUsage {
  const normalized: NormalizedRunUsage = { availability: "unavailable" };
  const inputTokens = finiteTokenCount(usage?.inputTokens);
  const cachedInputTokens = finiteTokenCount(usage?.cachedInputTokens);
  const outputTokens = finiteTokenCount(usage?.outputTokens);
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) normalized.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
  const count = [inputTokens, cachedInputTokens, outputTokens].filter(
    (value) => value !== undefined,
  ).length;
  normalized.availability = count === 0
    ? "unavailable"
    : count === 3
      ? "available"
      : "partial";
  return normalized;
}

/**
 * Token rollup for one Run or for every Run under a trace.
 *
 * Counters are never invented: `availability` reports whether the provider
 * supplied a complete picture, so a surface can distinguish "zero tokens" from
 * "nothing was reported".
 */
export interface RunTokenTotals {
  availability: UsageAvailability;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Runs that reported at least one counter. */
  runsReporting: number;
  /** Runs that reported nothing at all. */
  runsMissing: number;
}

/** Aggregate provider counters across Runs without filling in the gaps. */
export function summarizeRunTokens(
  usages: readonly (RunUsage | null | undefined)[],
): RunTokenTotals {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let runsReporting = 0;
  let runsMissing = 0;
  let runsPartial = 0;

  for (const usage of usages) {
    const normalized = normalizeRunUsage(usage);
    if (normalized.availability === "unavailable") {
      runsMissing += 1;
      continue;
    }
    runsReporting += 1;
    if (normalized.availability === "partial") runsPartial += 1;
    inputTokens += normalized.inputTokens ?? 0;
    cachedInputTokens += normalized.cachedInputTokens ?? 0;
    outputTokens += normalized.outputTokens ?? 0;
  }

  return {
    availability: runsReporting === 0
      ? "unavailable"
      : runsMissing > 0 || runsPartial > 0
        ? "partial"
        : "available",
    inputTokens,
    cachedInputTokens,
    outputTokens,
    // Cached input is already part of the input count; adding it would
    // double-count the same tokens.
    totalTokens: inputTokens + outputTokens,
    runsReporting,
    runsMissing,
  };
}

export function usageAttributes(
  usage: RunUsage | null | undefined,
): TelemetryAttributes {
  const normalized = normalizeRunUsage(usage);
  const attributes: TelemetryAttributes = {
    "gen_ai.usage.availability": normalized.availability,
  };
  if (normalized.inputTokens !== undefined) {
    attributes["gen_ai.usage.input_tokens"] = normalized.inputTokens;
  }
  if (normalized.cachedInputTokens !== undefined) {
    attributes["gen_ai.usage.cached_input_tokens"] = normalized.cachedInputTokens;
  }
  if (normalized.outputTokens !== undefined) {
    attributes["gen_ai.usage.output_tokens"] = normalized.outputTokens;
  }
  return attributes;
}
