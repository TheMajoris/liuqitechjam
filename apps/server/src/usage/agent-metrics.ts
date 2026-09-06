import type { AuditReader } from "../audit/audit-types.js";
import type { ContainerHealthSample } from "../telemetry/container-health-sampler.js";
import {
  normalizeRunUsage,
  type UsageAvailability,
} from "../telemetry/telemetry-usage.js";
import type { Agent, AgentRun, RunUsage } from "../types.js";

const AUDIT_QUERY_LIMIT = 200;
const TOKENS_PER_SECOND_SAMPLE_SIZE = 10;

export interface AgentMetrics {
  agentId: string;
  lifecycle: "ready" | "busy" | "stopped" | "error";
  currentRun: { id: string; elapsedMs: number; model: string | null } | null;
  tokens: {
    lastRun: RunUsage | null;
    /** Null means that counter was not reported by the runtime. */
    session: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null };
    sessionAvailability: UsageAvailability;
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

interface AuditUsageSnapshot {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  mcpToolCalls?: number;
  sandboxCommands?: number;
  fileChanges?: number;
}

function finiteCounter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function metadataCounter(
  metadata: Readonly<Record<string, unknown>>,
  camelCase: string,
  snakeCase: string,
): number | undefined {
  return finiteCounter(metadata[camelCase] ?? metadata[snakeCase]);
}

/**
 * Model-turn evidence is written by the runtime observer before the terminal
 * Run mutation completes. It is therefore also the compatibility path for
 * older Run records whose `usage` field was never persisted.
 */
function auditUsageByRun(audit: AuditReader | undefined, agentId: string): Map<string, AuditUsageSnapshot> {
  const byRun = new Map<string, AuditUsageSnapshot>();
  if (!audit) return byRun;

  const modelTurns = audit.query({ agentId, type: "model_turn", limit: AUDIT_QUERY_LIMIT });
  for (const event of modelTurns) {
    if (!event.runId) continue;
    const current = byRun.get(event.runId) ?? {};
    const inputTokens = metadataCounter(event.metadata, "inputTokens", "input_tokens");
    const cachedInputTokens = metadataCounter(
      event.metadata,
      "cachedInputTokens",
      "cached_input_tokens",
    );
    const outputTokens = metadataCounter(event.metadata, "outputTokens", "output_tokens");
    // A Run may contain more than one model turn (for example, a resumed
    // runtime). Sum each observed turn rather than dropping earlier evidence.
    if (inputTokens !== undefined) current.inputTokens = (current.inputTokens ?? 0) + inputTokens;
    if (cachedInputTokens !== undefined) {
      current.cachedInputTokens = (current.cachedInputTokens ?? 0) + cachedInputTokens;
    }
    if (outputTokens !== undefined) current.outputTokens = (current.outputTokens ?? 0) + outputTokens;
    const durationMs = finiteCounter(event.durationMs ?? event.metadata.durationMs);
    if (durationMs !== undefined) current.durationMs = (current.durationMs ?? 0) + durationMs;
    const mcpToolCalls = metadataCounter(event.metadata, "mcpToolItems", "mcp_tool_items");
    if (mcpToolCalls !== undefined) current.mcpToolCalls = (current.mcpToolCalls ?? 0) + mcpToolCalls;
    const sandboxCommands = metadataCounter(event.metadata, "commandItems", "command_items");
    if (sandboxCommands !== undefined) {
      current.sandboxCommands = (current.sandboxCommands ?? 0) + sandboxCommands;
    }
    const fileChanges = metadataCounter(event.metadata, "fileChangeItems", "file_change_items");
    if (fileChanges !== undefined) current.fileChanges = (current.fileChanges ?? 0) + fileChanges;
    byRun.set(event.runId, current);
  }

  // `run_completed` is the older audit shape and is also useful when a legacy
  // runtime did not emit model_turn. Fill only missing fields so a modern
  // model_turn plus its terminal event is never double-counted.
  const completed = audit.query({ agentId, type: "run_completed", limit: AUDIT_QUERY_LIMIT });
  for (const event of completed) {
    if (!event.runId) continue;
    const current = byRun.get(event.runId) ?? {};
    if (current.inputTokens === undefined) {
      const value = metadataCounter(event.metadata, "inputTokens", "input_tokens");
      if (value !== undefined) current.inputTokens = value;
    }
    if (current.cachedInputTokens === undefined) {
      const value = metadataCounter(event.metadata, "cachedInputTokens", "cached_input_tokens");
      if (value !== undefined) current.cachedInputTokens = value;
    }
    if (current.outputTokens === undefined) {
      const value = metadataCounter(event.metadata, "outputTokens", "output_tokens");
      if (value !== undefined) current.outputTokens = value;
    }
    if (current.durationMs === undefined) {
      const value = finiteCounter(event.durationMs ?? event.metadata.durationMs);
      if (value !== undefined) current.durationMs = value;
    }
    byRun.set(event.runId, current);
  }
  return byRun;
}

function mergeUsage(runUsage: RunUsage | null, auditUsage: AuditUsageSnapshot | undefined): RunUsage | null {
  // A short-lived compatibility bridge for stores written by integrations
  // that used the provider's snake_case counter names directly.
  const persisted = runUsage as (RunUsage & Record<string, unknown>) | null;
  const inputTokens = finiteCounter(persisted?.inputTokens ?? persisted?.input_tokens) ??
    auditUsage?.inputTokens;
  const cachedInputTokens =
    finiteCounter(persisted?.cachedInputTokens ?? persisted?.cached_input_tokens) ??
    auditUsage?.cachedInputTokens;
  const outputTokens = finiteCounter(persisted?.outputTokens ?? persisted?.output_tokens) ??
    auditUsage?.outputTokens;
  if (inputTokens === undefined && cachedInputTokens === undefined && outputTokens === undefined) {
    return null;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** Tokens/sec for one completed run with usable output and timing evidence. */
function tokensPerSecond(
  run: AgentRun,
  usageInput: RunUsage | null,
  auditUsage: AuditUsageSnapshot | undefined,
): number | null {
  const usage = normalizeRunUsage(usageInput);
  if (usage.outputTokens === undefined) return null;
  const seconds = runDurationSeconds(run) ??
    (auditUsage?.durationMs !== undefined && auditUsage.durationMs > 0
      ? auditUsage.durationMs / 1000
      : null);
  if (seconds === null) return null;
  return usage.outputTokens / seconds;
}

/** Runs eligible for a tok/s reading: completed, with usage and both timestamps. */
function completedRunsWithRate(
  runs: AgentRun[],
  auditUsageByRunMap: Map<string, AuditUsageSnapshot>,
): { run: AgentRun; rate: number }[] {
  const eligible: { run: AgentRun; rate: number }[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const auditUsage = auditUsageByRunMap.get(run.id);
    const usage = mergeUsage(run.usage, auditUsage);
    const rate = tokensPerSecond(run, usage, auditUsage);
    if (rate === null) continue;
    eligible.push({ run, rate });
  }
  return eligible;
}

function sessionTokens(runs: AgentRun[]): {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  availability: UsageAvailability;
} {
  let inputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let outputTokens: number | undefined;
  let runsReporting = 0;
  let runsMissing = 0;
  let runsPartial = 0;
  for (const run of runs) {
    const usage = normalizeRunUsage(run.usage);
    if (usage.availability === "unavailable") {
      runsMissing += 1;
    } else {
      runsReporting += 1;
      if (usage.availability === "partial") runsPartial += 1;
      if (usage.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + usage.inputTokens;
      if (usage.cachedInputTokens !== undefined) {
        cachedInputTokens = (cachedInputTokens ?? 0) + usage.cachedInputTokens;
      }
      if (usage.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + usage.outputTokens;
    }
  }
  const availability: UsageAvailability = runsReporting === 0
    ? "unavailable"
    : runsMissing > 0 || runsPartial > 0
      ? "partial"
      : "available";
  return {
    inputTokens: inputTokens ?? null,
    cachedInputTokens: cachedInputTokens ?? null,
    outputTokens: outputTokens ?? null,
    availability,
  };
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
    const auditUsage = auditUsageByRun(this.sources.audit, agentId);
    const sortedRuns = [...runs].sort((left, right) =>
      (right.startedAt ?? "").localeCompare(left.startedAt ?? ""),
    );

    const activeRun = sortedRuns.find(
      (run) => run.status === "queued" || run.status === "running",
    );
    const lastCompletedRun = [...sortedRuns]
      .filter((run) => run.status === "completed")
      .sort((left, right) => {
        const leftAt = left.completedAt ?? left.startedAt ?? left.createdAt;
        const rightAt = right.completedAt ?? right.startedAt ?? right.createdAt;
        return rightAt.localeCompare(leftAt);
      })[0];

    const eligible = completedRunsWithRate(sortedRuns, auditUsage).slice(0, TOKENS_PER_SECOND_SAMPLE_SIZE);
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

    const toolCounts = this.toolCounts(agentId, auditUsage);
    const session = sessionTokens(
      sortedRuns.map((run) => ({
        ...run,
        usage: mergeUsage(run.usage, auditUsage.get(run.id)),
      })),
    );
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
        lastRun: lastCompletedRun
          ? normalizeRunUsageToRunUsage(
              mergeUsage(lastCompletedRun.usage, auditUsage.get(lastCompletedRun.id)),
            )
          : null,
        session: {
          inputTokens: session.inputTokens,
          cachedInputTokens: session.cachedInputTokens,
          outputTokens: session.outputTokens,
        },
        sessionAvailability: session.availability,
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

  private toolCounts(agentId: string, auditUsage: Map<string, AuditUsageSnapshot>): {
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
    const mcpCalls = audit.query({ agentId, type: "mcp_tool_call", limit: AUDIT_QUERY_LIMIT });
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

    // Codex emits an mcp_tool_call for a request that the MCP server also
    // records as tool_started. Reconcile by (Run, tool) so the same call is
    // never counted twice, while preserving calls from legacy/runtime-only
    // records that have no matching server event.
    const startedByKey = new Map<string, number>();
    for (const event of started) {
      const toolId = event.resource?.kind === "tool" ? event.resource.id : null;
      if (!event.runId || !toolId) continue;
      const key = event.runId + "|" + toolId;
      startedByKey.set(key, (startedByKey.get(key) ?? 0) + 1);
    }
    let unmatchedMcpCalls = 0;
    for (const event of mcpCalls) {
      const toolId = typeof event.metadata.toolId === "string" ? event.metadata.toolId : null;
      const key = event.runId && toolId ? event.runId + "|" + toolId : null;
      const count = key === null ? 0 : (startedByKey.get(key) ?? 0);
      if (key !== null && count > 0) startedByKey.set(key, count - 1);
      else unmatchedMcpCalls += 1;
    }

    const reconciledCalls = started.length + unmatchedMcpCalls;
    const runtimeMcpCalls = [...auditUsage.values()].reduce(
      (sum, item) => sum + (item.mcpToolCalls ?? 0),
      0,
    );
    const runtimeSandboxCommands = [...auditUsage.values()].reduce(
      (sum, item) => sum + (item.sandboxCommands ?? 0),
      0,
    );
    const runtimeFileChanges = [...auditUsage.values()].reduce(
      (sum, item) => sum + (item.fileChanges ?? 0),
      0,
    );
    const observedFileSummaries = fileChanges.filter(
      (event) => typeof event.metadata.fileCount === "number",
    );
    const perFileEvents = fileChanges.filter(
      (event) =>
        typeof event.metadata.fileCount !== "number" &&
        (typeof event.metadata.kind === "string" || typeof event.metadata.pathHash === "string"),
    );
    const fileCount = observedFileSummaries.length > 0
      ? filesChanged
      : Math.max(filesChanged, perFileEvents.length);

    return {
      calls: Math.max(reconciledCalls, runtimeMcpCalls),
      denied: deniedFromAuth + deniedFromTools,
      sandboxCommands: Math.max(sandboxCommands.length, runtimeSandboxCommands),
      filesChanged: Math.max(fileCount, runtimeFileChanges),
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
