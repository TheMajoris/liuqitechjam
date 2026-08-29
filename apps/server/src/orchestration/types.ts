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
  | "orchestration_completed";

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
  | "INTERNAL_ERROR";

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
  /** Omitted on legacy records; only natural roster completion sets it. */
  completionReason?: OrchestrationCompletionReason | null | undefined;
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
  status: OrchestrationTurnStatus;
  safeInputSummary: string;
  safeOutput: string | null;
  outputTruncated: boolean;
  errorCode: OrchestrationErrorCode | null;
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
  createdAt: string;
}

/** Body accepted by the Team conversation follow-up route. */
export interface ContinueOrchestrationInput {
  prompt: string;
}

export interface OrchestrationSessionDetail {
  session: OrchestrationSession;
  turns: OrchestrationTurn[];
  events: OrchestrationEvent[];
  /** Optional for compatibility with pre-continuation detail consumers. */
  continuationPrompts?: OrchestrationContinuationPrompt[] | undefined;
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

/** Serializable turn projection kept in LangGraph state. */
export interface OrchestrationGraphTurn {
  participantId: string;
  agentId: string;
  runId: string;
  position: number;
  output: string;
  outputTruncated: boolean;
}

/** Serializable state fields owned by the deterministic LangGraph. */
export interface OrchestrationGraphState {
  sessionId: string;
  originalPrompt: string;
  participants: OrchestrationParticipant[];
  /** Omitted only by legacy callers; graph execution defaults to sequential. */
  mode?: OrchestrationMode | undefined;
  /** Null except for natural sequential roster completion. */
  completionReason?: OrchestrationCompletionReason | null | undefined;
  stepIndex: number;
  maxSteps: number;
  lastRunId: string | null;
  lastOutput: string | null;
  turns: OrchestrationGraphTurn[];
  status: "running" | "completed" | "failed" | "stopped";
  errorCode: OrchestrationErrorCode | null;
}

export interface CreateOrchestrationInput {
  name: string;
  originalPrompt: string;
  participants: OrchestrationParticipant[];
  /** Opt-in shared Project scope; omitted Teams stay text-only. */
  projectId?: string | undefined;
  /** Defaults to sequential when omitted for backward-compatible clients. */
  mode?: OrchestrationMode | undefined;
  maxSteps: number;
  perAgentTimeoutMs: number;
}

/** Params shared by the detail, start, and stop orchestration routes. */
export interface OrchestrationRouteParams {
  id: string;
}
