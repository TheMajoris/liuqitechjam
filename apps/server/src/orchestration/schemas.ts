import { z } from "zod";
import type {
  CreateOrchestrationInput,
  ContinueOrchestrationInput,
  HandoffEnvelope,
  OrchestrationCompletionReason,
  OrchestrationContinuationPrompt,
  OrchestrationError,
  OrchestrationEvent,
  OrchestrationGraphState,
  OrchestrationGraphTurn,
  OrchestrationMode,
  OrchestrationParticipant,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "./types.js";

/** Maximum persisted/displayed length for a supervisor's public rationale. */
export const SUPERVISOR_REASON_MAX_CHARS = 240;

/**
 * Resource limits are deliberately independent of the Agent runtime. They
 * keep prompts, handoffs, event records, and graph state bounded while still
 * allowing a genuinely large roster (the UI is not limited to a demo pair).
 */
export const ORCHESTRATION_LIMITS = {
  maxNameLength: 80,
  maxPromptLength: 50_000,
  maxRoleLength: 80,
  maxParticipantIdLength: 128,
  maxParticipants: 100,
  maxSteps: 1_000,
  minPerAgentTimeoutMs: 1_000,
  maxPerAgentTimeoutMs: 3_600_000,
  maxSafeInputSummaryLength: 4_000,
  maxSafeOutputLength: 50_000,
  maxSafeSummaryLength: 2_000,
  maxErrorMessageLength: 2_000,
  maxEventStatusLength: 40,
  maxEventsPerSession: 10_000,
  /** Cumulative Team history may span many fresh execution cycles. */
  maxTurnsPerSession: 10_000,
  maxContinuationPromptsPerSession: 1_000,
} as const;

const orchestrationStatusValues = [
  "draft",
  "queued",
  "running",
  "completed",
  "failed",
  "stopping",
  "stopped",
  "interrupted",
] as const;

const orchestrationTurnStatusValues = [
  "dispatched",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;

const orchestrationEventTypeValues = [
  "orchestration_created",
  "orchestration_started",
  "orchestration_continued",
  "participant_dispatched",
  "supervisor_decision",
  "run_completed",
  "handoff_applied",
  "participant_failed",
  "stop_requested",
  "child_run_cancelled",
  "orchestration_stopped",
  "orchestration_failed",
  "orchestration_interrupted",
  "orchestration_completed",
] as const;

const orchestrationErrorCodeValues = [
  "INVALID_INPUT",
  "INVALID_LIFECYCLE",
  "SESSION_NOT_FOUND",
  "AGENT_NOT_FOUND",
  "AGENT_UNAVAILABLE",
  "AGENT_BUSY",
  "AGENT_STOPPED",
  "RUN_NOT_FOUND",
  "RUN_FAILED",
  "RUN_CANCELLED",
  "RUN_TIMED_OUT",
  "INVALID_OUTPUT",
  "SUPERVISOR_INVALID_RESPONSE",
  "SUPERVISOR_INVALID_SELECTION",
  "SUPERVISOR_TIMED_OUT",
  "SUPERVISOR_FAILED",
  "SUPERVISOR_UNAVAILABLE",
  "MAX_STEPS_EXCEEDED",
  "ORCHESTRATION_STOPPED",
  "ORCHESTRATION_INTERRUPTED",
  "INTERNAL_ERROR",
] as const;

const orchestrationGraphStatusValues = [
  "running",
  "completed",
  "failed",
  "stopped",
] as const;

const orchestrationModeValues = [
  "sequential",
  "round_robin",
  "supervisor",
] as const;
const orchestrationCompletionReasonValues = [
  "roster_exhausted",
  "supervisor_completed",
] as const;

export const OrchestrationStatusSchema = z.enum(orchestrationStatusValues);
export const OrchestrationTurnStatusSchema = z.enum(
  orchestrationTurnStatusValues,
);
export const OrchestrationEventTypeSchema = z.enum(
  orchestrationEventTypeValues,
);
export const OrchestrationErrorCodeSchema = z.enum(
  orchestrationErrorCodeValues,
);
export const OrchestrationGraphStatusSchema = z.enum(
  orchestrationGraphStatusValues,
);
export const OrchestrationModeSchema = z.enum(orchestrationModeValues);
export const OrchestrationCompletionReasonSchema: z.ZodType<
  OrchestrationCompletionReason
> = z.enum(orchestrationCompletionReasonValues);

const idSchema = z.string().uuid();
const participantIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORCHESTRATION_LIMITS.maxParticipantIdLength);
const timestampSchema = z.string().datetime({ offset: true });
const safeOutputSchema = z
  .string()
  .max(ORCHESTRATION_LIMITS.maxSafeOutputLength);

export const OrchestrationParticipantSchema: z.ZodType<OrchestrationParticipant> =
  z.object({
    id: participantIdSchema,
    agentId: idSchema,
    role: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxRoleLength),
    position: z.number().int().nonnegative(),
  });

const duplicateRosterFields = (
  participants: OrchestrationParticipant[],
  context: z.RefinementCtx,
): void => {
  const participantIds = new Map<string, number>();
  const positions = new Map<number, number>();

  participants.forEach((participant, index) => {
    const previousIdIndex = participantIds.get(participant.id);
    if (previousIdIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `Participant id duplicates entry ${previousIdIndex + 1}`,
      });
    } else {
      participantIds.set(participant.id, index);
    }

    const previousPositionIndex = positions.get(participant.position);
    if (previousPositionIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: [index, "position"],
        message: `Participant position duplicates entry ${previousPositionIndex + 1}`,
      });
    } else {
      positions.set(participant.position, index);
    }
  });
};

/** Ordered roster contract shared by requests, persisted sessions, and graph state. */
export const OrchestrationParticipantsSchema = z
  .array(OrchestrationParticipantSchema)
  .min(1, "At least one participant is required")
  .max(ORCHESTRATION_LIMITS.maxParticipants)
  .superRefine(duplicateRosterFields);

export const CreateOrchestrationSchema: z.ZodType<CreateOrchestrationInput> =
  z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxNameLength),
    originalPrompt: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxPromptLength),
    participants: OrchestrationParticipantsSchema,
    mode: OrchestrationModeSchema.optional(),
    maxSteps: z.number().int().positive().max(ORCHESTRATION_LIMITS.maxSteps),
    perAgentTimeoutMs: z
      .number()
      .int()
      .min(ORCHESTRATION_LIMITS.minPerAgentTimeoutMs)
      .max(ORCHESTRATION_LIMITS.maxPerAgentTimeoutMs),
  });

/** Backwards-compatible descriptive alias for callers naming the body schema. */
export const CreateOrchestrationInputSchema = CreateOrchestrationSchema;

/** Validation for a user follow-up that starts another Team cycle. */
export const ContinueOrchestrationSchema: z.ZodType<ContinueOrchestrationInput> =
  z.object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxPromptLength),
  });

export const ContinueOrchestrationInputSchema = ContinueOrchestrationSchema;

export const OrchestrationSessionSchema: z.ZodType<OrchestrationSession> =
  z.object({
    id: idSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxNameLength),
    originalPrompt: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxPromptLength),
    participants: OrchestrationParticipantsSchema,
    mode: OrchestrationModeSchema.optional(),
    completionReason: OrchestrationCompletionReasonSchema.nullable().optional(),
    status: OrchestrationStatusSchema,
    currentParticipantId: participantIdSchema.nullable(),
    currentRunId: idSchema.nullable(),
    stepIndex: z.number().int().nonnegative(),
    maxSteps: z.number().int().positive().max(ORCHESTRATION_LIMITS.maxSteps),
    perAgentTimeoutMs: z
      .number()
      .int()
      .min(ORCHESTRATION_LIMITS.minPerAgentTimeoutMs)
      .max(ORCHESTRATION_LIMITS.maxPerAgentTimeoutMs),
    errorCode: OrchestrationErrorCodeSchema.nullable(),
    errorMessage: z
      .string()
      .max(ORCHESTRATION_LIMITS.maxErrorMessageLength)
      .nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
  });

export const OrchestrationTurnSchema: z.ZodType<OrchestrationTurn> = z.object({
  id: idSchema,
  sessionId: idSchema,
  participantId: participantIdSchema,
  agentId: idSchema,
  runId: idSchema,
  position: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().optional(),
  status: OrchestrationTurnStatusSchema,
  safeInputSummary: z
    .string()
    .max(ORCHESTRATION_LIMITS.maxSafeInputSummaryLength),
  safeOutput: safeOutputSchema.nullable(),
  outputTruncated: z.boolean(),
  errorCode: OrchestrationErrorCodeSchema.nullable(),
  createdAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});

/** Persisted user follow-ups that start a fresh cycle in one Team session. */
export const OrchestrationContinuationPromptSchema: z.ZodType<OrchestrationContinuationPrompt> =
  z.object({
    id: idSchema,
    sessionId: idSchema,
    cycleIndex: z.number().int().positive(),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxPromptLength),
    createdAt: timestampSchema,
  });

export const OrchestrationEventSchema: z.ZodType<OrchestrationEvent> = z.object(
  {
    id: idSchema,
    sessionId: idSchema,
    sequence: z.number().int().nonnegative(),
    type: OrchestrationEventTypeSchema,
    participantId: participantIdSchema.optional(),
    agentId: idSchema.optional(),
    runId: idSchema.optional(),
    status: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxEventStatusLength),
    durationMs: z.number().int().nonnegative().optional(),
    safeSummary: z
      .string()
      .max(ORCHESTRATION_LIMITS.maxSafeSummaryLength)
      .optional(),
    errorCode: OrchestrationErrorCodeSchema.optional(),
    completionReason: OrchestrationCompletionReasonSchema.optional(),
    createdAt: timestampSchema,
  },
);

export const HandoffEnvelopeSchema: z.ZodType<HandoffEnvelope> = z.object({
  sourceParticipantId: participantIdSchema,
  sourceAgentId: idSchema,
  sourceRunId: idSchema,
  content: safeOutputSchema,
  truncated: z.boolean(),
});

export const OrchestrationGraphTurnSchema: z.ZodType<OrchestrationGraphTurn> =
  z.object({
    participantId: participantIdSchema,
    agentId: idSchema,
    runId: idSchema,
    position: z.number().int().nonnegative(),
    output: safeOutputSchema,
    outputTruncated: z.boolean(),
  });

export const OrchestrationGraphStateSchema: z.ZodType<OrchestrationGraphState> =
  z.object({
    sessionId: idSchema,
    originalPrompt: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxPromptLength),
    participants: OrchestrationParticipantsSchema,
    mode: OrchestrationModeSchema.optional(),
    completionReason: OrchestrationCompletionReasonSchema.nullable().optional(),
    stepIndex: z.number().int().nonnegative(),
    maxSteps: z.number().int().positive().max(ORCHESTRATION_LIMITS.maxSteps),
    lastRunId: idSchema.nullable(),
    lastOutput: safeOutputSchema.nullable(),
    turns: z
      .array(OrchestrationGraphTurnSchema)
      .max(ORCHESTRATION_LIMITS.maxSteps),
    status: OrchestrationGraphStatusSchema,
    errorCode: OrchestrationErrorCodeSchema.nullable(),
  });

export const OrchestrationErrorSchema: z.ZodType<OrchestrationError> = z.object(
  {
    code: OrchestrationErrorCodeSchema,
    message: z.string().trim().min(1).max(ORCHESTRATION_LIMITS.maxErrorMessageLength),
  },
);

export const OrchestrationSessionDetailSchema: z.ZodType<OrchestrationSessionDetail> =
  z.object({
    session: OrchestrationSessionSchema,
    turns: z
      .array(OrchestrationTurnSchema)
      .max(ORCHESTRATION_LIMITS.maxTurnsPerSession),
    events: z
      .array(OrchestrationEventSchema)
      .max(ORCHESTRATION_LIMITS.maxEventsPerSession),
    continuationPrompts: z
      .array(OrchestrationContinuationPromptSchema)
      .max(ORCHESTRATION_LIMITS.maxContinuationPromptsPerSession)
      .optional(),
  });

/** Params shared by GET detail, POST start, and POST stop routes. */
export const OrchestrationRouteParamsSchema = z.object({
  id: idSchema,
});

/** Descriptive alias for code that calls the route key an orchestration ID. */
export const OrchestrationIdParamsSchema = OrchestrationRouteParamsSchema;
