import type { AuditReader } from "../audit/audit-types.js";
import type { ContainerHealthSample } from "../telemetry/container-health-sampler.js";
import { normalizeRunUsage } from "../telemetry/telemetry-usage.js";
import type { Agent, AgentRun, RunUsage } from "../types.js";

const AUDIT_QUERY_LIMIT = 200;
const TOKENS_PER_SECOND_SAMPLE_SIZE = 10;

export interface AgentMetrics {
  agentId: string;
  lifecycle: "ready" | "busy" | "stopped" | "error";
  currentRun: { id: string; elapsedMs: number; model: string | null } | null;
  tokens: {
    lastRun: RunUsage | null;
    session: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    tokensPerSecondLastRun: number | null;
    tokensPerSecondAvg: number | null;
  };
  tools: { calls: number; denied: number; sandboxCommands: number; filesChanged: number };
  container: {
    cpuPct: number;
    memBytes: number;
    memLimitBytes: number | null;
    pids: number | null;
    sampledAt: string;
    oomKilled: boolean | null;
    uptimeMs: number | null;
  } | null;
  lastError: string | null;
  model: string | null;
  fallbackUsed: boolean;
}

export interface AgentMetricsSources {
  agents: () => Agent[];
  runs: (agentId: string) => AgentRun[];
  audit?: AuditReader;
  healthSampler?: { latest(agentId: string): ContainerHealthSample | null };
  now?: () => number;
}

function modelRefLabel(ref: { providerId: string; modelId: string } | undefined): string | null {
  if (!ref) return null;
  return ref.modelId;
}

function runDurationSeconds(run: AgentRun): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  const startedAt = Date.parse(run.startedAt);
  const completedAt = Date.parse(run.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null;
  const seconds = (completedAt - startedAt) / 1000;
  return seconds > 0 ? seconds : null;
}

/** Tokens/sec for one completed run with usable output tokens and timestamps. */
function tokensPerSecond(run: AgentRun): number | null {
  const usage = normalizeRunUsage(run.usage);
  if (usage.outputTokens === undefined) return null;
  const seconds = runDurationSeconds(run);
  if (seconds === null) return null;
  return usage.outputTokens / seconds;
}

/** Runs eligible for a tok/s reading: completed, with usage and both timestamps. */
function completedRunsWithRate(runs: AgentRun[]): { run: AgentRun; rate: number }[] {
  const eligible: { run: AgentRun; rate: number }[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const rate = tokensPerSecond(run);
    if (rate === null) continue;
    eligible.push({ run, rate });
  }
  return eligible;
}

function sessionTokens(runs: AgentRun[]): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
} {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const run of runs) {
    const usage = normalizeRunUsage(run.usage);
    inputTokens += usage.inputTokens ?? 0;
    cachedInputTokens += usage.cachedInputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
  }
  return { inputTokens, cachedInputTokens, outputTokens };
}

export class AgentMetricsService {
  constructor(private readonly sources: AgentMetricsSources) {}

  forAgent(agentId: string): AgentMetrics {
    const agent = this.sources.agents().find((item) => item.id === agentId);
    return this.buildMetrics(agentId, agent);
  }

  forAgents(agentIds: string[]): AgentMetrics[] {
    const agents = this.sources.agents();
    return agentIds.map((agentId) => {
      const agent = agents.find((item) => item.id === agentId);
      return this.buildMetrics(agentId, agent);
    });
  }

  private buildMetrics(agentId: string, agent: Agent | undefined): AgentMetrics {
    const now = this.sources.now ? this.sources.now() : Date.now();
    const runs = this.sources.runs(agentId);
    const sortedRuns = [...runs].sort((left, right) =>
      (right.startedAt ?? "").localeCompare(left.startedAt ?? ""),
    );

    const activeRun = sortedRuns.find(
      (run) => run.status === "queued" || run.status === "running",
    );
    const lastCompletedRun = sortedRuns.find((run) => run.completedAt !== null);

    const eligible = completedRunsWithRate(sortedRuns).slice(0, TOKENS_PER_SECOND_SAMPLE_SIZE);
    const lastEligible = eligible[0] ?? null;
    const tokensPerSecondLastRun = activeRun ? null : (lastEligible?.rate ?? null);
    const tokensPerSecondAvg =
      eligible.length > 0
        ? eligible.reduce((sum, item) => sum + item.rate, 0) / eligible.length
        : null;

    const currentRun = activeRun
      ? {
          id: activeRun.id,
          elapsedMs: activeRun.startedAt ? Math.max(0, now - Date.parse(activeRun.startedAt)) : 0,
          model: modelRefLabel(activeRun.modelUsed ?? activeRun.modelSnapshot?.modelRef),
        }
      : null;

    const toolCounts = this.toolCounts(agentId);
    const sample = this.sources.healthSampler?.latest(agentId) ?? null;
    const oomKilled = this.lastOomKilled(agentId);

    const container = sample
      ? {
          cpuPct: sample.cpuPct,
          memBytes: sample.memBytes,
          memLimitBytes: sample.memLimitBytes,
          pids: sample.pids,
          sampledAt: sample.at,
          oomKilled,
          uptimeMs:
            currentRun && activeRun?.startedAt
              ? Math.max(0, now - Date.parse(activeRun.startedAt))
              : null,
        }
      : null;

    const model =
      modelRefLabel(agent?.modelRef) ??
      modelRefLabel(lastCompletedRun?.modelUsed ?? lastCompletedRun?.modelSnapshot?.modelRef);

    return {
      agentId,
      lifecycle: agent?.status ?? "stopped",
      currentRun,
      tokens: {
        lastRun: lastCompletedRun ? normalizeRunUsageToRunUsage(lastCompletedRun.usage) : null,
        session: sessionTokens(sortedRuns),
        tokensPerSecondLastRun,
        tokensPerSecondAvg,
      },
      tools: toolCounts,
      container,
      lastError: agent?.lastError ?? null,
      model,
      fallbackUsed: lastCompletedRun?.fallbackUsed !== undefined,
    };
  }

  private toolCounts(agentId: string): {
    calls: number;
    denied: number;
    sandboxCommands: number;
    filesChanged: number;
  } {
    const audit = this.sources.audit;
    if (!audit) return { calls: 0, denied: 0, sandboxCommands: 0, filesChanged: 0 };

    // Bounded windows (limit 200 per event type) — a recent-activity view,
    // not a lifetime total.
    const started = audit.query({ agentId, type: "tool_started", limit: AUDIT_QUERY_LIMIT });
    const failed = audit.query({ agentId, type: "tool_failed", limit: AUDIT_QUERY_LIMIT });
    const authDecisions = audit.query({
      agentId,
      type: "authorization_decision",
      limit: AUDIT_QUERY_LIMIT,
    });
    const sandboxCommands = audit.query({
      agentId,
      type: "sandbox_command",
      limit: AUDIT_QUERY_LIMIT,
    });
    const fileChanges = audit.query({
      agentId,
      type: "workspace_file_change",
      limit: AUDIT_QUERY_LIMIT,
    });

    const deniedFromAuth = authDecisions.filter((event) => event.status === "failure").length;
    const deniedFromTools = failed.filter(
      (event) => event.metadata.errorCode === "PERMISSION_DENIED",
    ).length;

    const filesChanged = fileChanges.reduce((sum, event) => {
      const fileCount = event.metadata.fileCount;
      return typeof fileCount === "number" ? sum + fileCount : sum;
    }, 0);

    return {
      calls: started.length,
      denied: deniedFromAuth + deniedFromTools,
      sandboxCommands: sandboxCommands.length,
      filesChanged,
    };
  }

  private lastOomKilled(agentId: string): boolean | null {
    const audit = this.sources.audit;
    if (!audit) return null;
    const events = audit.query({ agentId, type: "sandbox_exited", limit: AUDIT_QUERY_LIMIT });
    if (events.length === 0) return null;
    const mostRecent = [...events].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0];
    const oomKilled = mostRecent?.metadata.oomKilled;
    return typeof oomKilled === "boolean" ? oomKilled : null;
  }
}

function normalizeRunUsageToRunUsage(usage: RunUsage | null): RunUsage | null {
  if (!usage) return null;
  const normalized = normalizeRunUsage(usage);
  return {
    ...(normalized.inputTokens === undefined ? {} : { inputTokens: normalized.inputTokens }),
    ...(normalized.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: normalized.cachedInputTokens }),
    ...(normalized.outputTokens === undefined ? {} : { outputTokens: normalized.outputTokens }),
  };
}
