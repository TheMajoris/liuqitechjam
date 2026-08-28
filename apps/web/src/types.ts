export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export type OrchestrationStatus =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "interrupted";

export type OrchestrationActiveStatus = "queued" | "running" | "stopping";

export type OrchestrationTerminalStatus =
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export type OrchestrationTurnStatus =
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type OrchestrationMode = "supervisor" | "sequential" | "round_robin";

export type OrchestrationCompletionReason =
  | "roster_exhausted"
  | "supervisor_completed";

export type OrchestrationEventType =
  | "orchestration_created"
  | "orchestration_started"
  | "orchestration_continued"
  | "supervisor_decision"
  | "participant_dispatched"
  | "run_completed"
  | "handoff_applied"
  | "participant_failed"
  | "stop_requested"
  | "child_run_cancelled"
  | "orchestration_stopped"
  | "orchestration_failed"
  | "orchestration_interrupted"
  | "orchestration_completed";

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
  | "MAX_STEPS_EXCEEDED"
  | "ORCHESTRATION_STOPPED"
  | "ORCHESTRATION_INTERRUPTED"
  | "SUPERVISOR_INVALID_RESPONSE"
  | "SUPERVISOR_INVALID_SELECTION"
  | "SUPERVISOR_FAILED"
  | "SUPERVISOR_TIMED_OUT"
  | "SUPERVISOR_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface OrchestrationParticipant {
  id: string;
  agentId: string;
  role: string;
  position: number;
}

export interface OrchestrationSession {
  id: string;
  name: string;
  originalPrompt: string;
  participants: OrchestrationParticipant[];
  /** Omitted only by legacy persisted sessions; those run sequentially. */
  mode?: OrchestrationMode;
  completionReason?: OrchestrationCompletionReason | null;
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
  /** Present on newer runs; legacy detail responses use array order. */
  stepIndex?: number;
  position: number;
  status: OrchestrationTurnStatus;
  safeInputSummary: string;
  safeOutput: string | null;
  outputTruncated: boolean;
  errorCode: OrchestrationErrorCode | null;
  createdAt: string;
  completedAt: string | null;
}

export interface OrchestrationEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: OrchestrationEventType;
  participantId?: string;
  agentId?: string;
  runId?: string;
  status: string;
  durationMs?: number;
  safeSummary?: string;
  errorCode?: OrchestrationErrorCode;
  completionReason?: OrchestrationCompletionReason;
  createdAt: string;
}

export interface OrchestrationSessionDetail {
  session: OrchestrationSession;
  turns: OrchestrationTurn[];
  events: OrchestrationEvent[];
  continuationPrompts: OrchestrationContinuationPrompt[];
}

export interface OrchestrationContinuationPrompt {
  id: string;
  sessionId: string;
  cycleIndex: number;
  prompt: string;
  createdAt: string;
}

export interface CreateOrchestrationInput {
  name: string;
  originalPrompt: string;
  participants: OrchestrationParticipant[];
  mode: OrchestrationMode;
  maxSteps: number;
  perAgentTimeoutMs: number;
}

export interface ContinueOrchestrationInput {
  prompt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
