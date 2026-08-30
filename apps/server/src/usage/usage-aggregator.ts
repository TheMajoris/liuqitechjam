import type { AuditEvent } from "../audit/audit-types.js";
import type { OrchestrationSession, OrchestrationTurn } from "../orchestration/types.js";
import type { Project } from "../projects/project-types.js";
import type { Agent, AgentRun, Message } from "../types.js";
import { normalizeRunUsage } from "../telemetry/telemetry-usage.js";
import type {
  UsageActivityTotals,
  UsageAgentBreakdown,
  UsageDailyPoint,
  UsageLatency,
  UsageProjectBreakdown,
  UsageReport,
  UsageReportOptions,
  UsageRunTotals,
  UsageTokenTotals,
  UsageTotals,
  UsageWorkspaceBreakdown,
} from "./usage-types.js";

const DEFAULT_DAILY_WINDOW = 30;
const MAX_DAILY_WINDOW = 365;
const DAY_MS = 86_400_000;

/** Everything the report reads, taken from one consistent store snapshot. */
export interface UsageSource {
  agents: readonly Agent[];
  runs: readonly AgentRun[];
  messages: readonly Message[];
  orchestrations: readonly OrchestrationSession[];
  orchestrationTurns: readonly OrchestrationTurn[];
  projects: readonly Project[];
  auditEvents: readonly AuditEvent[];
}

/**
 * Mutable accumulator. Latency samples are retained so a percentile can be
 * taken once at the end rather than approximated per run.
 */
interface UsageAccumulator {
  runs: UsageRunTotals;
  tokens: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    runsReporting: number;
    runsMissing: number;
    runsPartial: number;
  };
  activity: UsageActivityTotals;
  latencies: number[];
  messages: number;
  lastActiveAt: string | null;
}

function createAccumulator(): UsageAccumulator {
  return {
    runs: { total: 0, completed: 0, failed: 0, cancelled: 0, active: 0 },
    tokens: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      runsReporting: 0,
      runsMissing: 0,
      runsPartial: 0,
    },
    activity: {
      toolCalls: 0,
      toolFailures: 0,
      approvalsRequired: 0,
      skillInvocations: 0,
      authorizationDenials: 0,
    },
    latencies: [],
    messages: 0,
    lastActiveAt: null,
  };
}

function noteActivity(accumulator: UsageAccumulator, at: string | null): void {
  if (at === null) return;
  if (accumulator.lastActiveAt === null || at > accumulator.lastActiveAt) {
    accumulator.lastActiveAt = at;
  }
}

function addRun(accumulator: UsageAccumulator, run: AgentRun): void {
  accumulator.runs.total += 1;
  if (run.status === "completed") accumulator.runs.completed += 1;
  else if (run.status === "failed") accumulator.runs.failed += 1;
  else if (run.status === "cancelled") accumulator.runs.cancelled += 1;
  else accumulator.runs.active += 1;

  const usage = normalizeRunUsage(run.usage);
  if (usage.availability === "unavailable") {
    accumulator.tokens.runsMissing += 1;
  } else {
    accumulator.tokens.runsReporting += 1;
    if (usage.availability === "partial") accumulator.tokens.runsPartial += 1;
    accumulator.tokens.inputTokens += usage.inputTokens ?? 0;
    accumulator.tokens.cachedInputTokens += usage.cachedInputTokens ?? 0;
    accumulator.tokens.outputTokens += usage.outputTokens ?? 0;
  }

  const duration = runDurationMs(run);
  if (duration !== null) accumulator.latencies.push(duration);
  noteActivity(accumulator, run.completedAt ?? run.startedAt ?? run.createdAt);
}

/** Only runs that recorded both ends contribute; a clock skew is discarded. */
function runDurationMs(run: AgentRun): number | null {
  if (run.startedAt === null || run.completedAt === null) return null;
  const started = Date.parse(run.startedAt);
  const completed = Date.parse(run.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  const duration = completed - started;
  return duration >= 0 ? duration : null;
}

function addAuditEvent(accumulator: UsageAccumulator, event: AuditEvent): void {
  switch (event.type) {
    // `tool_started` is the call counter; the outcome pair would double-count.
    case "tool_started":
      accumulator.activity.toolCalls += 1;
      break;
    case "tool_failed":
      accumulator.activity.toolFailures += 1;
      break;
    case "tool_approval_required":
      accumulator.activity.approvalsRequired += 1;
      break;
    case "skill_invoked":
      accumulator.activity.skillInvocations += 1;
      break;
    case "authorization_decision":
      if (event.status === "failure") accumulator.activity.authorizationDenials += 1;
      break;
    default:
      break;
  }
  noteActivity(accumulator, event.createdAt);
}

function summarizeTokens(accumulator: UsageAccumulator): UsageTokenTotals {
  const { tokens } = accumulator;
  const availability = tokens.runsReporting === 0
    ? "unavailable"
    : tokens.runsMissing > 0 || tokens.runsPartial > 0
      ? "partial"
      : "available";
  return {
    availability,
    inputTokens: tokens.inputTokens,
    cachedInputTokens: tokens.cachedInputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.inputTokens + tokens.outputTokens,
    runsReporting: tokens.runsReporting,
  };
}

function summarizeLatency(samples: readonly number[]): UsageLatency {
  if (samples.length === 0) {
    return { samples: 0, averageMs: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const rank = Math.ceil(sorted.length * 0.95);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return {
    samples: sorted.length,
    averageMs: Math.round(total / sorted.length),
    p95Ms: sorted[index] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function hasActivity(totals: UsageTotals): boolean {
  const { runs, activity } = totals;
  return (
    runs.total > 0 ||
    totals.messages > 0 ||
    activity.toolCalls > 0 ||
    activity.toolFailures > 0 ||
    activity.approvalsRequired > 0 ||
    activity.skillInvocations > 0 ||
    activity.authorizationDenials > 0
  );
}

/**
 * Whether a live subject's row is worth showing.
 *
 * Deleting an Agent removes its runs and messages but deliberately leaves the
 * audit journal intact, so correlation residue alone must not produce an
 * all-zero row carrying nothing a reader can act on.
 */
function keepRow(totals: UsageTotals): boolean {
  return totals.runs.total > 0 || hasActivity(totals);
}

function summarize(accumulator: UsageAccumulator): UsageTotals {
  return {
    runs: { ...accumulator.runs },
    tokens: summarizeTokens(accumulator),
    activity: { ...accumulator.activity },
    latency: summarizeLatency(accumulator.latencies),
    messages: accumulator.messages,
  };
}

function accumulatorFor(
  buckets: Map<string, UsageAccumulator>,
  key: string,
): UsageAccumulator {
  const existing = buckets.get(key);
  if (existing !== undefined) return existing;
  const created = createAccumulator();
  buckets.set(key, created);
  return created;
}

/** UTC day key; the series is day-bucketed so timezone drift cannot shift it. */
function dayKey(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function withinWindow(timestamp: string, since: number | null): boolean {
  if (since === null) return true;
  const parsed = Date.parse(timestamp);
  // An unparseable timestamp is legacy data; keep it rather than silently drop.
  if (!Number.isFinite(parsed)) return true;
  return parsed >= since;
}

function boundedDays(days: number | undefined): number {
  if (days === undefined || !Number.isInteger(days) || days <= 0) {
    return DEFAULT_DAILY_WINDOW;
  }
  return Math.min(days, MAX_DAILY_WINDOW);
}

/** Zero-filled ascending series so a chart never has to infer missing days. */
function buildDailySeries(
  points: Map<string, UsageDailyPoint>,
  days: number,
  now: number,
): UsageDailyPoint[] {
  const series: UsageDailyPoint[] = [];
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z");
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today - offset * DAY_MS).toISOString().slice(0, 10);
    series.push(
      points.get(date) ?? {
        date,
        runs: 0,
        completed: 0,
        failed: 0,
        totalTokens: 0,
        toolCalls: 0,
      },
    );
  }
  return series;
}

function dailyPointFor(
  points: Map<string, UsageDailyPoint>,
  date: string,
): UsageDailyPoint {
  const existing = points.get(date);
  if (existing !== undefined) return existing;
  const created: UsageDailyPoint = {
    date,
    runs: 0,
    completed: 0,
    failed: 0,
    totalTokens: 0,
    toolCalls: 0,
  };
  points.set(date, created);
  return created;
}

/**
 * Reduce a store snapshot into the usage report.
 *
 * Pure by construction: the caller supplies the snapshot and the clock, so the
 * whole aggregation is testable without a server, a store, or a fake timer.
 */
export function buildUsageReport(
  source: UsageSource,
  options: UsageReportOptions = {},
  now: number = Date.now(),
): UsageReport {
  const sinceMs = options.since === undefined ? null : Date.parse(options.since);
  const since = sinceMs !== null && Number.isFinite(sinceMs) ? sinceMs : null;
  const days = boundedDays(options.days);

  // Team turns are the only link from a run back to the session that ran it.
  const runToWorkspace = new Map<string, string>();
  for (const turn of source.orchestrationTurns) {
    runToWorkspace.set(turn.runId, turn.sessionId);
  }
  const workspaceToProject = new Map<string, string>();
  for (const session of source.orchestrations) {
    if (typeof session.projectId === "string" && session.projectId.length > 0) {
      workspaceToProject.set(session.id, session.projectId);
    }
  }
  // A direct run carries no projectId, so the audit journal supplies it.
  const runToProject = new Map<string, string>();
  for (const event of source.auditEvents) {
    if (event.runId !== undefined && event.projectId !== undefined) {
      runToProject.set(event.runId, event.projectId);
    }
  }

  const totals = createAccumulator();
  const byAgent = new Map<string, UsageAccumulator>();
  const byWorkspace = new Map<string, UsageAccumulator>();
  const byProject = new Map<string, UsageAccumulator>();
  const daily = new Map<string, UsageDailyPoint>();

  for (const run of source.runs) {
    if (!withinWindow(run.createdAt, since)) continue;
    addRun(totals, run);
    addRun(accumulatorFor(byAgent, run.agentId), run);

    const workspaceId = runToWorkspace.get(run.id);
    if (workspaceId !== undefined) addRun(accumulatorFor(byWorkspace, workspaceId), run);

    const projectId = runToProject.get(run.id) ??
      (workspaceId === undefined ? undefined : workspaceToProject.get(workspaceId));
    if (projectId !== undefined) addRun(accumulatorFor(byProject, projectId), run);

    const date = dayKey(run.createdAt);
    if (date !== null) {
      const point = dailyPointFor(daily, date);
      point.runs += 1;
      if (run.status === "completed") point.completed += 1;
      if (run.status === "failed") point.failed += 1;
      const usage = normalizeRunUsage(run.usage);
      point.totalTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
  }

  for (const message of source.messages) {
    if (!withinWindow(message.createdAt, since)) continue;
    totals.messages += 1;
    accumulatorFor(byAgent, message.agentId).messages += 1;
    const workspaceId = runToWorkspace.get(message.runId);
    if (workspaceId !== undefined) {
      accumulatorFor(byWorkspace, workspaceId).messages += 1;
    }
    const projectId = runToProject.get(message.runId) ??
      (workspaceId === undefined ? undefined : workspaceToProject.get(workspaceId));
    if (projectId !== undefined) {
      // Messages are part of the same conversation roll-up as their run. The
      // Project ID is stable even when the child Team session is later removed.
      accumulatorFor(byProject, projectId).messages += 1;
    }
  }

  for (const event of source.auditEvents) {
    if (!withinWindow(event.createdAt, since)) continue;
    addAuditEvent(totals, event);
    if (event.agentId !== undefined) {
      addAuditEvent(accumulatorFor(byAgent, event.agentId), event);
    }
    const workspaceId = event.orchestrationId ??
      (event.runId === undefined ? undefined : runToWorkspace.get(event.runId));
    if (workspaceId !== undefined) {
      addAuditEvent(accumulatorFor(byWorkspace, workspaceId), event);
    }
    // Resolved exactly like a run's Project, so a Team's tool calls land on
    // the Project its runs already landed on rather than vanishing.
    const projectId = event.projectId ??
      (event.runId === undefined ? undefined : runToProject.get(event.runId)) ??
      (workspaceId === undefined ? undefined : workspaceToProject.get(workspaceId));
    if (projectId !== undefined) {
      addAuditEvent(accumulatorFor(byProject, projectId), event);
    }
    if (event.type === "tool_started") {
      const date = dayKey(event.createdAt);
      if (date !== null) dailyPointFor(daily, date).toolCalls += 1;
    }
  }

  const agentsById = new Map(source.agents.map((agent) => [agent.id, agent]));
  // Seed from the complete live roster so a newly created Agent is honest
  // about having zero usage instead of disappearing from Insights. Stale
  // audit/run IDs are intentionally not promoted into named rows.
  const agents: UsageAgentBreakdown[] = [...agentsById.values()].map((agent) => {
    const accumulator = byAgent.get(agent.id) ?? createAccumulator();
    return {
      agentId: agent.id,
      name: agent.name,
      status: agent.status,
      modelLabel: agent.modelRef?.modelId ?? null,
      lastActiveAt: accumulator.lastActiveAt,
      ...summarize(accumulator),
    };
  });

  const sessionsById = new Map(
    source.orchestrations.map((session) => [session.id, session]),
  );
  const workspaces: UsageWorkspaceBreakdown[] = [...byWorkspace.entries()]
    .map(([orchestrationId, accumulator]) => {
      const session = sessionsById.get(orchestrationId);
      return {
        orchestrationId,
        name: session?.name ?? null,
        status: session?.status ?? null,
        projectId: session?.projectId ?? null,
        participants: session?.participants.length ?? 0,
        lastActiveAt: accumulator.lastActiveAt,
        ...summarize(accumulator),
      };
    })
    // A deleted child Conversation no longer has a session row. Keep its
    // historical spend in totals, but never render a ghost workspace row.
    .filter((row) => sessionsById.has(row.orchestrationId) && keepRow(row));

  const projectsById = new Map(source.projects.map((project) => [project.id, project]));
  const projects: UsageProjectBreakdown[] = [...byProject.entries()]
    .map(([projectId, accumulator]) => {
      const project = projectsById.get(projectId);
      return {
        projectId,
        name: project?.name ?? null,
        // A workspace breakdown names only currently live Workspaces. Usage
        // from archived/missing IDs remains in top-level totals.
        archived: false,
        lastActiveAt: accumulator.lastActiveAt,
        ...summarize(accumulator),
      };
    })
    .filter((row) => {
      const project = projectsById.get(row.projectId);
      // Older snapshots did not persist status; only an explicit archive is
      // retired, while missing IDs remain excluded from named rows.
      return project !== undefined && project.status !== "archived" && keepRow(row);
    });

  const byBusiest = (
    left: { runs: UsageRunTotals; tokens: UsageTokenTotals },
    right: { runs: UsageRunTotals; tokens: UsageTokenTotals },
  ): number =>
    right.runs.total - left.runs.total ||
    right.tokens.totalTokens - left.tokens.totalTokens;

  agents.sort(byBusiest);
  workspaces.sort(byBusiest);
  projects.sort(byBusiest);

  return {
    since: since === null ? null : new Date(since).toISOString(),
    generatedAt: new Date(now).toISOString(),
    totals: summarize(totals),
    agents,
    workspaces,
    projects,
    // Retired subjects are deliberately omitted from all named breakdowns;
    // totals above remain the historical accounting surface.
    retired: {
      agents: null,
      workspaces: null,
      projects: null,
    },
    daily: buildDailySeries(daily, days, now),
  };
}
