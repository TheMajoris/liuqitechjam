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
 * Compact capacity copy for the room hover/focus surface.
 *
 * Detailed counters belong in AgentInspector/Insights. Keep the unavailable
 * state explicit when the provider has not exposed a quota.
 */
export function modelResourceCapacityLabel(resource: ModelResourceSnapshot | null | undefined): string {
  const percent = modelResourceQuotaPercent(resource);
  return percent === null ? "Tokens left —%" : `${percent}% tokens left`;
}

export type ModelResourceQuotaTone = "healthy" | "warning" | "critical" | "unknown";

/**
 * Capacity colour is available only for an explicit, fresh provider quota.
 * ModelArk's usage counters and RPM/TPM limits never enter this calculation.
 *
 * Bands: at least 70% left is healthy, under 20% is critical, the rest warns.
 */
export function modelResourceQuotaTone(
  resource: ModelResourceSnapshot | null | undefined,
): ModelResourceQuotaTone {
  if (!resource || resource.freshness !== "fresh") return "unknown";
  const quota = reportedQuota(resource);
  if (!quota) return "unknown";
  const remainingRatio = quota.remainingTokens / quota.totalTokens;
  if (remainingRatio < 0.2) return "critical";
  if (remainingRatio < 0.7) return "warning";
  return "healthy";
}

/**
 * Human-readable capacity detail for hover/focus surfaces. It never derives a
 * remaining amount from usage counters, rate limits, or a guessed window.
 */
export function modelResourceQuotaLabel(resource: ModelResourceSnapshot | null | undefined): string {
  const quota = reportedQuota(resource);
  if (!quota) return "Remaining quota not reported by ModelArk";
  return `${formatCount(quota.remainingTokens)} remaining of ${formatCount(quota.totalTokens)}`;
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
  if (percent !== null) return `${percent}% tokens left`;
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
  return resource.usage?.scope === "provider" ? "Provider window" : "Model window";
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
