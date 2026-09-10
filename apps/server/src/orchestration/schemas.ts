import { z } from "zod";
import type {
  CreateOrchestrationInput,
  ContinueOrchestrationInput,
  RecoverOrchestrationInput,
  RestoreSafetyInput,
  ResumeRecoveryInput,
  RetryOrchestrationInput,
  HandoffEnvelope,
  OrchestrationCompletionReason,
  OrchestrationContinuationPrompt,
  OrchestrationError,
  OrchestrationEvent,
  OrchestrationMode,
  OrchestrationParticipant,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationTurn,
  StartOrchestrationInput,
} from "./types.js";
import { ModelRefSchema } from "../models/schemas.js";

/** Maximum persisted/displayed length for a supervisor's public rationale. */
export const SUPERVISOR_REASON_MAX_CHARS = 240;

/**
 * Resource limits are deliberately independent of the Agent runtime. They
 * keep prompts, handoffs, event records, and execution state bounded while still
 * allowing a genuinely large roster (the UI is not limited to a demo pair).
 */
export const ORCHESTRATION_LIMITS = {
  maxNameLength: 80,
  maxPromptLength: 50_000,
  maxRoleLength: 80,
  maxParticipantIdLength: 128,
  /** Provider endpoint identifier recorded on a failed turn. */
  maxModelIdLength: 200,
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
  "orchestration_retried",
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
  "workspace_checkpoint_created",
  "workspace_checkpoint_failed",
  "workspace_checkpoint_restore_started",
  "workspace_checkpoint_restored",
  "workspace_checkpoint_restore_failed",
  "workspace_recovery_resumed",
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
  "WEB_TOOL_PERMISSION_DENIED",
  "MODEL_INFERENCE_LIMIT_EXCEEDED",
  "MODEL_RATE_LIMITED",
  "PROJECT_PERMISSION_DENIED",
  "CHECKPOINT_CAPTURE_FAILED",
  "CHECKPOINT_PUBLISH_FAILED",
  "CHECKPOINT_RUNTIME_UNSUPPORTED",
  "INTERNAL_ERROR",
] as const;

const orchestrationExecutionStatusValues = [
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
export const OrchestrationExecutionStatusSchema = z.enum(
  orchestrationExecutionStatusValues,
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

/**
 * A draft may be created before its first task or Agent has been chosen, but
 * only when it already belongs to a Workspace. Keep the ordinary roster
 * contract strict and use this shape only at the create/persisted-draft
 * boundary; graph state and runnable inputs must never contain an empty team.
 */
const OrchestrationDraftParticipantsSchema = z
  .array(OrchestrationParticipantSchema)
  .max(ORCHESTRATION_LIMITS.maxParticipants)
  .superRefine(duplicateRosterFields);

const orchestrationPromptSchema = z
  .string()
  .trim()
  .max(ORCHESTRATION_LIMITS.maxPromptLength);

/** Ordered roster contract shared by requests, persisted sessions, and execution state. */
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
    originalPrompt: orchestrationPromptSchema,
    participants: OrchestrationDraftParticipantsSchema,
    mode: OrchestrationModeSchema.optional(),
    /** Ask before acting; prompt policy only, so it is freely optional. */
    clarifyFirst: z.boolean().optional(),
    /** Opt-in shared Project scope; omitted Teams remain text-only. */
    projectId: idSchema.optional(),
    maxSteps: z.number().int().positive().max(ORCHESTRATION_LIMITS.maxSteps),
    perAgentTimeoutMs: z
      .number()
      .int()
      .min(ORCHESTRATION_LIMITS.minPerAgentTimeoutMs)
      .max(ORCHESTRATION_LIMITS.maxPerAgentTimeoutMs),
  }).superRefine((value, context) => {
    // Workspace conversations can be saved as an empty draft. Text-only
    // orchestration remains runnable-at-creation and therefore keeps its
    // original task/roster invariants.
    if (value.projectId) return;
    if (!value.originalPrompt) {
      context.addIssue({
        code: "custom",
        path: ["originalPrompt"],
        message: "A task is required for a text-only orchestration",
      });
    }
    if (value.participants.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "At least one participant is required for a text-only orchestration",
      });
    }
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

/**
 * A retry names one recorded execution step. The ceiling is the session step
 * limit because persisted step indexes are global and grow across cycles.
 */
export const RetryOrchestrationSchema: z.ZodType<RetryOrchestrationInput> = z
  .object({
    fromStepIndex: z
      .number()
      .int()
      .nonnegative()
      .max(ORCHESTRATION_LIMITS.maxTurnsPerSession),
  })
  .strict();

export const RetryOrchestrationInputSchema = RetryOrchestrationSchema;

/**
 * Source restore-and-resume request. Strict on purpose: a client may name a
 * checkpoint and its own idempotency key, and nothing else. Git revisions,
 * host paths, resume state, operation owners, and principals are rejected.
 */
export const RecoverOrchestrationSchema: z.ZodType<RecoverOrchestrationInput> = z
  .object({
    checkpointId: idSchema,
    requestId: idSchema,
    acknowledgeSourceRestore: z.literal(true),
  })
  .strict();

export const ResumeRecoverySchema: z.ZodType<ResumeRecoveryInput> = z
  .object({ requestId: idSchema })
  .strict();

export const RestoreSafetySchema: z.ZodType<RestoreSafetyInput> = z
  .object({
    requestId: idSchema,
    acknowledgeSourceRestore: z.literal(true),
  })
  .strict();

/** Params for recovery operation lookups; both IDs are opaque lookups only. */
export const RecoveryRouteParamsSchema = z.object({
  id: idSchema,
  operationId: idSchema,
});

/** Optional first prompt for atomically materializing and starting a draft. */
export const StartOrchestrationSchema: z.ZodType<StartOrchestrationInput> = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxPromptLength)
      .optional(),
  })
  .strict();

export const StartOrchestrationInputSchema = StartOrchestrationSchema;

/**
 * Settings a person may change on an existing Conversation.
 *
 * Only prompt-shaping policy lives here. Roster, task, mode, and limits stay
 * immutable after creation so a settled record still explains the run it
 * produced; `clarifyFirst` is safe to move because it grants nothing and only
 * applies from the next cycle onward.
 */
export const UpdateOrchestrationSchema = z
  .object({
    clarifyFirst: z.boolean(),
  })
  .strict();

export const OrchestrationSessionSchema: z.ZodType<OrchestrationSession> =
  z.object({
    id: idSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(ORCHESTRATION_LIMITS.maxNameLength),
    originalPrompt: orchestrationPromptSchema,
    participants: OrchestrationDraftParticipantsSchema,
    mode: OrchestrationModeSchema.optional(),
    /**
     * Legacy only. Supervisor routing is a server-wide model, never an Agent;
     * this field is still read back so records written before that change
     * remain loadable, and nothing consults it.
     */
    supervisorAgentId: idSchema.optional(),
    supervisorModelRef: ModelRefSchema.optional(),
    supervisorModelCatalogRevision: z.union([z.string().min(1), z.number().finite()]).optional(),
    /** Ask before acting; absent on records written before it existed. */
    clarifyFirst: z.boolean().optional(),
    /** Absent on Teams persisted before Projects existed. */
    projectId: idSchema.nullable().optional(),
    activeExecutionCycleId: z.string().min(1).nullable().optional(),
    acceptedContextCheckpointId: z.string().min(1).nullable().optional(),
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
  }).superRefine((value, context) => {
    const incomplete = !value.originalPrompt || value.participants.length === 0;
    const workspaceDraft = value.status === "draft" && Boolean(value.projectId);
    if (!incomplete || workspaceDraft) return;

    if (!value.originalPrompt) {
      context.addIssue({
        code: "custom",
        path: ["originalPrompt"],
        message: "A task is required before an orchestration can run",
      });
    }
    if (value.participants.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "At least one participant is required before an orchestration can run",
      });
    }
  });

export const OrchestrationTurnSchema: z.ZodType<OrchestrationTurn> = z.object({
  id: idSchema,
  sessionId: idSchema,
  participantId: participantIdSchema,
  agentId: idSchema,
  runId: idSchema,
  position: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().optional(),
  executionCycleId: z.string().min(1).optional(),
  workspaceCheckpointId: z.string().min(1).optional(),
  status: OrchestrationTurnStatusSchema,
  safeInputSummary: z
    .string()
    .max(ORCHESTRATION_LIMITS.maxSafeInputSummaryLength),
  safeOutput: safeOutputSchema.nullable(),
  outputTruncated: z.boolean(),
  errorCode: OrchestrationErrorCodeSchema.nullable(),
  modelId: z.string().min(1).max(ORCHESTRATION_LIMITS.maxModelIdLength).optional(),
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
    checkpointId: z.string().min(1).optional(),
    recoveryOperationId: z.string().min(1).optional(),
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
