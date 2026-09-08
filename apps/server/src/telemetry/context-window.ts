import type { RunUsage } from "../types.js";
import { normalizeRunUsage } from "./telemetry-usage.js";

/**
 * How much of a model's context a Run left occupied.
 *
 * Deliberately measured in billed tokens rather than in the net-new figure the
 * rest of the surfaces lead with. Context is space, not price: a prompt the
 * provider served from cache still occupies the window it was read from, so
 * removing cache reads here would understate how full the window is.
 */
export interface RunContextWindow {
  /** The configured window for the model this Run used. */
  windowTokens: number;
  /** The Run's prompt plus its output — what the next turn starts from. */
  usedTokens: number;
  /** Window minus used, floored at zero. */
  remainingTokens: number;
  /** Used over window, 0–1, for a gauge. */
  usedShare: number;
}

/**
 * Context a Run leaves behind, or null when it cannot be stated honestly.
 *
 * Null means the model has no configured window or the provider reported no
 * counters. Neither is guessed at: an invented window would turn a headroom
 * readout into a number a reader could act on and be wrong about.
 */
export function runContextWindow(
  usage: RunUsage | null | undefined,
  windowTokens: number | undefined,
): RunContextWindow | null {
  if (windowTokens === undefined || windowTokens <= 0) return null;
  const normalized = normalizeRunUsage(usage);
  if (normalized.availability === "unavailable") return null;
  const usedTokens = (normalized.inputTokens ?? 0) + (normalized.outputTokens ?? 0);
  if (usedTokens === 0) return null;
  // A window can be overrun before the provider rejects the turn, so `used`
  // is reported as measured and only `remaining` is floored.
  return {
    windowTokens,
    usedTokens,
    remainingTokens: Math.max(0, windowTokens - usedTokens),
    usedShare: Math.min(1, usedTokens / windowTokens),
  };
}
