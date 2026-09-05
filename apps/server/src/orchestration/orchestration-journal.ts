import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { Storage } from "../store.js";
import type { Database } from "../types.js";
import { redactSensitiveText } from "./handoff.js";
import { ORCHESTRATION_LIMITS } from "./schemas.js";
import type { OrchestrationExecutionTurn } from "./orchestrator.js";
import type {
  OrchestrationCompletionReason,
  OrchestrationContinuationPrompt,
  OrchestrationEvent,
  OrchestrationEventType,
  OrchestrationErrorCode,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "./types.js";

/** Fields that may be recorded on a lifecycle event. */
export interface OrchestrationEventFields {
  participantId?: string;
  agentId?: string;
  runId?: string;
  durationMs?: number;
  safeSummary?: string;
  errorCode?: OrchestrationErrorCode;
  completionReason?: OrchestrationCompletionReason;
}

const terminalStatuses = new Set<OrchestrationSession["status"]>([
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);

const activeStatuses = new Set<OrchestrationSession["status"]>([
  "queued",
  "running",
  "stopping",
]);

/** Keep historical context within the workflow state/schema budget. */
const MAX_CONTEXT_TURNS = 8;

export const now = (): string => new Date().toISOString();

export function boundedSafeText(
  value: unknown,
  maxLength: number,
  marker: string,
): string {
  const safe = redactSensitiveText(asText(value));
  if (safe.length <= maxLength) return safe;
  if (maxLength <= marker.length) return marker.slice(0, maxLength);
  return safe.slice(0, maxLength - marker.length - 1).trimEnd() + "\n" + marker;
}

export function safeErrorMessage(error: unknown): string {
  return boundedSafeText(
    error instanceof Error ? error.message : error,
    ORCHESTRATION_LIMITS.maxErrorMessageLength,
    "[ERROR TRUNCATED]",
  );
}

export function safeSummary(value: unknown): string {
  return boundedSafeText(
    value,
    ORCHESTRATION_LIMITS.maxSafeSummaryLength,
    "[SUMMARY TRUNCATED]",
  );
}

export function safeInputSummary(value: unknown): string {
  return boundedSafeText(
    value,
    ORCHESTRATION_LIMITS.maxSafeInputSummaryLength,
    "[INPUT TRUNCATED]",
  );
}

export function statusIsTerminal(status: OrchestrationSession["status"]): boolean {
  return terminalStatuses.has(status);
}

export function statusIsActive(status: OrchestrationSession["status"]): boolean {
  return activeStatuses.has(status);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function eventStatus(status: OrchestrationSession["status"]): string {
  return boundedSafeText(status, ORCHESTRATION_LIMITS.maxEventStatusLength, "[STATUS]");
}

export function safeParticipant<T extends { id: string; role: string }>(
  participant: T,
): T {
  return {
    ...participant,
    // Occurrence IDs are routing keys, not free-form text. Preserve their
    // opaque value so distinct IDs cannot collide after redaction/truncation.
    id: participant.id.trim(),
    role: boundedSafeText(
      participant.role.trim(),
      ORCHESTRATION_LIMITS.maxRoleLength,
      "[ROLE TRUNCATED]",
    ),
  };
}

function maxEventSequence(
  events: readonly OrchestrationEvent[],
  sessionId: string,
): number {
  let maximum = -1;
  for (const event of events) {
    if (event.sessionId === sessionId && event.sequence > maximum) {
      maximum = event.sequence;
    }
  }
  return maximum;
}

/** Append one bounded, safe lifecycle record to an in-progress mutation. */
export function appendEvent(
  database: Database,
  session: OrchestrationSession,
  type: OrchestrationEventType,
  fields: OrchestrationEventFields = {},
): OrchestrationEvent {
  const existingCount = database.orchestrationEvents.filter(
    (event) => event.sessionId === session.id,
  ).length;
  if (existingCount >= ORCHESTRATION_LIMITS.maxEventsPerSession) {
    throw new Error("Orchestration event limit reached");
  }

  const event: OrchestrationEvent = {
    id: randomUUID(),
    sessionId: session.id,
    sequence: maxEventSequence(database.orchestrationEvents, session.id) + 1,
    type,
    status: eventStatus(session.status),
    createdAt: now(),
  };
  if (fields.participantId !== undefined) event.participantId = fields.participantId;
  if (fields.agentId !== undefined) event.agentId = fields.agentId;
  if (fields.runId !== undefined) event.runId = fields.runId;
  if (fields.durationMs !== undefined) event.durationMs = fields.durationMs;
  if (fields.safeSummary !== undefined) event.safeSummary = safeSummary(fields.safeSummary);
  if (fields.errorCode !== undefined) event.errorCode = fields.errorCode;
  if (fields.completionReason !== undefined) {
    event.completionReason = fields.completionReason;
  }
  database.orchestrationEvents.push(event);
  return event;
}

export function cloneSession(session: OrchestrationSession): OrchestrationSession {
  const copy = structuredClone(session);
  copy.name = boundedSafeText(copy.name, ORCHESTRATION_LIMITS.maxNameLength, "[NAME TRUNCATED]");
  copy.originalPrompt = boundedSafeText(
    copy.originalPrompt,
    ORCHESTRATION_LIMITS.maxPromptLength,
    "[TASK TRUNCATED]",
  );
  copy.participants = copy.participants.map((participant) => safeParticipant(participant));
  if (copy.errorMessage !== null) {
    copy.errorMessage = safeErrorMessage(copy.errorMessage);
  }
  return copy;
}

export function cloneTurn(turn: OrchestrationTurn): OrchestrationTurn {
  const copy = structuredClone(turn);
  copy.safeInputSummary = safeInputSummary(copy.safeInputSummary);
  if (copy.safeOutput !== null) {
    copy.safeOutput = boundedSafeText(
      copy.safeOutput,
      ORCHESTRATION_LIMITS.maxSafeOutputLength,
      "[OUTPUT TRUNCATED]",
    );
  }
  return copy;
}

export function cloneContinuationPrompt(
  prompt: OrchestrationContinuationPrompt,
): OrchestrationContinuationPrompt {
  const copy = structuredClone(prompt);
  copy.prompt = boundedSafeText(
    copy.prompt,
    ORCHESTRATION_LIMITS.maxPromptLength,
    "[PROMPT TRUNCATED]",
  );
  return copy;
}

export function compareTurns(
  left: OrchestrationTurn,
  right: OrchestrationTurn,
): number {
  // New turns carry the globally monotonic execution step. Legacy turns do
  // not, so retain the old deterministic timestamp/position fallback.
  if (left.stepIndex !== undefined && right.stepIndex !== undefined) {
    const byStep = left.stepIndex - right.stepIndex;
    if (byStep !== 0) return byStep;
  }
  if (left.stepIndex !== undefined && right.stepIndex === undefined) return -1;
  if (left.stepIndex === undefined && right.stepIndex !== undefined) return 1;
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.position - right.position ||
    left.id.localeCompare(right.id)
  );
}

export function cloneEvent(event: OrchestrationEvent): OrchestrationEvent {
  const copy = structuredClone(event);
  if (copy.safeSummary !== undefined) copy.safeSummary = safeSummary(copy.safeSummary);
  return copy;
}

/**
 * Repository-owned orchestration journal. It centralizes safe projections,
 * event invariants, recovery, and bounded historical context while lifecycle
 * decisions remain in OrchestrationService.
 */
export class OrchestrationJournal {
  constructor(private readonly store: Storage) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.mutate((database) => {
      const interruptedAt = now();
      for (const session of database.orchestrations) {
        if (!statusIsActive(session.status)) continue;
        session.status = "interrupted";
        session.currentParticipantId = null;
        session.currentRunId = null;
        session.completionReason = null;
        session.errorCode = "ORCHESTRATION_INTERRUPTED";
        session.errorMessage =
          "Orchestration was interrupted because the server restarted";
        session.completedAt = interruptedAt;
        session.updatedAt = interruptedAt;
        appendEvent(database, session, "orchestration_interrupted", {
          errorCode: "ORCHESTRATION_INTERRUPTED",
          safeSummary: session.errorMessage,
        });
      }
    });
  }

  snapshot(): Database {
    return this.store.snapshot();
  }

  async getSessionDetail(id: string): Promise<OrchestrationSessionDetail> {
    const database = this.store.snapshot();
    const session = database.orchestrations.find((item) => item.id === id);
    if (!session) throw new HttpError(404, "Orchestration not found");
    return {
      session: cloneSession(session),
      turns: database.orchestrationTurns
        .filter((turn) => turn.sessionId === id)
        .sort(compareTurns)
        .map(cloneTurn),
      events: database.orchestrationEvents
        .filter((event) => event.sessionId === id)
        .sort((left, right) => left.sequence - right.sequence)
        .map(cloneEvent),
      continuationPrompts: database.orchestrationContinuationPrompts
        .filter((prompt) => prompt.sessionId === id)
        .sort(
          (left, right) =>
            left.cycleIndex - right.cycleIndex ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        )
        .map(cloneContinuationPrompt),
    };
  }

  /** Return only completed safe turns from prior cycles, bounded for context. */
  contextTurns(sessionId: string, maxSteps: number): OrchestrationExecutionTurn[] {
    return this.store
      .snapshot()
      .orchestrationTurns.filter(
        (turn) =>
          turn.sessionId === sessionId &&
          turn.status === "completed" &&
          turn.safeOutput !== null,
      )
      .sort(compareTurns)
      .slice(-Math.min(MAX_CONTEXT_TURNS, Math.max(0, maxSteps)))
      .map((turn) => {
        const safe = cloneTurn(turn);
        return {
          participantId: safe.participantId,
          agentId: safe.agentId,
          runId: safe.runId,
          position: safe.position,
          ...(safe.stepIndex === undefined ? {} : { stepIndex: safe.stepIndex }),
          output: safe.safeOutput ?? "",
          outputTruncated: safe.outputTruncated,
        };
      });
  }
}
