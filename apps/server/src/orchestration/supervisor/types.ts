import type { HandoffEnvelope } from "../handoff.js";
import type { OrchestrationParticipant } from "../types.js";

/**
 * The only routing values a supervisor provider may return.
 *
 * A participant occurrence ID is deliberately used instead of an Agent ID:
 * one platform Agent may appear more than once in a configured roster.
 */
export type SupervisorRoutingDecision =
  | {
      kind: "invoke";
      participantId: string;
      /** Optional short, user-safe rationale; never private chain-of-thought. */
      reason?: string;
    }
  | {
      kind: "complete";
      /** Optional short, user-safe rationale; never private chain-of-thought. */
      reason?: string;
    };

/** Agent metadata attached to one configured occurrence when available. */
export interface SupervisorParticipantProfile extends OrchestrationParticipant {
  name?: string;
  description?: string;
}

/** Bounded conversation evidence supplied to a supervisor policy. */
export interface SupervisorTurnContext {
  participantId: string;
  agentId: string;
  /** Stable child execution identity when the source turn has one. */
  runId?: string | undefined;
  position: number;
  stepIndex?: number;
  output: string;
  outputTruncated?: boolean;
}

/** Bounded, repository-owned context supplied to a supervisor policy. */
export interface SupervisorSelectionContext {
  sessionId: string;
  originalPrompt: string;
  participants: readonly OrchestrationParticipant[];
  /** Profile metadata is separate from routing participants so it cannot
   * replace the authoritative occurrence roster. */
  participantProfiles?: readonly SupervisorParticipantProfile[];
  /** Zero for the initial run; positive values identify follow-up cycles. */
  cycleIndex?: number | undefined;
  stepIndex: number;
  maxSteps: number;
  /** Replies produced in the current cycle; prior history is not counted. */
  currentCycleTurnCount?: number | undefined;
  /** Number of bounded prior-cycle turns included as context. */
  priorCycleTurnCount?: number | undefined;
  /** A corrective call must return an eligible current-cycle dispatch. */
  requireCurrentCycleDispatch?: boolean | undefined;
  /**
   * The Agent identity that handled the previous current-cycle turn. When
   * multiple distinct Agents are configured, the next dispatch must not use
   * this identity consecutively.
   */
  avoidImmediateRepeatAgentId?: string | undefined;
  /**
   * Set only for the bounded corrective call after an illegal repeat. The
   * provider must choose a different Agent or declare the task complete.
   */
  requireDifferentAgentOrComplete?: boolean | undefined;
  previousHandoff: HandoffEnvelope | null;
  /** Most recent bounded turn history, in chronological order. */
  recentTurns?: readonly SupervisorTurnContext[];
}

/** Maximum number of provider HTTP calls allowed by one routing selection. */
export const DEFAULT_SUPERVISOR_MAX_HTTP_CALLS = 4;

/** Mutable, runtime-only budget shared by one selection and its corrections. */
export interface SupervisorRequestBudget {
  /** Absolute wall-clock deadline for all provider calls in the selection. */
  deadlineAt: number;
  /** Number of provider HTTP calls already consumed by this selection. */
  calls: number;
  /** Optional lower cap used by deterministic tests or a tighter caller policy. */
  maxCalls?: number;
}

export function createSupervisorRequestBudget(
  deadlineAt: number,
): SupervisorRequestBudget {
  return { deadlineAt, calls: 0 };
}

export interface SupervisorProviderOptions {
  signal?: AbortSignal;
  /** Optional per-call override used when a shared budget is not supplied. */
  timeoutMs?: number;
  /** Runtime-only supervisor model captured when the cycle was accepted. */
  model?: string;
  /** Shared absolute deadline and HTTP-call budget for one routing selection. */
  requestBudget?: SupervisorRequestBudget;
}

/** Provider boundary; model/provider implementations stay behind this seam. */
export interface SupervisorProvider {
  decide(
    context: SupervisorSelectionContext,
    options?: SupervisorProviderOptions,
  ): SupervisorRoutingDecision | Promise<SupervisorRoutingDecision>;
}

/** A provider decision after exact validation against the configured roster. */
export type SupervisorSelection =
  | {
      kind: "invoke";
      participant: OrchestrationParticipant;
      stepIndex: number;
      reason?: string;
    }
  | {
      kind: "complete";
      completionReason: "supervisor_completed";
      stepIndex: number;
      reason?: string;
    };
