import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import {
  buildHandoffPrompt,
  createHandoffEnvelope,
  type HandoffEnvelope,
  type SharedConversationTurn,
} from "../handoff.js";
import {
  OrchestrationErrorCodeSchema,
  OrchestrationGraphStatusSchema,
  OrchestrationModeSchema,
  OrchestrationParticipantSchema,
  ORCHESTRATION_LIMITS,
  OrchestrationCompletionReasonSchema,
  SUPERVISOR_REASON_MAX_CHARS,
} from "../schemas.js";
import {
  type OrchestrationExecutionHooks,
  type OrchestrationExecutionTurn,
  type OrchestrationSelectionInput,
} from "../orchestrator.js";
import type { OrchestrationErrorCode } from "../types.js";
import type { SequenceDecision, SequenceInput } from "../sequence.js";
import type { OrchestrationParticipant } from "../types.js";
import type {
  MastraExecutionState,
  MastraOrchestrationStepOptions,
} from "./types.js";

const mastraExecutionTurnSchema: z.ZodType<OrchestrationExecutionTurn> = z.object({
  participantId: z.string().min(1),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  position: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().optional(),
  output: z.string().max(ORCHESTRATION_LIMITS.maxSafeOutputLength),
  outputTruncated: z.boolean(),
});

const mastraContextTurnSchema: z.ZodType<SharedConversationTurn> = z.object({
  participantId: z.string().min(1),
  agentId: z.string().min(1),
  position: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().optional(),
  output: z.string().max(ORCHESTRATION_LIMITS.maxSafeOutputLength),
  outputTruncated: z.boolean().optional(),
});

/** Same-shape input/output state carried by the Mastra do-while loop. */
export const mastraExecutionStateSchema: z.ZodType<MastraExecutionState> = z.object({
  sessionId: z.string().min(1),
  originalPrompt: z
    .string()
    .min(1)
    .max(ORCHESTRATION_LIMITS.maxPromptLength),
  participants: z
    .array(OrchestrationParticipantSchema)
    .min(1)
    .max(ORCHESTRATION_LIMITS.maxParticipants),
  mode: OrchestrationModeSchema,
  completionReason: OrchestrationCompletionReasonSchema.nullable(),
  stepIndex: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive().max(ORCHESTRATION_LIMITS.maxSteps),
  lastRunId: z.string().nullable(),
  lastOutput: z
    .string()
    .max(ORCHESTRATION_LIMITS.maxSafeOutputLength)
    .nullable(),
  contextTurns: z
    .array(mastraContextTurnSchema)
    .max(ORCHESTRATION_LIMITS.maxSteps)
    .optional(),
  turns: z
    .array(mastraExecutionTurnSchema)
    .max(ORCHESTRATION_LIMITS.maxSteps),
  status: OrchestrationGraphStatusSchema,
  errorCode: OrchestrationErrorCodeSchema.nullable(),
});

interface LinkedAbortSignal {
  signal: AbortSignal;
  dispose: () => void;
}

/** Link Mastra's loop signal with the lifecycle owner's signal. */
function linkAbortSignals(
  workflowSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): LinkedAbortSignal {
  if (!callerSignal) {
    return { signal: workflowSignal, dispose: () => undefined };
  }

  const controller = new AbortController();
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onWorkflowAbort = (): void => abortFrom(workflowSignal);
  const onCallerAbort = (): void => abortFrom(callerSignal);
  workflowSignal.addEventListener("abort", onWorkflowAbort, { once: true });
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  if (workflowSignal.aborted) onWorkflowAbort();
  if (callerSignal.aborted) onCallerAbort();

  return {
    signal: controller.signal,
    dispose: () => {
      workflowSignal.removeEventListener("abort", onWorkflowAbort);
      callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyFailure(
  error: unknown,
  mode: MastraExecutionState["mode"] = "sequential",
): { status: "failed"; errorCode: OrchestrationErrorCode } {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = asErrorMessage(error).toLowerCase();
  const explicitCode =
    typeof error === "object" && error !== null && "orchestrationErrorCode" in error
      ? (error as { orchestrationErrorCode?: unknown }).orchestrationErrorCode
      : undefined;
  if (
    typeof explicitCode === "string" &&
    OrchestrationErrorCodeSchema.safeParse(explicitCode).success
  ) {
    return {
      status: "failed",
      errorCode: explicitCode as OrchestrationErrorCode,
    };
  }
  if (
    name.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return {
      status: "failed",
      errorCode: mode === "supervisor" ? "SUPERVISOR_TIMED_OUT" : "RUN_TIMED_OUT",
    };
  }
  if (name.includes("abort") || message.includes("cancel")) {
    return { status: "failed", errorCode: "RUN_CANCELLED" };
  }
  if (
    message.includes("without output") ||
    message.includes("invalid output") ||
    message.includes("empty output")
  ) {
    return {
      status: "failed",
      errorCode:
        mode === "supervisor" ? "SUPERVISOR_INVALID_RESPONSE" : "INVALID_OUTPUT",
    };
  }
  return {
    status: "failed",
    errorCode: mode === "supervisor" ? "SUPERVISOR_FAILED" : "RUN_FAILED",
  };
}

function abortError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const result = new Error("Orchestration stopped");
  result.name = "AbortError";
  return result;
}

async function notifyParticipantFailed(
  hooks: OrchestrationExecutionHooks | undefined,
  input: Parameters<NonNullable<OrchestrationExecutionHooks["onParticipantFailed"]>>[0],
): Promise<void> {
  try {
    await hooks?.onParticipantFailed?.(input);
  } catch {
    // Keep a lifecycle persistence failure from masking the child outcome.
  }
}

function previousEnvelope(
  turns: readonly OrchestrationExecutionTurn[],
): HandoffEnvelope | null {
  const previous = turns.at(-1);
  if (!previous) return null;
  return {
    sourceParticipantId: previous.participantId,
    sourceAgentId: previous.agentId,
    sourceRunId: previous.runId,
    content: previous.output,
    truncated: previous.outputTruncated,
  };
}

function failureState(
  state: MastraExecutionState,
  errorCode: OrchestrationErrorCode,
): MastraExecutionState {
  return {
    ...state,
    status: "failed",
    completionReason: null,
    errorCode,
  };
}

function stoppedState(state: MastraExecutionState): MastraExecutionState {
  return {
    ...state,
    status: "stopped",
    completionReason: null,
    errorCode: "ORCHESTRATION_STOPPED",
  };
}

function terminalState(
  state: MastraExecutionState,
  decision: Exclude<SequenceDecision, { kind: "invoke" }>,
): MastraExecutionState {
  switch (decision.reason) {
    case "roster_exhausted":
      return {
        ...state,
        status: "completed",
        completionReason: "roster_exhausted",
        errorCode: null,
      };
    case "supervisor_completed":
      return {
        ...state,
        status: "completed",
        completionReason: "supervisor_completed",
        errorCode: null,
      };
    case "max_steps_reached":
      return failureState(state, "MAX_STEPS_EXCEEDED");
    case "terminal_state":
      return failureState(state, "INVALID_LIFECYCLE");
    case "invalid_state":
    case "invalid_roster":
      return failureState(state, "INVALID_INPUT");
  }
}

function configuredParticipant(
  state: MastraExecutionState,
  decision: SequenceDecision,
): OrchestrationParticipant | null {
  if (decision.kind !== "invoke") return null;
  if (
    !Number.isInteger(decision.stepIndex) ||
    decision.stepIndex !== state.stepIndex
  ) {
    return null;
  }
  const participant = state.participants.find(
    (candidate) =>
      candidate.id === decision.participant.id &&
      candidate.agentId === decision.participant.agentId &&
      candidate.position === decision.participant.position,
  );
  return participant ?? null;
}

function isSequenceDecision(value: unknown): value is SequenceDecision {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  if (record?.kind === "end") {
    return (
      record.reason === "roster_exhausted" ||
      record.reason === "supervisor_completed" ||
      record.reason === "max_steps_reached" ||
      record.reason === "invalid_state" ||
      record.reason === "invalid_roster" ||
      record.reason === "terminal_state"
    );
  }
  if (record?.kind !== "invoke") return false;
  const participant = record.participant;
  return (
    typeof record.stepIndex === "number" &&
    Number.isInteger(record.stepIndex) &&
    record.stepIndex >= 0 &&
    typeof participant === "object" &&
    participant !== null
  );
}

function boundedDecisionReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const reason = value.trim();
  if (reason.length === 0) return undefined;
  const marker = "\n[REASON TRUNCATED]";
  return reason.length <= SUPERVISOR_REASON_MAX_CHARS
    ? reason
    : reason.slice(0, Math.max(0, SUPERVISOR_REASON_MAX_CHARS - marker.length)).trimEnd() +
        marker;
}

function decisionReason(decision: SequenceDecision): string | undefined {
  return decision.kind === "invoke"
    ? boundedDecisionReason(decision.reason)
    : boundedDecisionReason(decision.detail);
}

/** Execute one participant turn and return the next loop state. */
export async function executeMastraOrchestrationStep(
  state: MastraExecutionState,
  workflowSignal: AbortSignal,
  options: MastraOrchestrationStepOptions,
): Promise<MastraExecutionState> {
  if (state.status !== "running") return state;
  // A resumed/seeded execution must never append beyond its authoritative
  // dispatch budget, even if its step index was supplied independently.
  if (state.turns.length > state.maxSteps) {
    options.onStepFailure?.({
      error: new Error("Seeded orchestration turns exceed maxSteps"),
      errorCode: "INVALID_INPUT",
    });
    return failureState(state, "INVALID_INPUT");
  }
  if (workflowSignal.aborted || options.signal?.aborted) {
    throw abortError(undefined);
  }

  // The application-owned dispatch budget is checked before consulting any
  // selector/provider.  Sequential runs that have naturally exhausted their
  // roster remain successful; every other run must fail at the ceiling rather
  // than asking a supervisor (or deterministic selector) for another turn.
  if (state.stepIndex >= state.maxSteps) {
    if (state.mode === "sequential" && state.stepIndex >= state.participants.length) {
      return terminalState(state, { kind: "end", reason: "roster_exhausted" });
    }
    const error = new Error("Orchestration maxSteps limit reached");
    options.onStepFailure?.({ error, errorCode: "MAX_STEPS_EXCEEDED" });
    return failureState(state, "MAX_STEPS_EXCEEDED");
  }

  let decision: SequenceDecision;
  const selectionLinked = linkAbortSignals(workflowSignal, options.signal);
  try {
    const selectionInput: OrchestrationSelectionInput = {
      sessionId: state.sessionId,
      originalPrompt: state.originalPrompt,
      // Keep the validated execution roster authoritative even if a future
      // supervisor implementation attempts to mutate its selection input.
      participants: state.participants.map((participant) => ({ ...participant })),
      mode: state.mode,
      stepIndex: state.stepIndex,
      maxSteps: state.maxSteps,
      turns: state.turns.map((turn) => ({ ...turn })),
      ...(options.participantProfiles === undefined
        ? {}
        : {
            participantProfiles: options.participantProfiles.map((profile) => ({
              ...profile,
            })),
          }),
      // Keep current-cycle turns separate for lifecycle accounting. The
      // supervisor combines them with prior context only at its bounded
      // provider projection boundary.
      recentTurns: state.turns.map((turn) => ({ ...turn })),
      ...(state.contextTurns === undefined
        ? {}
        : {
            contextTurns: state.contextTurns.map((turn) => ({ ...turn })),
          }),
      lastRunId: state.lastRunId,
      lastOutput: state.lastOutput,
      status: state.status,
    };
    decision = await options.selectNextParticipant(selectionInput, {
      signal: selectionLinked.signal,
      ...(options.supervisorTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.supervisorTimeoutMs }),
    });
  } catch (error) {
    if (workflowSignal.aborted || options.signal?.aborted) throw abortError(error);
    const failure = classifyFailure(error, state.mode);
    options.onStepFailure?.({ error, errorCode: failure.errorCode });
    return failureState(state, failure.errorCode);
  } finally {
    selectionLinked.dispose();
  }

  if (!isSequenceDecision(decision)) {
    const error = new Error("Participant selector returned an invalid decision");
    const errorCode =
      state.mode === "supervisor" ? "SUPERVISOR_INVALID_RESPONSE" : "INVALID_INPUT";
    options.onStepFailure?.({ error, errorCode });
    return failureState(state, errorCode);
  }
  if (decision.kind === "end") {
    if (state.mode === "supervisor") {
      if (decision.reason !== "supervisor_completed") {
        const error = new Error("Supervisor returned an invalid terminal decision");
        options.onStepFailure?.({ error, errorCode: "SUPERVISOR_INVALID_SELECTION" });
        return failureState(state, "SUPERVISOR_INVALID_SELECTION");
      }
      try {
        await options.hooks?.onSupervisorDecision?.({
          action: "complete",
          stepIndex: state.stepIndex,
          ...(decisionReason(decision) === undefined
            ? {}
            : { reason: decisionReason(decision) }),
        });
      } catch (error) {
        if (workflowSignal.aborted || options.signal?.aborted) {
          throw abortError(error);
        }
        options.onStepFailure?.({ error, errorCode: "SUPERVISOR_FAILED" });
        return failureState(state, "SUPERVISOR_FAILED");
      }
    }
    return terminalState(state, decision);
  }
  const participant = configuredParticipant(state, decision);
  if (!participant) {
    const errorCode =
      state.mode === "supervisor" ? "SUPERVISOR_INVALID_SELECTION" : "INVALID_INPUT";
    options.onStepFailure?.({
      error: new Error("Participant selector returned an unconfigured participant"),
      errorCode,
    });
    return failureState(state, errorCode);
  }
  if (state.mode === "supervisor") {
    try {
      await options.hooks?.onSupervisorDecision?.({
        action: "invoke",
        participantId: participant.id,
        stepIndex: decision.stepIndex,
          ...(decisionReason(decision) === undefined
            ? {}
            : { reason: decisionReason(decision) }),
      });
    } catch (error) {
      if (workflowSignal.aborted || options.signal?.aborted) {
        throw abortError(error);
      }
      options.onStepFailure?.({ error, errorCode: "SUPERVISOR_FAILED" });
      return failureState(state, "SUPERVISOR_FAILED");
    }
  }

  const handoff = buildHandoffPrompt(
    {
      originalPrompt: state.originalPrompt,
      participant,
      ...(state.contextTurns === undefined
        ? {}
        : { contextTurns: state.contextTurns }),
      recentTurns: state.turns,
      previous: previousEnvelope(state.turns),
    },
    options.handoffLimits,
  );

  try {
    if (handoff.envelope) {
      await options.hooks?.onHandoffApplied?.({
        participant,
        envelope: handoff.envelope,
        stepIndex: decision.stepIndex,
      });
    }
    await options.hooks?.onBeforeDispatch?.({
      participant,
      prompt: handoff.prompt,
      stepIndex: decision.stepIndex,
    });
  } catch (error) {
    if (workflowSignal.aborted || options.signal?.aborted) {
      await notifyParticipantFailed(options.hooks, {
        participant,
        prompt: handoff.prompt,
        runId: null,
        stepIndex: decision.stepIndex,
        error,
        errorCode: "ORCHESTRATION_STOPPED",
      });
      return stoppedState(state);
    }
    const failure = classifyFailure(error);
    options.onStepFailure?.({ error, errorCode: failure.errorCode });
    await notifyParticipantFailed(options.hooks, {
      participant,
      prompt: handoff.prompt,
      runId: null,
      stepIndex: decision.stepIndex,
      error,
      errorCode: failure.errorCode,
    });
    return failureState(state, failure.errorCode);
  }

  let acceptedRunId: string | null = null;
  const linked = linkAbortSignals(workflowSignal, options.signal);
  try {
    const childResult = await options.invoker.invoke({
      agentId: participant.agentId,
      prompt: handoff.prompt,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      timeoutMs: options.perAgentTimeoutMs,
      signal: linked.signal,
      onRunAccepted: async (runId) => {
        if (acceptedRunId !== null || runId.trim().length === 0) return;
        acceptedRunId = runId;
        await options.hooks?.onRunAccepted?.({
          participant,
          prompt: handoff.prompt,
          runId,
          stepIndex: decision.stepIndex,
        });
      },
    });

    // The platform adapter reports acceptance through the callback, but keep
    // the dispatch journal correct for a compatible invoker that only exposes
    // the accepted Run ID in its result.
    if (
      acceptedRunId === null &&
      typeof childResult.runId === "string" &&
      childResult.runId.trim().length > 0
    ) {
      acceptedRunId = childResult.runId;
      await options.hooks?.onRunAccepted?.({
        participant,
        prompt: handoff.prompt,
        runId: childResult.runId,
        stepIndex: decision.stepIndex,
      });
    }
    if (workflowSignal.aborted || options.signal?.aborted) {
      throw abortError(undefined);
    }
    if (
      typeof childResult.output !== "string" ||
      childResult.output.trim().length === 0 ||
      typeof childResult.runId !== "string" ||
      childResult.runId.trim().length === 0
    ) {
      throw new Error("Agent returned invalid output");
    }

    const envelope = createHandoffEnvelope(
      {
        sourceParticipantId: participant.id,
        sourceAgentId: participant.agentId,
        sourceRunId: childResult.runId,
        content: childResult.output,
      },
      options.handoffLimits,
    );
    const turn: OrchestrationExecutionTurn = {
      participantId: participant.id,
      agentId: participant.agentId,
      runId: childResult.runId,
      position: participant.position,
      stepIndex: decision.stepIndex,
      output: envelope.content,
      outputTruncated: envelope.truncated,
    };
    await options.hooks?.onRunCompleted?.({
      participant,
      prompt: handoff.prompt,
      runId: childResult.runId,
      output: childResult.output,
      envelope,
      turn,
      stepIndex: decision.stepIndex,
    });

    return {
      ...state,
      stepIndex: decision.stepIndex + 1,
      lastRunId: childResult.runId,
      lastOutput: envelope.content,
      turns: [...state.turns, turn],
      status: "running",
      completionReason: null,
      errorCode: null,
    };
  } catch (error) {
    if (workflowSignal.aborted || options.signal?.aborted) {
      await notifyParticipantFailed(options.hooks, {
        participant,
        prompt: handoff.prompt,
        runId: acceptedRunId,
        stepIndex: decision.stepIndex,
        error,
        errorCode: "ORCHESTRATION_STOPPED",
      });
      return stoppedState(state);
    }
    const failure = classifyFailure(error);
    options.onStepFailure?.({ error, errorCode: failure.errorCode });
    await notifyParticipantFailed(options.hooks, {
      participant,
      prompt: handoff.prompt,
      runId: acceptedRunId,
      stepIndex: decision.stepIndex,
      error,
      errorCode: failure.errorCode,
    });
    return failureState(state, failure.errorCode);
  } finally {
    linked.dispose();
  }
}

/** Build the single generic state step used by the Mastra orchestration loop. */
export function createMastraOrchestrationStep(
  options: MastraOrchestrationStepOptions & { id: string },
) {
  return createStep({
    id: options.id,
    inputSchema: mastraExecutionStateSchema,
    outputSchema: mastraExecutionStateSchema,
    retries: 0,
    execute: async ({ inputData, abortSignal }) =>
      executeMastraOrchestrationStep(inputData, abortSignal, options),
  });
}
