import type { ModelRef } from "../models/types.js";

/**
 * Lifecycle states persisted for an orchestration session.
 *
 * `draft` is the only state that may be edited before a run is accepted.
 * `queued`, `running`, and `stopping` are active states. The remaining
 * states are terminal from the point of view of the first implementation;
 * `interrupted` records work that was active when the server restarted.
 */
export type OrchestrationStatus =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "interrupted";

export type OrchestrationActiveStatus =
  | "queued"
  | "running"
  | "stopping";

export type OrchestrationTerminalStatus =
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

/** Statuses a persisted child-Agent turn can take. */
export type OrchestrationTurnStatus =
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Execution modes supported by the orchestration engine. */
export type OrchestrationMode = "sequential" | "round_robin" | "supervisor";

/** Why an orchestration reached its completed terminal state. */
export type OrchestrationCompletionReason =
  | "roster_exhausted"
  | "supervisor_completed";

/**
 * Stable event names used by the persisted orchestration journal.
 * Event payloads are intentionally safe summaries, never raw runtime data.
 */
export type OrchestrationEventType =
  | "orchestration_created"
  | "orchestration_started"
  | "orchestration_continued"
  | "orchestration_retried"
  | "participant_dispatched"
  | "supervisor_decision"
  | "run_completed"
  | "handoff_applied"
  | "participant_failed"
  | "stop_requested"
  | "child_run_cancelled"
  | "orchestration_stopped"
  | "orchestration_failed"
  | "orchestration_interrupted"
  | "orchestration_completed"
  | "workspace_checkpoint_created"
  | "workspace_checkpoint_failed"
  | "workspace_checkpoint_restore_started"
  | "workspace_checkpoint_restored"
  | "workspace_checkpoint_restore_failed"
  | "workspace_recovery_resumed";

/**
 * Error codes that callers may use when explaining a visible lifecycle
 * failure. Keeping these stable makes event consumers independent of error
 * message text while still leaving room for future codes at another seam.
 */
export type OrchestrationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_LIFECYCLE"
  | "SESSION_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_UNAVAILABLE"
  | "AGENT_BUSY"
  | "AGENT_STOPPED"
  | "RUN_NOT_FOUND"
  | "RUN_FAILED"
  | "RUN_CANCELLED"
  | "RUN_TIMED_OUT"
  | "INVALID_OUTPUT"
  | "SUPERVISOR_INVALID_RESPONSE"
  | "SUPERVISOR_INVALID_SELECTION"
  | "SUPERVISOR_TIMED_OUT"
  | "SUPERVISOR_FAILED"
  | "SUPERVISOR_UNAVAILABLE"
  | "MAX_STEPS_EXCEEDED"
  | "ORCHESTRATION_STOPPED"
  | "ORCHESTRATION_INTERRUPTED"
  | "WEB_TOOL_PERMISSION_DENIED"
  | "MODEL_INFERENCE_LIMIT_EXCEEDED"
  | "MODEL_RATE_LIMITED"
  | "PROJECT_PERMISSION_DENIED"
  | "CHECKPOINT_CAPTURE_FAILED"
  | "CHECKPOINT_PUBLISH_FAILED"
  | "CHECKPOINT_RUNTIME_UNSUPPORTED"
  | "INTERNAL_ERROR";

/**
 * Which rule turned a run into its error code, for the audit trail only.
 *
 * An error code names the *shape* of a failure and several distinct rules
 * roll up into one: `SUPERVISOR_INVALID_SELECTION` is reported whether the
 * supervisor named an Agent that is not on the roster, repeated the Agent
 * that had just spoken even after the corrective call, or tried to end a
 * follow-up without dispatching anyone. Those need different fixes, and
 * reading the code alone could not tell them apart.
 *
 * Deliberately a closed enum of engine-authored tokens: audit metadata keeps
 * identifiers and enum-like evidence, never model text, provider bodies, or
 * free-form explanations. Never shown on a product surface.
 */
export type OrchestrationFailureRule =
  | "supervisor_selected_unconfigured_occurrence"
  | "supervisor_repeated_agent_after_correction"
  | "supervisor_completed_without_cycle_dispatch"
  | "supervisor_invalid_execution_bounds"
  | "supervisor_duplicate_participant_occurrence"
  | "selector_returned_unconfigured_participant"
  | "selector_returned_invalid_terminal_decision"
  | "selector_returned_invalid_decision"
  | "immediate_repeat_at_dispatch";

export interface OrchestrationError {
  code: OrchestrationErrorCode;
  message: string;
}

/** A named occurrence of an existing platform Agent in an ordered roster. */
export interface OrchestrationParticipant {
  /** Stable occurrence ID; distinct occurrences may point to one agentId. */
  id: string;
  /** Existing platform Agent selected for this occurrence. */
  agentId: string;
  /** User-editable label describing this occurrence's responsibility. */
  role: string;
  /** Zero-based order in which this occurrence is invoked. */
  position: number;
}

export interface OrchestrationSession {
  id: string;
  name: string;
  originalPrompt: string;
  /**
   * Shared Project this Team collaborates on. Absent on Teams created before
   * Projects existed, and on Teams that deliberately work text-only; those
   * keep running against each Agent's private workspace.
   */
  projectId?: string | null | undefined;
  participants: OrchestrationParticipant[];
  /** Omitted only on legacy persisted sessions; those run sequentially. */
  mode?: OrchestrationMode | undefined;
  /**
   * Legacy only. Supervisor routing uses the server-wide supervisor model, not
   * an Agent; this survives on records written before that change.
   */
  supervisorAgentId?: string | undefined;
  /** Primary model assignment captured when the current cycle was accepted. */
  supervisorModelRef?: ModelRef | undefined;
  /** Optional live-catalog revision captured with the supervisor model. */
  supervisorModelCatalogRevision?: string | number | undefined;
  /** Omitted on legacy records; only natural roster completion sets it. */
  completionReason?: OrchestrationCompletionReason | null | undefined;
  /**
   * Ask before acting. When set, every participant prompt carries a rule to
   * resolve ambiguity with the person before doing the work. It is a prompt
   * policy only: it grants nothing and changes no routing, so it may be
   * toggled on a settled Conversation and takes effect on the next cycle.
   */
  clarifyFirst?: boolean | undefined;
  /** The checkpoint-enabled cycle currently accepted for this session. */
  activeExecutionCycleId?: string | null | undefined;
  /**
   * Branch head used for later continuations after a recovery: the newest
   * ready checkpoint on the accepted lineage, never an abandoned branch.
   */
  acceptedContextCheckpointId?: string | null | undefined;
  status: OrchestrationStatus;
  currentParticipantId: string | null;
  currentRunId: string | null;
  stepIndex: number;
  maxSteps: number;
  perAgentTimeoutMs: number;
  errorCode: OrchestrationErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OrchestrationTurn {
  id: string;
  sessionId: string;
  participantId: string;
  agentId: string;
  runId: string;
  position: number;
  /** Zero-based execution step; omitted only on legacy persisted turns. */
  stepIndex?: number | undefined;
  /** Checkpoint-enabled cycle that dispatched this turn. */
  executionCycleId?: string | undefined;
  /** Ready source checkpoint captured after this successful turn. */
  workspaceCheckpointId?: string | undefined;
  status: OrchestrationTurnStatus;
  safeInputSummary: string;
  safeOutput: string | null;
  outputTruncated: boolean;
  errorCode: OrchestrationErrorCode | null;
  /**
   * The model this turn ran on, recorded only when the turn failed.
   *
   * A provider-side model failure is not diagnosable from the Agent's name
   * alone: several Agents commonly share one endpoint, and the endpoint that
   * failed may already have been reassigned by the time anyone reads the
   * transcript. Recorded at failure time so the reply can name the exact model
   * rather than the model the Agent happens to point at now.
   */
  modelId?: string | undefined;
  createdAt: string;
  completedAt: string | null;
}

/**
 * A user-authored follow-up that starts another execution cycle in the same
 * visible Team conversation. The initial task remains on the session;
 * continuation prompts are append-only records so the complete user intent
 * history survives each fresh orchestration run.
 */
export interface OrchestrationContinuationPrompt {
  id: string;
  sessionId: string;
  /** One-based cycle number; the initial session task is cycle zero. */
  cycleIndex: number;
  prompt: string;
  createdAt: string;
}

export interface OrchestrationEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: OrchestrationEventType;
  participantId?: string | undefined;
  agentId?: string | undefined;
  runId?: string | undefined;
  /** A compact lifecycle/turn status snapshot at event creation time. */
  status: string;
  durationMs?: number | undefined;
  safeSummary?: string | undefined;
  errorCode?: OrchestrationErrorCode | undefined;
  completionReason?: OrchestrationCompletionReason | undefined;
  /** Opaque checkpoint ID for checkpoint/restore events. */
  checkpointId?: string | undefined;
  /** Opaque recovery operation ID for restore events. */
  recoveryOperationId?: string | undefined;
  createdAt: string;
}

/** Strict body accepted by the source restore-and-resume route. */
export interface RecoverOrchestrationInput {
  checkpointId: string;
  /** Generated once per confirmed action; retained across transport retries. */
  requestId: string;
  /** Mirrors the concrete UI confirmation; not authorization. */
  acknowledgeSourceRestore: true;
}

/** Strict body accepted by the explicit recovery resume route. */
export interface ResumeRecoveryInput {
  requestId: string;
}

/** Strict body accepted by the safety-restore escape hatch. */
export interface RestoreSafetyInput {
  requestId: string;
  acknowledgeSourceRestore: true;
}

/** Body accepted by the Team conversation follow-up route. */
export interface ContinueOrchestrationInput {
  prompt: string;
}

/** Optional first prompt accepted when starting an idle Conversation draft. */
export interface StartOrchestrationInput {
  prompt?: string | undefined;
}

/**
 * Body accepted by the retry route.
 *
 * `fromStepIndex` is a persisted global execution step, so it identifies one
 * recorded turn rather than a roster position: the same participant may hold
 * several steps in round-robin and supervisor runs.
 */
export interface RetryOrchestrationInput {
  fromStepIndex: number;
}

export interface OrchestrationSessionDetail {
  session: OrchestrationSession;
  turns: OrchestrationTurn[];
  events: OrchestrationEvent[];
  /** Optional for compatibility with pre-continuation detail consumers. */
  continuationPrompts?: OrchestrationContinuationPrompt[] | undefined;
  /** Safe checkpoint views for this session only; absent when disabled. */
  checkpoints?:
    | import("../projects/workspace-checkpoint-types.js").WorkspaceCheckpointView[]
    | undefined;
  /** The newest recovery operation for this session, if any. */
  recovery?:
    | import("../projects/workspace-checkpoint-types.js").WorkspaceRecoveryView
    | null
    | undefined;
}

/**
 * The only data passed between adjacent graph turns. Agent output remains
 * untrusted, bounded data and never becomes routing or authorization input.
 */
export interface HandoffEnvelope {
  sourceParticipantId: string;
  sourceAgentId: string;
  sourceRunId: string;
  content: string;
  truncated: boolean;
}

export interface CreateOrchestrationInput {
  name: string;
  originalPrompt: string;
  participants: OrchestrationParticipant[];
  /** Opt-in shared Project scope; omitted Teams stay text-only. */
  projectId?: string | undefined;
  /** Defaults to sequential when omitted for backward-compatible clients. */
  mode?: OrchestrationMode | undefined;
  /** Ask before acting; see OrchestrationSession.clarifyFirst. */
  clarifyFirst?: boolean | undefined;
  maxSteps: number;
  perAgentTimeoutMs: number;
}

/** Params shared by the detail, start, and stop orchestration routes. */
export interface OrchestrationRouteParams {
  id: string;
}
