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
