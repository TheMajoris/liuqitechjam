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
  stepIndex: number;
  maxSteps: number;
  previousHandoff: HandoffEnvelope | null;
  /** Most recent bounded turn history, in chronological order. */
  recentTurns?: readonly SupervisorTurnContext[];
}

export interface SupervisorProviderOptions {
  signal?: AbortSignal;
  /** Optional per-call override; providers still enforce their own default. */
  timeoutMs?: number;
  /** Runtime-only model selected from the session's supervisor Agent. */
  model?: string;
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
