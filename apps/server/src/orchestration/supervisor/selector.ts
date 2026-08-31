import { SupervisorError, createAbortError } from "./errors.js";
import { parseSupervisorRoutingDecision } from "./schemas.js";
import {
  sanitizeSupervisorReason,
  sanitizeSupervisorSelectionContext,
} from "./context.js";
import type {
  OrchestrationParticipantSelector,
  OrchestrationSelectionInput,
  OrchestrationSelectionOptions,
} from "../orchestrator.js";
import type { SequenceDecision } from "../sequence.js";
import type { HandoffEnvelope } from "../handoff.js";
import { ORCHESTRATION_LIMITS } from "../schemas.js";
import type {
  SupervisorProvider,
  SupervisorProviderOptions,
  SupervisorRoutingDecision,
  SupervisorSelection,
  SupervisorSelectionContext,
} from "./types.js";

function resolveSelection(
  context: SupervisorSelectionContext,
  decision: SupervisorRoutingDecision,
): SupervisorSelection {
  if (
    !Number.isInteger(context.stepIndex) ||
    context.stepIndex < 0 ||
    !Number.isInteger(context.maxSteps) ||
    context.maxSteps <= 0 ||
    !Array.isArray(context.participants) ||
    context.participants.length === 0
  ) {
    throw new SupervisorError(
      "SUPERVISOR_INVALID_CONTEXT",
      "Supervisor context contains invalid execution bounds",
    );
  }
  const ids = new Set<string>();
  const positions = new Set<number>();
  for (const participant of context.participants) {
    if (
      typeof participant.id !== "string" ||
      participant.id.trim().length === 0 ||
      participant.id.length > ORCHESTRATION_LIMITS.maxParticipantIdLength ||
      !Number.isInteger(participant.position) ||
      participant.position < 0 ||
      ids.has(participant.id) ||
      positions.has(participant.position)
    ) {
      throw new SupervisorError(
        "SUPERVISOR_INVALID_CONTEXT",
        "Supervisor context contains duplicate or invalid participant occurrences",
      );
    }
    ids.add(participant.id);
    positions.add(participant.position);
  }
  if (decision.kind === "complete") {
    const reason = sanitizeSupervisorReason(decision.reason);
    return {
      kind: "complete",
      completionReason: "supervisor_completed",
      stepIndex: context.stepIndex,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  const participant = context.participants.find(
    (candidate) => candidate.id === decision.participantId,
  );
  if (!participant) {
    throw new SupervisorError(
      "SUPERVISOR_INVALID_ROUTE",
      "Supervisor selected an occurrence that is not configured",
    );
  }
  const reason = sanitizeSupervisorReason(decision.reason);
  return {
    kind: "invoke",
    participant: { ...participant },
    stepIndex: context.stepIndex,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Repository-owned selector that turns an untrusted provider decision into an
 * authoritative configured occurrence or explicit completion.
 */
export class SupervisorSelector {
  constructor(private readonly provider: SupervisorProvider) {}

  async selectNextParticipant(
    context: SupervisorSelectionContext,
    options: SupervisorProviderOptions = {},
  ): Promise<SupervisorSelection> {
    if (options.signal?.aborted) throw createAbortError();
    const safeContext = sanitizeSupervisorSelectionContext(context);
    const rawDecision = await this.provider.decide(safeContext, options);
    if (options.signal?.aborted) throw createAbortError();
    const decision = parseSupervisorRoutingDecision(rawDecision);
    return resolveSelection(safeContext, decision);
  }
}

export function createSupervisorSelector(
  provider: SupervisorProvider,
): SupervisorSelector {
  return new SupervisorSelector(provider);
}

function previousHandoff(input: OrchestrationSelectionInput): HandoffEnvelope | null {
  const previous = input.turns.at(-1);
  if (!previous) return null;
  return {
    sourceParticipantId: previous.participantId,
    sourceAgentId: previous.agentId,
    sourceRunId: previous.runId,
    content: previous.output,
    truncated: previous.outputTruncated,
  };
}

function supervisorContext(
  input: OrchestrationSelectionInput,
): SupervisorSelectionContext {
  const profileInput = input as OrchestrationSelectionInput & {
    participantProfiles?: SupervisorSelectionContext["participantProfiles"];
  };
  return {
    sessionId: input.sessionId,
    originalPrompt: input.originalPrompt,
    participants: input.participants,
    ...(profileInput.participantProfiles === undefined
      ? {}
      : { participantProfiles: profileInput.participantProfiles }),
    stepIndex: input.stepIndex,
    maxSteps: input.maxSteps,
    previousHandoff: previousHandoff(input),
    recentTurns: [
      ...(input.contextTurns ?? []),
      ...(input.recentTurns ?? input.turns),
    ].map((turn) => {
      const stepIndex = (turn as { stepIndex?: number }).stepIndex;
      return {
        participantId: turn.participantId,
        agentId: turn.agentId,
        position: turn.position,
        ...(stepIndex === undefined ? {} : { stepIndex }),
        output: turn.output,
        outputTruncated: Boolean(turn.outputTruncated),
      };
    }),
  };
}

/**
 * Adapt the supervisor result to the existing framework-independent selector
 * function used by both orchestration engines. The engine remains responsible
 * for lifecycle/error handling and for dispatching the selected occurrence.
 */
export function createOrchestrationParticipantSelector(
  provider: SupervisorProvider,
): OrchestrationParticipantSelector {
  const selector = createSupervisorSelector(provider);
  return async (
    input: OrchestrationSelectionInput,
    options?: OrchestrationSelectionOptions,
  ): Promise<SequenceDecision> => {
    if (input.mode !== "supervisor") {
      throw new SupervisorError(
        "SUPERVISOR_INVALID_CONTEXT",
        "Supervisor selector used for a non-supervisor orchestration",
      );
    }
    const selection = await selector.selectNextParticipant(
      supervisorContext(input),
      {
        ...options,
        ...(input.supervisorModel === undefined
          ? {}
          : { model: input.supervisorModel }),
      },
    );
    if (selection.kind === "complete") {
      return {
        kind: "end",
        reason: "supervisor_completed",
        ...(selection.reason === undefined
          ? {}
          : { detail: selection.reason }),
      };
    }
    return {
      kind: "invoke",
      participant: selection.participant,
      stepIndex: selection.stepIndex,
      ...(selection.reason === undefined
        ? {}
        : { reason: selection.reason }),
    };
  };
}
