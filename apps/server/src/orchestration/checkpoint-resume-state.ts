import { z } from "zod";
import type { SharedConversationTurn } from "./handoff.js";
import type {
  OrchestrationExecutionInput,
  OrchestrationExecutionTurn,
} from "./orchestrator.js";
import {
  ORCHESTRATION_LIMITS,
  OrchestrationModeSchema,
  OrchestrationParticipantsSchema,
} from "./schemas.js";
import type { OrchestrationMode, OrchestrationParticipant } from "./types.js";

/**
 * The exact bounded engine continuation saved beside a workspace checkpoint.
 *
 * A checkpoint is only recoverable when the files on disk and the point in the
 * orchestration they belong to are restored together. This record is the
 * logical half: the source cycle's immutable settings, the accepted prefix of
 * the current cycle, and the cursor the engine must resume from. It carries
 * no Mastra object, AbortSignal, credential, or Codex thread.
 */
export interface CheckpointResumeState {
  version: 1;
  /** The execution cycle this state was captured in. */
  sourceCycleId: string;
  mode: OrchestrationMode;
  /** The actual cycle prompt (initial task or the follow-up that started it). */
  originalPrompt: string;
  /** User intent cycle number; zero is the initial task. Not an execution ID. */
  cycleIndex: number;
  participants: OrchestrationParticipant[];
  clarifyFirst: boolean;
  perAgentTimeoutMs: number;
  maxSteps: number;
  /** Engine-local cursor after the selected turn; the baseline stores the initial cursor. */
  nextEngineStepIndex: number;
  lastRunId: string | null;
  /** Bounded exactly like a handoff output. */
  lastOutput: string | null;
  /** The current cycle's accepted prefix, with engine-local step indexes. */
  turns: OrchestrationExecutionTurn[];
  /** Frozen bounded prior lineage supplied to the engine as context. */
  contextTurns: SharedConversationTurn[];
  parentCheckpointId: string | null;
}

const executionTurnSchema: z.ZodType<OrchestrationExecutionTurn> = z.object({
  participantId: z.string().min(1),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  position: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().optional(),
  output: z.string().max(ORCHESTRATION_LIMITS.maxSafeOutputLength),
  outputTruncated: z.boolean(),
});

const contextTurnSchema: z.ZodType<SharedConversationTurn> = z.object({
  participantId: z.string().min(1),
  agentId: z.string().min(1),
  runId: z.string().min(1).optional(),
  position: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().optional(),
  output: z.string().max(ORCHESTRATION_LIMITS.maxSafeOutputLength),
  outputTruncated: z.boolean().optional(),
});

export const CheckpointResumeStateSchema: z.ZodType<CheckpointResumeState> = z
  .object({
    version: z.literal(1),
    sourceCycleId: z.string().min(1),
    mode: OrchestrationModeSchema,
    originalPrompt: z.string().max(ORCHESTRATION_LIMITS.maxPromptLength),
    cycleIndex: z.number().int().nonnegative(),
    participants: OrchestrationParticipantsSchema,
    clarifyFirst: z.boolean(),
    perAgentTimeoutMs: z
      .number()
      .int()
      .min(ORCHESTRATION_LIMITS.minPerAgentTimeoutMs)
      .max(ORCHESTRATION_LIMITS.maxPerAgentTimeoutMs),
    maxSteps: z.number().int().positive().max(ORCHESTRATION_LIMITS.maxSteps),
    nextEngineStepIndex: z.number().int().nonnegative(),
    lastRunId: z.string().nullable(),
    lastOutput: z.string().max(ORCHESTRATION_LIMITS.maxSafeOutputLength).nullable(),
    turns: z.array(executionTurnSchema).max(ORCHESTRATION_LIMITS.maxSteps),
    contextTurns: z.array(contextTurnSchema).max(ORCHESTRATION_LIMITS.maxSteps),
    parentCheckpointId: z.string().nullable(),
  })
  .superRefine((value, context) => {
    if (value.turns.length > value.maxSteps) {
      context.addIssue({
        code: "custom",
        path: ["turns"],
        message: "Accepted turns exceed the cycle step budget",
      });
    }
    if (value.nextEngineStepIndex > value.maxSteps) {
      context.addIssue({
        code: "custom",
        path: ["nextEngineStepIndex"],
        message: "Engine cursor exceeds the cycle step budget",
      });
    }
  });

/** Immutable settings of one accepted execution cycle. */
export interface CycleSettings {
  sourceCycleId: string;
  mode: OrchestrationMode;
  originalPrompt: string;
  cycleIndex: number;
  participants: readonly OrchestrationParticipant[];
  clarifyFirst: boolean;
  perAgentTimeoutMs: number;
  maxSteps: number;
}

/** The engine state the cycle starts from, before any participant runs. */
export function buildInitialResumeState(
  settings: CycleSettings,
  input: {
    startEngineStepIndex: number;
    contextTurns: readonly SharedConversationTurn[];
    parentCheckpointId: string | null;
    /** A recovered cycle starts from the target's accepted prefix. */
    turns?: readonly OrchestrationExecutionTurn[];
    lastRunId?: string | null;
    lastOutput?: string | null;
  },
): CheckpointResumeState {
  return {
    version: 1,
    sourceCycleId: settings.sourceCycleId,
    mode: settings.mode,
    originalPrompt: settings.originalPrompt,
    cycleIndex: settings.cycleIndex,
    participants: settings.participants.map((participant) => ({ ...participant })),
    clarifyFirst: settings.clarifyFirst,
    perAgentTimeoutMs: settings.perAgentTimeoutMs,
    maxSteps: settings.maxSteps,
    nextEngineStepIndex: input.startEngineStepIndex,
    lastRunId: input.lastRunId ?? null,
    lastOutput: input.lastOutput ?? null,
    turns: (input.turns ?? []).map((turn) => ({ ...turn })),
    contextTurns: input.contextTurns.map((turn) => ({ ...turn })),
    parentCheckpointId: input.parentCheckpointId,
  };
}

/** The state after one more accepted turn: the exact next engine input. */
export function buildCheckpointResumeState(
  base: CheckpointResumeState,
  completed: {
    nextEngineStepIndex: number;
    lastRunId: string;
    lastOutput: string;
    turns: readonly OrchestrationExecutionTurn[];
    parentCheckpointId: string | null;
  },
): CheckpointResumeState {
  return {
    ...base,
    participants: base.participants.map((participant) => ({ ...participant })),
    contextTurns: base.contextTurns.map((turn) => ({ ...turn })),
    nextEngineStepIndex: completed.nextEngineStepIndex,
    lastRunId: completed.lastRunId,
    lastOutput: completed.lastOutput,
    turns: completed.turns.map((turn) => ({ ...turn })),
    parentCheckpointId: completed.parentCheckpointId,
  };
}

export type ResumeBudgetCheck =
  | { ok: true }
  | { ok: false; reason: "no_remaining_steps" | "roster_exhausted" };

/**
 * Whether resuming this state can dispatch at least one more participant.
 * Sequential mode is exhausted at the roster end; every mode is exhausted at
 * its step budget. Supervisor mode may still choose to complete immediately,
 * which is a valid resumed decision, so only the hard budget is checked.
 */
export function checkResumeBudget(state: CheckpointResumeState): ResumeBudgetCheck {
  if (state.nextEngineStepIndex >= state.maxSteps) {
    return { ok: false, reason: "no_remaining_steps" };
  }
  if (
    state.mode === "sequential" &&
    state.nextEngineStepIndex >= state.participants.length
  ) {
    return { ok: false, reason: "roster_exhausted" };
  }
  return { ok: true };
}

/** The roster a recovery resumes must be the roster it recorded. */
export function rosterMatches(
  recorded: readonly OrchestrationParticipant[],
  current: readonly OrchestrationParticipant[],
): boolean {
  if (recorded.length !== current.length) return false;
  const byId = new Map(current.map((participant) => [participant.id, participant]));
  return recorded.every((participant) => {
    const candidate = byId.get(participant.id);
    return (
      candidate !== undefined &&
      candidate.agentId === participant.agentId &&
      candidate.position === participant.position
    );
  });
}

/** The engine input that resumes exactly at the recorded boundary. */
export function buildRecoveryExecutionInput(
  sessionId: string,
  state: CheckpointResumeState,
): OrchestrationExecutionInput {
  return {
    sessionId,
    originalPrompt: state.originalPrompt,
    participants: state.participants.map((participant) => ({ ...participant })),
    mode: state.mode,
    cycleIndex: state.cycleIndex,
    maxSteps: state.maxSteps,
    stepIndex: state.nextEngineStepIndex,
    lastRunId: state.lastRunId,
    lastOutput: state.lastOutput,
    turns: state.turns.map((turn) => ({ ...turn })),
    contextTurns: state.contextTurns.map((turn) => ({ ...turn })),
    status: "running",
    errorCode: null,
  };
}

/** Keep historical context within the workflow state budget. */
export const MAX_ACCEPTED_CONTEXT_TURNS = 8;

/**
 * The bounded shared context a later cycle receives from an accepted branch
 * head: the head's frozen prior lineage followed by its own accepted turns.
 * Abandoned turns are never present, because they are not in the lineage.
 */
export function contextFromAcceptedCheckpoint(
  state: CheckpointResumeState,
  globalStepIndexByRunId: (runId: string) => number | undefined,
  limit = MAX_ACCEPTED_CONTEXT_TURNS,
): SharedConversationTurn[] {
  const own: SharedConversationTurn[] = state.turns.map((turn) => {
    const stepIndex = globalStepIndexByRunId(turn.runId);
    return {
      participantId: turn.participantId,
      agentId: turn.agentId,
      runId: turn.runId,
      position: turn.position,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      output: turn.output,
      outputTruncated: turn.outputTruncated,
    };
  });
  const combined = [...state.contextTurns, ...own];
  return combined.slice(-Math.max(0, limit)).map((turn) => ({ ...turn }));
}
