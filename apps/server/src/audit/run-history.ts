import type { RunStatus } from "../types.js";
import { runContextWindow, type RunContextWindow } from "../telemetry/context-window.js";
import {
  summarizeRunTokens,
  type RunTokenTotals,
} from "../telemetry/telemetry-usage.js";
import type { AuditEvent } from "./audit-types.js";
import type {
  AuditConversationKind,
  AuditConversationSnapshot,
  AuditRunSnapshot,
} from "./audit-timeline.js";
import { emptyToolUsage, summarizeRunTools, type RunToolUsage } from "./run-tools.js";

export const DEFAULT_RUN_HISTORY_LIMIT = 50;
export const MAX_RUN_HISTORY_LIMIT = 200;
export const MAX_RUN_TITLE_LENGTH = 160;

/**
 * The conversation a Run belongs to.
 *
 * Present on both kinds of thread — a private conversation with one Agent and
 * a Team session with several — because the question "what did this
 * conversation cost" is the same question either way.
 */
export interface RunConversation {
  id: string;
  kind: AuditConversationKind;
  /**
   * The thread's own name where it has one, and the Run's task where it does
   * not. Never an ID: a reader who has to match hex strings by eye cannot see
   * which conversation spent what.
   */
  title: string;
  /** True when the title came from the Run's task rather than the thread. */
  derived: boolean;
}

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
  /**
   * The thread this Run belongs to, so several Runs of one conversation can be
   * read together. Null for a Run that belongs to no thread.
   */
  conversation: RunConversation | null;
  /** What the Run called, named — not just how many events it produced. */
  tools: RunToolUsage;
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
  /** Team session this Run's events were correlated to, when there was one. */
  orchestrationId: string | undefined;
  tools: RunToolUsage;
}

/**
 * The task a Team participant was actually given.
 *
 * A participant's prompt opens with the handoff preamble and safety contract,
 * so its first line is the same sentence for every participant of every Team
 * Run. Titling by that line makes an entire list read identically; the real
 * task is the element the preamble wraps.
 */
const ORCHESTRATION_TASK = /<orchestration_task>\s*([\s\S]*?)\s*<\/orchestration_task>/;

/** Reverses the escaping the handoff prompt applies to the embedded task. */
function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    // Last: an escaped ampersand must not re-introduce an entity above.
    .replaceAll("&amp;", "&");
}

function runTitle(prompt: string | undefined): string {
  const text = prompt ?? "";
  const task = ORCHESTRATION_TASK.exec(text)?.[1];
  const source = task === undefined ? text : unescapeXml(task);
  const firstLine = source.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "Run";
  return firstLine.length > MAX_RUN_TITLE_LENGTH
    ? firstLine.slice(0, MAX_RUN_TITLE_LENGTH - 1) + "…"
    : firstLine;
}

/** Conversation records by kind-scoped key; IDs are unique per collection only. */
function conversationIndex(
  conversations: readonly AuditConversationSnapshot[],
): Map<string, AuditConversationSnapshot> {
  return new Map(
    conversations.map((conversation) => [
      conversation.kind + ":" + conversation.id,
      conversation,
    ]),
  );
}

/**
 * The thread a Run belongs to, named.
 *
 * A Run is either a Team turn or a private turn, never both — Team turns are
 * kept out of private conversations at acceptance — so the two sources are
 * checked in order rather than merged. When the thread record itself is gone,
 * the Run is still grouped under its ID and labelled by its own task: losing
 * the name must not silently scatter a conversation's Runs.
 */
function resolveConversation(
  run: AuditRunSnapshot,
  evidence: RunEvidence | undefined,
  index: Map<string, AuditConversationSnapshot>,
  fallbackTitle: string,
): RunConversation | null {
  const kind: AuditConversationKind | null =
    evidence?.orchestrationId !== undefined
      ? "team"
      : run.conversationId !== undefined
        ? "direct"
        : null;
  if (kind === null) return null;
  const id = (kind === "team" ? evidence?.orchestrationId : run.conversationId) ?? "";
  if (id.length === 0) return null;
  const title = index.get(kind + ":" + id)?.title.trim() ?? "";
  return title.length > 0
    ? { id, kind, title, derived: false }
    : { id, kind, title: fallbackTitle, derived: true };
}

function elapsed(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Group audit evidence by the Run it belongs to.
 *
 * Tool reconciliation needs a Run's events together rather than one at a time,
 * so the events are collected here and summarized once per Run.
 */
function evidenceByRun(events: readonly AuditEvent[]): Map<string, RunEvidence> {
  const eventsByRun = new Map<string, AuditEvent[]>();
  const byRun = new Map<string, RunEvidence>();
  for (const event of events) {
    if (event.runId === undefined) continue;
    const collected = eventsByRun.get(event.runId);
    if (collected === undefined) eventsByRun.set(event.runId, [event]);
    else collected.push(event);
    const existing = byRun.get(event.runId);
    if (existing === undefined) {
      byRun.set(event.runId, {
        eventCount: 1,
        errorCount: event.status === "failure" ? 1 : 0,
        traceId: event.traceId,
        orchestrationId: event.orchestrationId,
        tools: emptyToolUsage(),
      });
      continue;
    }
    existing.eventCount += 1;
    if (event.status === "failure") existing.errorCount += 1;
    existing.orchestrationId ??= event.orchestrationId;
  }
  for (const [runId, evidence] of byRun) {
    evidence.tools = summarizeRunTools(eventsByRun.get(runId) ?? []);
  }
  return byRun;
}

function toEntry(
  run: AuditRunSnapshot,
  evidence: RunEvidence | undefined,
  contextWindow: ContextWindowLookup | undefined,
  conversations: Map<string, AuditConversationSnapshot>,
): RunHistoryEntry {
  const status = run.status ?? "completed";
  const startedAt = run.startedAt ?? null;
  const completedAt = run.completedAt ?? null;
  const title = runTitle(run.prompt);
  return {
    runId: run.id,
    agentId: run.agentId,
    // A Run recorded before name snapshots existed still identifies its Agent
    // by ID; it must never be presented as an unknown Agent.
    agentName: run.agentName ?? "Agent " + run.agentId.slice(0, 8),
    agentDeleted: run.agentDeletedAt !== undefined,
    agentDeletedAt: run.agentDeletedAt ?? null,
    status,
    title,
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
    conversation: resolveConversation(run, evidence, conversations, title),
    tools: evidence?.tools ?? emptyToolUsage(),
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
  conversations: readonly AuditConversationSnapshot[] = [],
): RunHistoryEntry[] {
  const evidence = evidenceByRun(events);
  const index = conversationIndex(conversations);
  const matched = runs.filter(
    (run) =>
      (filter.agentId === undefined || run.agentId === filter.agentId) &&
      (filter.status === undefined || (run.status ?? "completed") === filter.status),
  );
  const entries = matched.map((run) =>
    toEntry(run, evidence.get(run.id), contextWindow, index),
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
  conversations: readonly AuditConversationSnapshot[] = [],
): RunHistoryEntry | null {
  const run = runs.find((item) => item.id === runId);
  if (run === undefined) return null;
  return toEntry(
    run,
    evidenceByRun(events).get(runId),
    contextWindow,
    conversationIndex(conversations),
  );
}
