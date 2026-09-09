import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { Storage } from "../store.js";
import type { AgentRun, Database } from "../types.js";
import { createHandoffEnvelope, redactSensitiveText } from "./handoff.js";
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
  checkpointId?: string;
  recoveryOperationId?: string;
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
  if (fields.checkpointId !== undefined) event.checkpointId = fields.checkpointId;
  if (fields.recoveryOperationId !== undefined) {
    event.recoveryOperationId = fields.recoveryOperationId;
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

interface ReconciledTurn {
  status: "completed" | "failed" | "cancelled";
  safeOutput: string | null;
  outputTruncated: boolean;
  errorCode: OrchestrationErrorCode | null;
  safeSummary: string;
}

function runErrorCode(
  run: AgentRun | undefined,
  fallback: OrchestrationErrorCode,
): OrchestrationErrorCode {
  if (
    run?.errorCode === "WEB_TOOL_PERMISSION_DENIED" ||
    run?.errorCode === "MODEL_INFERENCE_LIMIT_EXCEEDED"
  ) {
    return run.errorCode;
  }
  return fallback;
}

function recoveryFailureSummary(prefix: string, run?: AgentRun): string {
  const detail = run?.error ? safeErrorMessage(run.error) : "";
  return detail.length > 0 ? `${prefix}: ${detail}` : prefix;
}

function reconcileTurn(turn: OrchestrationTurn, run?: AgentRun): ReconciledTurn {
  if (run?.status === "completed") {
    if (typeof run.output === "string" && run.output.trim().length > 0) {
      // Reuse the same application-owned handoff seam used before a result
      // crosses to another participant. This keeps recovered output bounded
      // and redacted without trusting the framework or invoking an Agent.
      const envelope = createHandoffEnvelope({
        sourceParticipantId: turn.participantId,
        sourceAgentId: turn.agentId,
        sourceRunId: turn.runId,
        content: run.output,
      });
      return {
        status: "completed",
        safeOutput: boundedSafeText(
          envelope.content,
          ORCHESTRATION_LIMITS.maxSafeOutputLength,
          "[OUTPUT TRUNCATED]",
        ),
        outputTruncated: envelope.truncated,
        errorCode: null,
        safeSummary: "Recovered completed participant Run after server restart",
      };
    }

    return {
      status: "failed",
      safeOutput: null,
      outputTruncated: false,
      errorCode: "INVALID_OUTPUT",
      safeSummary: recoveryFailureSummary(
        "Completed participant Run had no usable output during recovery",
        run,
      ),
    };
  }

  if (run?.status === "failed") {
    return {
      status: "failed",
      safeOutput: null,
      outputTruncated: false,
      errorCode: runErrorCode(run, "RUN_FAILED"),
      safeSummary: recoveryFailureSummary(
        "Recovered failed participant Run after server restart",
        run,
      ),
    };
  }

  if (run?.status === "cancelled") {
    return {
      status: "cancelled",
      safeOutput: null,
      outputTruncated: false,
      errorCode: runErrorCode(run, "RUN_CANCELLED"),
      safeSummary: recoveryFailureSummary(
        "Recovered cancelled participant Run after server restart",
        run,
      ),
    };
  }

  if (run) {
    return {
      status: "cancelled",
      safeOutput: null,
      outputTruncated: false,
      errorCode: "ORCHESTRATION_INTERRUPTED",
      safeSummary:
        "Participant Run was still nonterminal after startup reconciliation; turn was interrupted",
    };
  }

  return {
    status: "failed",
    safeOutput: null,
    outputTruncated: false,
    errorCode: "RUN_NOT_FOUND",
    safeSummary:
      "No committed participant Run was found during startup reconciliation; turn was interrupted",
  };
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
        if (statusIsActive(session.status)) {
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

        // Only dispatched turns are nonterminal. All facts used here are
        // already committed in the store; recovery never routes or invokes a
        // participant and never guesses a participant from the roster.
        const runsById = new Map(database.runs.map((run) => [run.id, run]));
        for (const turn of database.orchestrationTurns) {
          if (turn.sessionId !== session.id || turn.status !== "dispatched") {
            continue;
          }
          const reconciled = reconcileTurn(turn, runsById.get(turn.runId));
          turn.status = reconciled.status;
          turn.safeOutput = reconciled.safeOutput;
          turn.outputTruncated = reconciled.outputTruncated;
          turn.errorCode = reconciled.errorCode;
          turn.completedAt = interruptedAt;
          session.updatedAt = interruptedAt;
          appendEvent(
            database,
            session,
            reconciled.status === "completed"
              ? "run_completed"
              : reconciled.status === "cancelled"
                ? "child_run_cancelled"
                : "participant_failed",
            {
              participantId: turn.participantId,
              agentId: turn.agentId,
              runId: turn.runId,
              safeSummary: reconciled.safeSummary,
              ...(reconciled.errorCode === null
                ? {}
                : { errorCode: reconciled.errorCode }),
            },
          );
        }
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

  /**
   * The highest persisted execution step, or null when nothing ran yet.
   *
   * Retry and continuation both need this to keep new turns above every
   * recorded one: persisted step indexes are global and never reused.
   */
  highestStepIndex(sessionId: string): number | null {
    let highest: number | null = null;
    for (const turn of this.store.snapshot().orchestrationTurns) {
      if (turn.sessionId !== sessionId || turn.stepIndex === undefined) continue;
      if (highest === null || turn.stepIndex > highest) highest = turn.stepIndex;
    }
    return highest;
  }

  /** Global step index of a recorded turn, looked up by its child Run. */
  globalStepIndexByRunId(sessionId: string, runId: string): number | undefined {
    const turn = this.store
      .snapshot()
      .orchestrationTurns.find((item) => item.sessionId === sessionId && item.runId === runId);
    return turn?.stepIndex;
  }

  /** The recorded turn holding one global execution step, if it exists. */
  turnAtStep(sessionId: string, stepIndex: number): OrchestrationTurn | null {
    const match = this.store
      .snapshot()
      .orchestrationTurns.filter(
        (turn) => turn.sessionId === sessionId && turn.stepIndex === stepIndex,
      )
      .sort(compareTurns)
      .at(-1);
    return match ? cloneTurn(match) : null;
  }

  /**
   * Return only completed safe turns from prior cycles, bounded for context.
   *
   * `before` truncates the projection to the work that preceded one step, so
   * a retried turn is offered the same history it saw the first time rather
   * than the outputs of the turns that followed it.
   */
  contextTurns(
    sessionId: string,
    maxSteps: number,
    before?: number,
  ): OrchestrationExecutionTurn[] {
    return this.store
      .snapshot()
      .orchestrationTurns.filter(
        (turn) =>
          turn.sessionId === sessionId &&
          turn.status === "completed" &&
          turn.safeOutput !== null &&
          // A legacy turn has no step index and cannot be placed relative to
          // the retry point, so it is excluded rather than guessed at.
          (before === undefined ||
            (turn.stepIndex !== undefined && turn.stepIndex < before)),
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
