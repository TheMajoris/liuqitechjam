import type {
  HandoffLimits,
  SharedConversationTurn,
} from "./handoff.js";
import type { PlatformAgentInvokerContract } from "./platform-agent-invoker.js";
import type { SequenceDecision, SequenceStatus } from "./sequence.js";
import type {
  HandoffEnvelope,
  OrchestrationCompletionReason,
  OrchestrationErrorCode,
  OrchestrationMode,
  OrchestrationParticipant,
} from "./types.js";

/**
 * Application-owned projection of one orchestration execution turn.
 *
 * The graph engine may use this projection internally, but callers of the
 * orchestration service do not need to know which workflow framework executes
 * it.
 */
export interface OrchestrationExecutionTurn {
  participantId: string;
  agentId: string;
  runId: string;
  position: number;
  stepIndex?: number | undefined;
  output: string;
  outputTruncated: boolean;
}

/** Runtime-only Agent metadata made available to supervisor selection. */
export interface OrchestrationParticipantProfile extends OrchestrationParticipant {
  name?: string;
  description?: string;
}

/**
 * Bounded, repository-owned context supplied to a participant selector.
 *
 * Framework state and provider responses do not cross this boundary.  The
 * participant roster remains the application-owned source of truth; a
 * selector may only return a `SequenceDecision` that the Mastra step then
 * resolves against this exact roster.
 */
export interface OrchestrationSelectionInput {
  sessionId: string;
  originalPrompt: string;
  participants: readonly OrchestrationParticipant[];
  mode: OrchestrationMode;
  /** Runtime-only model selected from the session's supervisor Agent. */
  supervisorModel?: string | undefined;
  stepIndex: number;
  maxSteps: number;
  turns: readonly OrchestrationExecutionTurn[];
  /** Prior-cycle authoritative turns for a bounded shared-context view. */
  contextTurns?: readonly SharedConversationTurn[];
  participantProfiles?: readonly OrchestrationParticipantProfile[];
  /** Bounded newest turn projection for provider context construction. */
  recentTurns?: readonly OrchestrationExecutionTurn[];
  lastRunId: string | null;
  lastOutput: string | null;
  status: SequenceStatus;
}

/** Runtime controls for a selector/provider call. */
export interface OrchestrationSelectionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Awaitable application-owned participant routing policy. */
export type OrchestrationParticipantSelector = (
  input: OrchestrationSelectionInput,
  options?: OrchestrationSelectionOptions,
) => SequenceDecision | Promise<SequenceDecision>;

/** Statuses an orchestration engine may return before service finalization. */
export type OrchestrationExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped";

/** Serializable state returned by an orchestration engine. */
export interface OrchestrationExecutionResult {
  sessionId: string;
  originalPrompt: string;
  participants: OrchestrationParticipant[];
  mode?: OrchestrationMode | undefined;
  completionReason?: OrchestrationCompletionReason | null | undefined;
  stepIndex: number;
  maxSteps: number;
  lastRunId: string | null;
  lastOutput: string | null;
  turns: OrchestrationExecutionTurn[];
  status: OrchestrationExecutionStatus;
  errorCode: OrchestrationErrorCode | null;
}

/**
 * Serializable input shared by orchestration engine implementations.
 * Optional fields allow a future engine to resume from a bounded in-memory
 * execution projection without exposing framework state or runtime objects.
 */
export type OrchestrationExecutionInput = Pick<
  OrchestrationExecutionResult,
  "sessionId" | "originalPrompt" | "participants" | "mode" | "maxSteps"
> &
  Partial<
    Pick<
      OrchestrationExecutionResult,
      | "stepIndex"
      | "lastRunId"
      | "lastOutput"
      | "turns"
      | "status"
      | "errorCode"
      | "completionReason"
    >
  > & {
    /** Prior-cycle authoritative turns; never counted against this cycle. */
    contextTurns?: readonly SharedConversationTurn[];
  };

/** Lifecycle hooks owned by the platform service, not by a workflow engine. */
export interface OrchestrationExecutionHooks {
  /** Journal one validated supervisor decision before any child dispatch. */
  onSupervisorDecision?: (input: {
    action: "invoke" | "complete";
    participantId?: string;
    stepIndex: number;
    reason?: string | undefined;
  }) => void | Promise<void>;
  onBeforeDispatch?: (input: {
    participant: OrchestrationParticipant;
    prompt: string;
    stepIndex: number;
  }) => void | Promise<void>;
  onRunAccepted?: (input: {
    participant: OrchestrationParticipant;
    prompt: string;
    runId: string;
    stepIndex: number;
  }) => void | Promise<void>;
  onHandoffApplied?: (input: {
    participant: OrchestrationParticipant;
    envelope: HandoffEnvelope;
    stepIndex: number;
  }) => void | Promise<void>;
  onRunCompleted?: (input: {
    participant: OrchestrationParticipant;
    prompt: string;
    runId: string;
    output: string;
    envelope: HandoffEnvelope;
    turn: OrchestrationExecutionTurn;
    stepIndex: number;
  }) => void | Promise<void>;
  onParticipantFailed?: (input: {
    participant: OrchestrationParticipant;
    prompt: string;
    runId: string | null;
    stepIndex: number;
    error: unknown;
    errorCode: OrchestrationErrorCode;
  }) => void | Promise<void>;
}

/** Runtime dependencies and platform policies supplied for one execution. */
export interface OrchestrationExecutionOptions {
  /** Set when every turn must execute against a shared Project workspace. */
  projectId?: string | undefined;
  /** Stable parent ID used to correlate child Agent Runs and spans. */
  orchestrationId?: string | undefined;
  invoker: PlatformAgentInvokerContract;
  /** Optional selector; omitted callers retain deterministic selection. */
  selectNextParticipant?: OrchestrationParticipantSelector;
  /** Bounded supervisor provider call budget, supplied to the selector. */
  supervisorTimeoutMs?: number;
  /** Runtime-only Agent metadata; never serialized into workflow state. */
  participantProfiles?: readonly OrchestrationParticipantProfile[];
  perAgentTimeoutMs?: number;
  handoffLimits?: HandoffLimits;
  signal?: AbortSignal;
  hooks?: OrchestrationExecutionHooks;
}

/**
 * Stable application seam for workflow engines.
 *
 * Implementations may use LangGraph, Mastra, or another engine, but the
 * service only exchanges repository-owned execution data and hooks here.
 */
export interface Orchestrator {
  run(
    input: OrchestrationExecutionInput,
    options: OrchestrationExecutionOptions,
  ): Promise<OrchestrationExecutionResult>;
}
