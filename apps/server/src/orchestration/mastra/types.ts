import type {
  HandoffLimits,
  SharedConversationTurn,
} from "../handoff.js";
import type { PlatformAgentInvokerContract } from "../platform-agent-invoker.js";
import type {
  OrchestrationExecutionHooks,
  OrchestrationParticipantProfile,
  OrchestrationParticipantSelector,
  OrchestrationExecutionTurn,
} from "../orchestrator.js";
import type {
  OrchestrationCompletionReason,
  OrchestrationErrorCode,
  OrchestrationMode,
  OrchestrationParticipant,
} from "../types.js";

/** Full state carried from one Mastra loop iteration to the next. */
export interface MastraExecutionState {
  sessionId: string;
  originalPrompt: string;
  participants: OrchestrationParticipant[];
  mode: OrchestrationMode;
  completionReason: OrchestrationCompletionReason | null;
  stepIndex: number;
  maxSteps: number;
  lastRunId: string | null;
  lastOutput: string | null;
  /** Prior-cycle authoritative turns used only for bounded context projection. */
  contextTurns?: SharedConversationTurn[] | undefined;
  turns: OrchestrationExecutionTurn[];
  status: "running" | "completed" | "failed" | "stopped";
  errorCode: OrchestrationErrorCode | null;
}

/** Runtime dependencies captured by the single generic Mastra loop step. */
export interface MastraOrchestrationStepOptions {
  invoker: PlatformAgentInvokerContract;
  perAgentTimeoutMs: number;
  supervisorTimeoutMs?: number;
  participantProfiles?: readonly OrchestrationParticipantProfile[];
  handoffLimits?: HandoffLimits;
  signal?: AbortSignal;
  hooks?: OrchestrationExecutionHooks;
  /** Preserve the original child failure when Mastra wraps a step error. */
  onStepFailure?: (input: {
    error: unknown;
    errorCode: OrchestrationErrorCode;
  }) => void;
  /** Repository-owned, awaitable participant-selection boundary. */
  selectNextParticipant: OrchestrationParticipantSelector;
}
