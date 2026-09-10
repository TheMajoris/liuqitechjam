import type {
  ModelEndpointStatus,
  ModelQuotaSnapshot,
  ModelResourceFreshness,
  ModelResourceSnapshot,
} from "./types";
import { formatCount } from "./components/insights/usage-format";

export function modelResourceStatusLabel(status: ModelEndpointStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "degraded":
      return "Degraded";
    case "unavailable":
      return "Unavailable";
    default:
      return "Unknown";
  }
}

export function modelResourceStatusGlyph(status: ModelEndpointStatus): string {
  switch (status) {
    case "running":
      return "●";
    case "degraded":
      return "▲";
    case "stopped":
      return "■";
    case "unavailable":
      return "✕";
    default:
      return "?";
  }
}

export function modelResourceStatusTone(status: ModelEndpointStatus):
  | "positive"
  | "waiting"
  | "muted"
  | "danger"
  | "neutral" {
  switch (status) {
    case "running":
      return "positive";
    case "degraded":
      // The current ModelArk management projection has no remaining-quota
      // signal. Keep this legacy status neutral until a provider-backed
      // capacity field exists; amber is reserved for verified low capacity.
      return "muted";
    case "stopped":
      return "muted";
    case "unavailable":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Return quota data only when the provider supplied a coherent snapshot.
 *
 * Usage counters and rate limits are deliberately not treated as quota: a
 * ModelArk usage window says what has been consumed, while a rate limit says
 * how quickly calls may be made. Neither one tells us how many tokens remain.
 */
function reportedQuota(resource: ModelResourceSnapshot | null | undefined): ModelQuotaSnapshot | null {
  const quota = resource?.quota;
  if (!quota) return null;
  if (
    !Number.isFinite(quota.usedTokens) ||
    !Number.isFinite(quota.totalTokens) ||
    !Number.isFinite(quota.remainingTokens) ||
    quota.totalTokens <= 0 ||
    quota.usedTokens < 0 ||
    quota.remainingTokens < 0 ||
    quota.remainingTokens > quota.totalTokens ||
    quota.usedTokens > quota.totalTokens
  ) {
    return null;
  }
  return quota;
}

/**
 * Return the provider-reported percentage of tokens still available.
 *
 * A usage window is not a quota, so this deliberately returns `null` unless
 * ModelArk supplied a complete, internally valid quota snapshot. The compact
 * workspace surfaces use this instead of turning consumed counters into a
 * made-up remaining percentage.
 */
export function modelResourceQuotaPercent(
  resource: ModelResourceSnapshot | null | undefined,
): number | null {
  const quota = reportedQuota(resource);
  if (!quota) return null;
  return Math.round((quota.remainingTokens / quota.totalTokens) * 100);
}

/**
 * How full a model's context window one Run left it.
 *
 * This is the reading "tokens left" always implied and never delivered. A
 * context window is a hard limit — a prompt past it is refused — and it is
 * per-Agent, because each Agent's own thread is what fills it. The free-token
 * grant that used to occupy this space is neither: it is shared across every
 * Agent on the model, and exhausting it changes the price rather than stopping
 * the work.
 */
export interface ModelContextUsage {
  windowTokens: number;
  usedTokens: number;
  remainingTokens: number;
  usedPercent: number;
}

export function modelContextUsage(
  resource: ModelResourceSnapshot | null | undefined,
  lastRun:
    | { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
    | null
    | undefined,
): ModelContextUsage | null {
  const windowTokens = resource?.contextWindowTokens;
  if (
    typeof windowTokens !== "number" ||
    !Number.isFinite(windowTokens) ||
    windowTokens <= 0
  ) {
    return null;
  }
  const input = lastRun?.inputTokens;
  const output = lastRun?.outputTokens;
  if (input === undefined && output === undefined) return null;
  // Billed tokens, cache reads included: a prompt served from cache still
  // occupies the window it was read from, so removing them would understate
  // how close the next turn is to being refused.
  const usedTokens = (input ?? 0) + (output ?? 0);
  if (usedTokens <= 0) return null;
  return {
    windowTokens,
    usedTokens,
    remainingTokens: Math.max(0, windowTokens - usedTokens),
    usedPercent: Math.min(100, Math.round((usedTokens / windowTokens) * 100)),
  };
}

/**
 * Compact capacity copy for the room hover/focus surface.
 *
 * Says what is used rather than what is left: the window is a ceiling a turn
 * grows toward, and "82% left" on a thread about to be refused reads as room
 * to spare. An unconfigured window says so instead of showing a percentage of
 * nothing.
 */
export function modelResourceCapacityLabel(
  resource: ModelResourceSnapshot | null | undefined,
  lastRun?:
    | { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
    | null,
): string {
  const context = modelContextUsage(resource, lastRun);
  if (context === null) {
    // No window configured is not the same as nothing to say. The size of the
    // last turn is measured, useful on its own, and the number a reader was
    // looking for anyway; only the share of a ceiling is unknown.
    const used = lastTurnTokens(lastRun);
    return used === null ? "Context \u2014" : `${formatCount(used)} last turn`;
  }
  return resource?.freshness === "fresh"
    ? `${context.usedPercent}% of context used`
    : `${context.usedPercent}% of context used \u00b7 last known`;
}

/** Billed size of the Agent's last turn, or null when nothing was reported. */
export function lastTurnTokens(
  lastRun:
    | { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
    | null
    | undefined,
): number | null {
  const input = lastRun?.inputTokens;
  const output = lastRun?.outputTokens;
  if (input === undefined && output === undefined) return null;
  const used = (input ?? 0) + (output ?? 0);
  return used > 0 ? used : null;
}

export type ModelResourceQuotaTone = "healthy" | "warning" | "critical" | "unknown";

/**
 * Colour for the context bar, and only for the context bar.
 *
 * A filling context window is the one condition here that genuinely degrades
 * an Agent: past the ceiling the provider refuses the turn. That is what earns
 * a critical band. A free-token grant never does — running it out changes the
 * bill, not the behaviour — so it is deliberately not coloured at all.
 *
 * Bands: under 70% used is healthy, at or past 90% is critical.
 */
export function modelContextTone(
  resource: ModelResourceSnapshot | null | undefined,
  lastRun?:
    | { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
    | null,
): ModelResourceQuotaTone {
  if (!resource || resource.freshness !== "fresh") return "unknown";
  const context = modelContextUsage(resource, lastRun);
  if (context === null) return "unknown";
  if (context.usedPercent >= 90) return "critical";
  if (context.usedPercent >= 70) return "warning";
  return "healthy";
}

/** Human-readable context detail for hover/focus surfaces. */
export function modelResourceQuotaLabel(
  resource: ModelResourceSnapshot | null | undefined,
  lastRun?:
    | { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }
    | null,
): string {
  const context = modelContextUsage(resource, lastRun);
  if (context === null) {
    // Kept to one short clause: this reads on a hover card floating over the
    // room, where a long line covers the desks behind it. Operator guidance —
    // which setting to reach for — belongs in the inspector, which has room.
    if (lastTurnTokens(lastRun) === null) return "No counters reported";
    return "No context window set for this model";
  }
  return (
    `${formatCount(context.usedTokens)} of ${formatCount(context.windowTokens)} ` +
    "context used by the last turn"
  );
}

/**
 * The free-token grant, stated as what it is.
 *
 * Named a trial rather than a capacity, and never coloured: it is one pack
 * shared by every Agent on the foundation model, so a per-Agent card showing
 * it as that Agent's allowance invites a reader to add up figures that are all
 * the same number. Exhausting it moves the model to paid rates and nothing
 * else.
 */
export function modelFreeGrantLabel(
  resource: ModelResourceSnapshot | null | undefined,
): string | null {
  const quota = reportedQuota(resource);
  if (!quota) return null;
  return (
    `Free trial: ${formatCount(quota.remainingTokens)} of ` +
    `${formatCount(quota.totalTokens)} tokens left, shared by every Agent on ` +
    "this model. After that the model bills at its normal rates."
  );
}

/**
 * Compact capacity text for a native `<select>` option, where only plain text
 * fits. Remaining quota is preferred when ModelArk reports one; otherwise this
 * falls back to consumption, which is what the provider actually sends, rather
 * than implying a remaining figure nobody reported. `null` means "say nothing"
 * so an option never carries a misleading zero.
 */
export function modelResourceOptionSuffix(
  resource: ModelResourceSnapshot | null | undefined,
): string | null {
  if (!resource) return null;
  const percent = modelResourceQuotaPercent(resource);
  if (percent !== null) return `${percent}% of free trial left`;
  const total = resource.usage?.totalTokens;
  return typeof total === "number" ? `${formatCount(total)} used` : null;
}

/** Option text for a model, annotated with its live capacity when known. */
export function modelOptionLabel(
  model: { id: string; label?: string },
  resource: ModelResourceSnapshot | null | undefined,
): string {
  const base = model.label || model.id;
  const suffix = modelResourceOptionSuffix(resource);
  return suffix === null ? base : `${base} — ${suffix}`;
}

export function modelResourceFreshnessLabel(freshness: ModelResourceFreshness): string {
  switch (freshness) {
    case "fresh":
      return "Live";
    case "stale":
      return "Stale";
    default:
      return "Unavailable";
  }
}

export function modelResourceUsageSummary(resource: ModelResourceSnapshot | null | undefined): string {
  const total = resource?.usage?.totalTokens;
  if (typeof total === "number") return `${formatCount(total)} consumed`;
  if (resource?.usage === null || resource?.usage === undefined) return "Usage not reported";
  if (typeof resource.usage.dataCount === "number") {
    return `${formatCount(resource.usage.dataCount)} usage records`;
  }
  const parts = [
    typeof resource.usage.inputTokens === "number" ? `${formatCount(resource.usage.inputTokens)} in` : null,
    typeof resource.usage.outputTokens === "number" ? `${formatCount(resource.usage.outputTokens)} out` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "Usage not reported";
}

export function modelResourceUsageScopeLabel(resource: ModelResourceSnapshot): string {
  // "window" alone reads as a context window, which these counters are not.
  return resource.usage?.scope === "provider"
    ? "Provider usage window"
    : "Model usage window";
}

export function modelResourceRateLimitLabel(resource: ModelResourceSnapshot): string | null {
  const rpm = resource.rateLimit?.rpm;
  const tpm = resource.rateLimit?.tpm;
  const parts = [
    typeof rpm === "number" && Number.isFinite(rpm) ? `${formatCount(rpm)} rpm` : null,
    typeof tpm === "number" && Number.isFinite(tpm) ? `${formatCount(tpm)} tpm` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join(" · ")} limit` : null;
}

export function modelResourceObservedLabel(resource: ModelResourceSnapshot): string {
  if (resource.freshness === "unavailable") return "No recent observation";
  if (!resource.observedAt) return modelResourceFreshnessLabel(resource.freshness);
  const timestamp = Date.parse(resource.observedAt);
  if (!Number.isFinite(timestamp)) return modelResourceFreshnessLabel(resource.freshness);
  return `${modelResourceFreshnessLabel(resource.freshness)} · ${new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export interface ModelResourceUsageRow {
  label: string;
  value: string;
}

export function modelResourceUsageRows(resource: ModelResourceSnapshot): ModelResourceUsageRow[] {
  const usage = resource.usage;
  if (!usage) return [{ label: "Usage", value: "Not reported" }];
  const rows: ModelResourceUsageRow[] = ([
    ["Input", usage.inputTokens],
    ["Cached input", usage.cachedInputTokens],
    ["Output", usage.outputTokens],
    ["Total consumed", usage.totalTokens],
    ["Requests", usage.requests],
  ] as const).map(([label, value]) => ({
    label,
    value: typeof value === "number" ? formatCount(value) : "—",
  }));
  if (typeof usage.dataCount === "number") {
    rows.push({ label: "Usage records", value: formatCount(usage.dataCount) });
  }
  return rows;
}
