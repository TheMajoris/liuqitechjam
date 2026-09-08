import type { RunStatus } from "../types.js";
import { runContextWindow, type RunContextWindow } from "../telemetry/context-window.js";
import {
  summarizeRunTokens,
  type RunTokenTotals,
} from "../telemetry/telemetry-usage.js";
import type { AuditEvent } from "./audit-types.js";
import type { AuditRunSnapshot } from "./audit-timeline.js";

export const DEFAULT_RUN_HISTORY_LIMIT = 50;
export const MAX_RUN_HISTORY_LIMIT = 200;
export const MAX_RUN_TITLE_LENGTH = 160;

/**
 * A historical Run rollup: the Run record joined with the audit evidence it
 * produced.
 *
 * Every identifying field is read from the Run itself rather than from the
 * live Agent directory, so an entry stays complete after its Agent is deleted.
 */
export interface RunHistoryEntry {
  runId: string;
  agentId: string;
  agentName: string;
  /** True when the Agent that produced this Run no longer exists. */
  agentDeleted: boolean;
  agentDeletedAt: string | null;
  status: RunStatus;
  /** Short human label for the Run, derived from its prompt. */
  title: string;
  traceId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Wall-clock execution time; null while the Run has not finished. */
  durationMs: number | null;
  eventCount: number;
  errorCount: number;
  /**
   * Provider-reported token counters for this Run. `availability` stays
   * explicit so a Run that reported nothing is never shown as zero tokens.
   */
  tokens: RunTokenTotals;
  /**
   * What the Run left occupied in its model's context window.
   *
   * Null when the model has no configured window or the provider reported no
   * counters — headroom is never guessed at.
   */
  context: RunContextWindow | null;
  failed: boolean;
  error: string | null;
}

/** Looks up the configured context window for a model id. */
export type ContextWindowLookup = (modelId: string) => number | undefined;

export interface RunHistoryQuery {
  agentId?: string | undefined;
  status?: RunStatus | undefined;
  limit?: number | undefined;
}

interface RunEvidence {
  eventCount: number;
  errorCount: number;
  traceId: string;
}

function runTitle(prompt: string | undefined): string {
  const firstLine = (prompt ?? "").trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "Run";
  return firstLine.length > MAX_RUN_TITLE_LENGTH
    ? firstLine.slice(0, MAX_RUN_TITLE_LENGTH - 1) + "…"
    : firstLine;
}

function elapsed(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Group audit evidence by the Run it belongs to. */
function evidenceByRun(events: readonly AuditEvent[]): Map<string, RunEvidence> {
  const byRun = new Map<string, RunEvidence>();
  for (const event of events) {
    if (event.runId === undefined) continue;
    const existing = byRun.get(event.runId);
    if (existing === undefined) {
      byRun.set(event.runId, {
        eventCount: 1,
        errorCount: event.status === "failure" ? 1 : 0,
        traceId: event.traceId,
      });
      continue;
    }
    existing.eventCount += 1;
    if (event.status === "failure") existing.errorCount += 1;
  }
  return byRun;
}

function toEntry(
  run: AuditRunSnapshot,
  evidence: RunEvidence | undefined,
  contextWindow: ContextWindowLookup | undefined,
): RunHistoryEntry {
  const status = run.status ?? "completed";
  const startedAt = run.startedAt ?? null;
  const completedAt = run.completedAt ?? null;
  return {
    runId: run.id,
    agentId: run.agentId,
    // A Run recorded before name snapshots existed still identifies its Agent
    // by ID; it must never be presented as an unknown Agent.
    agentName: run.agentName ?? "Agent " + run.agentId.slice(0, 8),
    agentDeleted: run.agentDeletedAt !== undefined,
    agentDeletedAt: run.agentDeletedAt ?? null,
    status,
    title: runTitle(run.prompt),
    traceId: run.traceId ?? evidence?.traceId ?? null,
    createdAt: run.createdAt ?? startedAt ?? "",
    startedAt,
    completedAt,
    durationMs: elapsed(startedAt, completedAt),
    eventCount: evidence?.eventCount ?? 0,
    errorCount: evidence?.errorCount ?? 0,
    tokens: summarizeRunTokens([run.usage]),
    context: runContextWindow(
      run.usage,
      run.modelUsed === undefined ? undefined : contextWindow?.(run.modelUsed.modelId),
    ),
    failed: status === "failed",
    error: run.error ?? null,
  };
}

/**
 * Bounded list of historical Run rollups, newest first.
 *
 * Runs are the source of the list and audit events only decorate it, so a Run
 * whose Agent was deleted remains present with its full identity.
 */
export function listRunHistory(
  runs: readonly AuditRunSnapshot[],
  events: readonly AuditEvent[],
  filter: RunHistoryQuery = {},
  contextWindow?: ContextWindowLookup,
): RunHistoryEntry[] {
  const evidence = evidenceByRun(events);
  const matched = runs.filter(
    (run) =>
      (filter.agentId === undefined || run.agentId === filter.agentId) &&
      (filter.status === undefined || (run.status ?? "completed") === filter.status),
  );
  const entries = matched.map((run) =>
    toEntry(run, evidence.get(run.id), contextWindow),
  );
  entries.sort((left, right) => {
    if (left.createdAt === right.createdAt) return 0;
    return left.createdAt < right.createdAt ? 1 : -1;
  });
  const limit = Math.min(filter.limit ?? DEFAULT_RUN_HISTORY_LIMIT, MAX_RUN_HISTORY_LIMIT);
  return entries.slice(0, limit);
}

/** One historical Run rollup, or null when the Run is not recorded. */
export function findRunHistory(
  runs: readonly AuditRunSnapshot[],
  events: readonly AuditEvent[],
  runId: string,
  contextWindow?: ContextWindowLookup,
): RunHistoryEntry | null {
  const run = runs.find((item) => item.id === runId);
  if (run === undefined) return null;
  return toEntry(run, evidenceByRun(events).get(runId), contextWindow);
}
