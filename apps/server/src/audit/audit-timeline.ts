import type { RunStatus, RunUsage, ModelRef } from "../types.js";
import { normalizeRunUsage, type UsageAvailability } from "../telemetry/telemetry-usage.js";
import { AUDIT_CATEGORIES, type AuditCategory, type AuditEvent, type AuditQuery } from "./audit-types.js";
import { queryAuditEvents } from "./audit-query.js";

/**
 * The Run fields observability reads.
 *
 * Usage aggregation needs only the first five; the historical fields below are
 * optional so a caller supplying a minimal projection stays valid, and so Runs
 * recorded before the snapshot existed still satisfy the contract.
 */
export interface AuditRunSnapshot {
  id: string;
  agentId: string;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  status?: RunStatus;
  prompt?: string;
  error?: string | null;
  createdAt?: string;
  /** Agent identity captured on the Run; survives the Agent's deletion. */
  agentName?: string;
  agentDeletedAt?: string;
  traceId?: string;
  /** The model this Run actually ran on; needed to look up its context window. */
  modelUsed?: ModelRef;
  /** Private conversation this Run belongs to; set on direct Runs only. */
  conversationId?: string | undefined;
}

/**
 * The conversation a Run belongs to, named.
 *
 * Both kinds are conversations to a reader: a private thread with one Agent
 * and a Team session with several. They are separate collections and their IDs
 * are only unique within their own kind, so `kind` stays on the record rather
 * than being inferred from the ID.
 */
export interface AuditConversationSnapshot {
  id: string;
  kind: AuditConversationKind;
  /** Human label; empty when the conversation was never named. */
  title: string;
}

export type AuditConversationKind = "direct" | "team";

export interface AuditRunReader {
  readRuns(): readonly AuditRunSnapshot[];
  /**
   * Conversation titles, for naming a Run's thread.
   *
   * Optional: a reader that supplies only Runs stays valid, and its Runs are
   * then labelled by their own prompt rather than by an invented thread name.
   */
  readConversations?(): readonly AuditConversationSnapshot[];
}

export type AuditTimelineQuery = AuditQuery;

export interface AuditTimelineSummary {
  usageAvailability: UsageAvailability;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  llmCount: number;
  toolCount: number;
  authorizationCount: number;
  errorCount: number;
  /** Every category is present; absent categories count zero. */
  countsByCategory: Record<AuditCategory, number>;
  executionLatencyMs?: number;
  authorizationLatencyMs?: number;
  toolLatencyMs?: number;
}

export interface AuditTimeline {
  events: AuditEvent[];
  summary: AuditTimelineSummary;
}

function countByCategory(
  events: readonly AuditEvent[],
): Record<AuditCategory, number> {
  const counts = {} as Record<AuditCategory, number>;
  for (const category of AUDIT_CATEGORIES) counts[category] = 0;
  for (const event of events) {
    if (counts[event.category] !== undefined) counts[event.category] += 1;
  }
  return counts;
}

function durationFromEvents(
  events: readonly AuditEvent[],
  types: readonly AuditEvent["type"][],
): number | undefined {
  let total = 0;
  let count = 0;
  for (const event of events) {
    if (!types.includes(event.type)) continue;
    const value = event.metadata.durationMs;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    total += value;
    count += 1;
  }
  return count === 0 ? undefined : total;
}

function executionLatency(runs: readonly AuditRunSnapshot[]): number | undefined {
  let total = 0;
  let count = 0;
  for (const run of runs) {
    if (!run.startedAt || !run.completedAt) continue;
    const elapsed = Date.parse(run.completedAt) - Date.parse(run.startedAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) continue;
    total += elapsed;
    count += 1;
  }
  return count === 0 ? undefined : total;
}

function aggregateUsage(runs: readonly AuditRunSnapshot[]): Pick<
  AuditTimelineSummary,
  "usageAvailability" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "totalTokens"
> {
  if (runs.length === 0) return { usageAvailability: "unavailable" };
  const normalized = runs.map((run) => normalizeRunUsage(run.usage));
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;
  const result: Pick<
    AuditTimelineSummary,
    "usageAvailability" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "totalTokens"
  > = { usageAvailability: "available" };
  let allComplete = true;
  for (const item of normalized) {
    if (item.availability !== "available") allComplete = false;
  }
  const anyAvailable = normalized.some((item) => item.availability !== "unavailable");
  result.usageAvailability = allComplete
    ? "available"
    : anyAvailable
      ? "partial"
      : "unavailable";
  for (const field of fields) {
    const present = normalized.filter((item) => item[field] !== undefined);
    if (present.length === 0) continue;
    result[field] = present.reduce((sum, item) => sum + (item[field] ?? 0), 0);
  }
  if (result.inputTokens !== undefined && result.outputTokens !== undefined) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return result;
}

/** Build a bounded, non-analytical timeline from audit events and known runs. */
export function queryAuditTimeline(
  events: readonly AuditEvent[],
  runs: readonly AuditRunSnapshot[] = [],
  filter: AuditTimelineQuery = {},
): AuditTimeline {
  const matchedEvents = queryAuditEvents(events, filter);
  const eventRunIds = new Set(
    matchedEvents
      .map((event) => event.runId)
      .filter((id): id is string => id !== undefined),
  );
  const matchedRuns = runs.filter((run) =>
    (filter.agentId === undefined || run.agentId === filter.agentId) &&
    (filter.runId === undefined || run.id === filter.runId) &&
    (filter.projectId === undefined || eventRunIds.has(run.id)),
  );
  const usage = aggregateUsage(matchedRuns);
  const summary: AuditTimelineSummary = {
    ...usage,
    llmCount: matchedRuns.length,
    toolCount: matchedEvents.filter((event) => event.type.startsWith("tool_")).length,
    authorizationCount: matchedEvents.filter(
      (event) => event.type === "authorization_decision",
    ).length,
    errorCount: matchedEvents.filter((event) => event.status === "failure").length,
    countsByCategory: countByCategory(matchedEvents),
  };
  const executionMs = executionLatency(matchedRuns);
  const authorizationMs = durationFromEvents(matchedEvents, ["authorization_decision"]);
  const toolMs = durationFromEvents(matchedEvents, ["tool_succeeded", "tool_failed"]);
  if (executionMs !== undefined) summary.executionLatencyMs = executionMs;
  if (authorizationMs !== undefined) summary.authorizationLatencyMs = authorizationMs;
  if (toolMs !== undefined) summary.toolLatencyMs = toolMs;
  return { events: matchedEvents, summary };
}
