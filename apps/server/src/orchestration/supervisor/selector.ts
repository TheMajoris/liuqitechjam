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
import { DEFAULT_SUPERVISOR_TIMEOUT_MS } from "./provider.js";
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
    if (context.requireCurrentCycleDispatch) {
      throw new SupervisorError(
        "SUPERVISOR_INVALID_ROUTE",
        "Supervisor must select an eligible Agent before completing this follow-up",
      );
    }
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
    const startedAt = Date.now();
    const safeContext = sanitizeSupervisorSelectionContext(context);
    const rawDecision = await this.provider.decide(safeContext, options);
    if (options.signal?.aborted) throw createAbortError();
    const decision = parseSupervisorRoutingDecision(rawDecision);
    const selection = resolveSelection(safeContext, decision);
    if (
      safeContext.avoidImmediateRepeatAgentId === undefined ||
      selection.kind !== "invoke" ||
      selection.participant.agentId !== safeContext.avoidImmediateRepeatAgentId
    ) {
      return selection;
    }

    if (options.signal?.aborted) throw createAbortError();
    const configuredTimeoutMs = options.timeoutMs;
    const selectionTimeoutMs =
      typeof configuredTimeoutMs === "number" &&
      Number.isInteger(configuredTimeoutMs) &&
      configuredTimeoutMs > 0
        ? configuredTimeoutMs
        : DEFAULT_SUPERVISOR_TIMEOUT_MS;
    const remainingTimeoutMs =
      selectionTimeoutMs -
      Math.max(0, Date.now() - startedAt);
    if (remainingTimeoutMs <= 0) {
      throw new SupervisorError(
        "SUPERVISOR_TIMED_OUT",
        "Supervisor did not correct an immediate repeat before the routing deadline",
      );
    }

    const correctionContext = sanitizeSupervisorSelectionContext({
      ...safeContext,
      requireDifferentAgentOrComplete: true,
    });
    const correctedRawDecision = await this.provider.decide(
      correctionContext,
      { ...options, timeoutMs: remainingTimeoutMs },
    );
    if (options.signal?.aborted) throw createAbortError();
    const correctedDecision = parseSupervisorRoutingDecision(correctedRawDecision);
    const correctedSelection = resolveSelection(
      correctionContext,
      correctedDecision,
    );
    if (
      correctedSelection.kind === "invoke" &&
      correctedSelection.participant.agentId ===
        safeContext.avoidImmediateRepeatAgentId
    ) {
      throw new SupervisorError(
        "SUPERVISOR_INVALID_ROUTE",
        "Supervisor repeated the same Agent after a corrective routing call",
      );
    }
    return correctedSelection;
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

function previousCurrentCycleAgentId(
  input: OrchestrationSelectionInput,
  currentCycleTurnCount: number,
): string | undefined {
  if (input.turns.length === 0) return undefined;
  const distinctAgentIds = new Set(
    input.participants.map((participant) => participant.agentId.trim()),
  );
  if (distinctAgentIds.size <= 1) return undefined;
  // The engine supplies the authoritative current-cycle count, but retain a
  // defensive fallback to the actual current-cycle turn list if a compatible
  // caller sends a stale zero. Prior-cycle context is kept in `contextTurns`
  // and never enters this list.
  const currentTurns =
    currentCycleTurnCount > 0
      ? input.turns.slice(-currentCycleTurnCount)
      : input.turns;
  const previous = currentTurns.at(-1);
  const agentId = previous?.agentId.trim();
  if (!agentId || !distinctAgentIds.has(agentId)) return undefined;
  return agentId;
}

function supervisorContext(
  input: OrchestrationSelectionInput,
): SupervisorSelectionContext {
  const profileInput = input as OrchestrationSelectionInput & {
    participantProfiles?: SupervisorSelectionContext["participantProfiles"];
  };
  const currentCycleTurnCount = input.currentCycleTurnCount ?? input.turns.length;
  const priorCycleTurnCount =
    input.priorCycleTurnCount ?? input.contextTurns?.length ?? 0;
  const avoidImmediateRepeatAgentId = previousCurrentCycleAgentId(
    input,
    currentCycleTurnCount,
  );
  return {
    sessionId: input.sessionId,
    originalPrompt: input.originalPrompt,
    participants: input.participants,
    ...(profileInput.participantProfiles === undefined
      ? {}
      : { participantProfiles: profileInput.participantProfiles }),
    cycleIndex: input.cycleIndex ?? 0,
    stepIndex: input.stepIndex,
    maxSteps: input.maxSteps,
    currentCycleTurnCount,
    priorCycleTurnCount,
    ...(input.requireCurrentCycleDispatch
      ? { requireCurrentCycleDispatch: true }
      : {}),
    ...(avoidImmediateRepeatAgentId === undefined
      ? {}
      : { avoidImmediateRepeatAgentId }),
    previousHandoff: previousHandoff(input),
    recentTurns: [
      ...(input.contextTurns ?? []),
      ...(input.recentTurns ?? input.turns),
    ].map((turn) => {
      const stepIndex = (turn as { stepIndex?: number }).stepIndex;
      const runId =
        typeof turn.runId === "string" && turn.runId.trim().length > 0
          ? turn.runId
          : undefined;
      return {
        participantId: turn.participantId,
        agentId: turn.agentId,
        ...(runId === undefined ? {} : { runId }),
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
