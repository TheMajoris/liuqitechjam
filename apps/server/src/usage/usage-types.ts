import type { UsageAvailability } from "../telemetry/telemetry-usage.js";

export type { UsageAvailability };

/**
 * Token counters aggregated across runs.
 *
 * `availability` is the honest summary of provider truth, never a filled-in
 * zero: `unavailable` means no run in scope reported a counter, `partial`
 * means some runs did and others did not, and `available` means every run in
 * scope reported complete usage. `runsReporting` lets a reader tell how much
 * of the scope the totals actually cover.
 */
export interface UsageTokenTotals {
  availability: UsageAvailability;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Runs that reported at least one counter. */
  runsReporting: number;
}

/** Run outcomes counted by terminal status. */
export interface UsageRunTotals {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
}

/** Tool and skill activity derived from the persisted audit journal. */
export interface UsageActivityTotals {
  toolCalls: number;
  toolFailures: number;
  approvalsRequired: number;
  skillInvocations: number;
  authorizationDenials: number;
}

/** Wall-clock run duration, reported only from runs that recorded both ends. */
export interface UsageLatency {
  /** Runs with both `startedAt` and `completedAt`; 0 means no latency data. */
  samples: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface UsageTotals {
  runs: UsageRunTotals;
  tokens: UsageTokenTotals;
  activity: UsageActivityTotals;
  latency: UsageLatency;
  messages: number;
}

/** One row of the per-Agent breakdown, seeded from the live roster. */
export interface UsageAgentBreakdown extends UsageTotals {
  agentId: string;
  /** Live Agent display name; deleted Agent IDs are omitted from this list. */
  name: string | null;
  status: string | null;
  modelLabel: string | null;
  lastActiveAt: string | null;
}

/** One row of the per-workspace (Team session) breakdown. */
export interface UsageWorkspaceBreakdown extends UsageTotals {
  orchestrationId: string;
  name: string | null;
  status: string | null;
  projectId: string | null;
  participants: number;
  lastActiveAt: string | null;
}

/** One row of the persistent Workspace breakdown. */
export interface UsageProjectBreakdown extends UsageTotals {
  projectId: string;
  name: string | null;
  /** Kept for response compatibility; named rows are always live. */
  archived: boolean;
  lastActiveAt: string | null;
}

/** One UTC day of activity, ascending, with no gaps across the window. */
export interface UsageDailyPoint {
  date: string;
  runs: number;
  completed: number;
  failed: number;
  totalTokens: number;
  toolCalls: number;
}

/** Legacy response shape; current breakdowns leave retired rows null. */
export interface UsageRetiredSummary extends UsageTotals {
  /** How many archived or deleted subjects this row stands for. */
  subjects: number;
}

export interface UsageRetired {
  agents: UsageRetiredSummary | null;
  workspaces: UsageRetiredSummary | null;
  projects: UsageRetiredSummary | null;
}

export interface UsageReport {
  /** Inclusive ISO instant the window starts at, or null when unbounded. */
  since: string | null;
  generatedAt: string;
  totals: UsageTotals;
  agents: UsageAgentBreakdown[];
  workspaces: UsageWorkspaceBreakdown[];
  projects: UsageProjectBreakdown[];
  /** Compatibility shape; archived/deleted subjects are not rendered as rows. */
  retired: UsageRetired;
  daily: UsageDailyPoint[];
}

export interface UsageReportOptions {
  /** Only count records created at or after this instant. */
  since?: string | undefined;
  /** Days of the daily series to emit, counted back from today (UTC). */
  days?: number | undefined;
}
