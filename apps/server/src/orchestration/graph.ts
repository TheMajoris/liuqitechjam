import {
  END,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { z } from "zod";
import {
  buildHandoffPrompt,
  createHandoffEnvelope,
  type SharedConversationTurn,
} from "./handoff.js";
import type {
  OrchestrationExecutionHooks,
  OrchestrationExecutionInput,
  OrchestrationExecutionOptions,
} from "./orchestrator.js";
import {
  advanceSequence,
  type SequenceDecision,
  type SequenceStatus,
} from "./sequence.js";
import type { PlatformAgentInvokerContract } from "./platform-agent-invoker.js";
import {
  ORCHESTRATION_LIMITS,
  OrchestrationCompletionReasonSchema,
  OrchestrationErrorCodeSchema,
  OrchestrationGraphStatusSchema,
  OrchestrationGraphTurnSchema,
  OrchestrationModeSchema,
  OrchestrationParticipantSchema,
} from "./schemas.js";
import type {
  OrchestrationErrorCode,
  OrchestrationGraphState,
  OrchestrationGraphTurn,
  OrchestrationParticipant,
} from "./types.js";

/** Conservative default used when a caller does not carry the session guardrail. */
export const DEFAULT_ORCHESTRATION_AGENT_TIMEOUT_MS = 300_000;

/**
 * A worker turn and its conditional edge each consume a graph step. Keep a
 * small fixed allowance for START and the final terminal edge.
 */
export function getOrchestrationRecursionLimit(maxSteps: number): number {
  const normalized =
    Number.isInteger(maxSteps) && maxSteps > 0 ? maxSteps : 1;
  return normalized * 2 + 4;
}

const graphParticipantListSchema = z
  .array(OrchestrationParticipantSchema)
  .min(1)
  .max(ORCHESTRATION_LIMITS.maxParticipants);

const graphTurnListSchema = z
  .array(OrchestrationGraphTurnSchema)
  .max(ORCHESTRATION_LIMITS.maxSteps);

const graphContextTurnListSchema = z
  .array(
    z.object({
      participantId: z.string().min(1),
      agentId: z.string().min(1),
      position: z.number().int().nonnegative(),
      stepIndex: z.number().int().nonnegative().optional(),
      output: z.string().max(ORCHESTRATION_LIMITS.maxSafeOutputLength),
      outputTruncated: z.boolean().optional(),
    }) satisfies z.ZodType<SharedConversationTurn>,
  )
  .max(ORCHESTRATION_LIMITS.maxSteps);

/**
 * Runtime state is deliberately serializable. The invoker, signals, and
 * other side-effecting dependencies stay in the graph closure instead.
 */
export const OrchestrationGraphStateSchema = new StateSchema({
  sessionId: z.string().uuid(),
  originalPrompt: z
    .string()
    .trim()
    .min(1)
    .max(ORCHESTRATION_LIMITS.maxPromptLength),
  // Duplicate IDs/positions are left for advanceSequence to classify as a
  // visible terminal state rather than failing graph input validation.
  participants: graphParticipantListSchema,
  // Legacy callers omit mode and retain the original one-pass behavior.
  mode: OrchestrationModeSchema.default("sequential"),
  completionReason: OrchestrationCompletionReasonSchema.nullable().default(null),
  stepIndex: z.number().int().nonnegative().default(0),
  maxSteps: z.number().int().positive().max(ORCHESTRATION_LIMITS.maxSteps),
  lastRunId: z.string().uuid().nullable().default(null),
  lastOutput: z
    .string()
    .max(ORCHESTRATION_LIMITS.maxSafeOutputLength)
    .nullable()
    .default(null),
  /** Prior-cycle turns used only when constructing a bounded worker view. */
  contextTurns: graphContextTurnListSchema.default(() => []),
  turns: new ReducedValue(
    graphTurnListSchema.default(() => []),
    {
      inputSchema: graphTurnListSchema,
      reducer: (left, right) => left.concat(right),
    },
  ),
  status: OrchestrationGraphStatusSchema.default("running"),
  errorCode: OrchestrationErrorCodeSchema.nullable().default(null),
});

type GraphState = typeof OrchestrationGraphStateSchema.State;
type GraphUpdate = typeof OrchestrationGraphStateSchema.Update;

/** @deprecated Use the repository-owned Orchestrator input contract. */
export type OrchestrationGraphInput = OrchestrationExecutionInput;

/** @deprecated Use OrchestrationExecutionOptions at the application seam. */
export type OrchestrationGraphOptions = OrchestrationExecutionOptions;

export interface OrchestrationGraphRunOptions extends OrchestrationGraphOptions {
  recursionLimit?: number | undefined;
}

type GraphBuilderInput =
  | OrchestrationGraphOptions
  | PlatformAgentInvokerContract;

/**
 * Side-effect hooks owned by the lifecycle service. The graph itself keeps
 * only serializable state; these callbacks are deliberately supplied through
 * the graph closure so persistence and cancellation remain outside that
 * state. Hooks are called in dispatch order and are never retried.
 */
/** @deprecated Use OrchestrationExecutionHooks at the application seam. */
export type OrchestrationGraphHooks = OrchestrationExecutionHooks;

function normalizeOptions(input: GraphBuilderInput): OrchestrationGraphOptions {
  if ("invoker" in input) return input;
  return { invoker: input };
}

function timeoutFor(options: OrchestrationGraphOptions): number {
  const value = options.perAgentTimeoutMs;
  if (
    value !== undefined &&
    Number.isInteger(value) &&
    value >= ORCHESTRATION_LIMITS.minPerAgentTimeoutMs &&
    value <= ORCHESTRATION_LIMITS.maxPerAgentTimeoutMs
  ) {
    return value;
  }
  return DEFAULT_ORCHESTRATION_AGENT_TIMEOUT_MS;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal,
): { status: "failed" | "stopped"; errorCode: OrchestrationErrorCode } {
  if (signal.aborted) {
    return { status: "stopped", errorCode: "ORCHESTRATION_STOPPED" };
  }

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
  if (name.includes("timeout") || message.includes("timed out") || message.includes("timeout")) {
    return { status: "failed", errorCode: "RUN_TIMED_OUT" };
  }
  if (name.includes("abort") || message.includes("cancel")) {
    return { status: "failed", errorCode: "RUN_CANCELLED" };
  }
  if (
    message.includes("without output") ||
    message.includes("invalid output") ||
    message.includes("empty output")
  ) {
    return { status: "failed", errorCode: "INVALID_OUTPUT" };
  }
  return { status: "failed", errorCode: "RUN_FAILED" };
}

function sequenceFailureCode(
  reason: Exclude<SequenceDecision, { kind: "invoke" }>["reason"],
): OrchestrationErrorCode {
  switch (reason) {
    case "max_steps_reached":
      return "MAX_STEPS_EXCEEDED";
    case "terminal_state":
      return "INVALID_LIFECYCLE";
    case "invalid_state":
    case "invalid_roster":
      return "INVALID_INPUT";
    case "roster_exhausted":
    case "supervisor_completed":
      return "INVALID_INPUT";
  }
}

function terminalUpdate(
  decision: SequenceDecision,
  currentStatus: GraphState["status"],
): GraphUpdate {
  if (decision.kind === "invoke") return {};
  if (decision.reason === "roster_exhausted") {
    return {
      status: "completed",
      errorCode: null,
      completionReason: "roster_exhausted",
    };
  }
  // Round-robin deliberately uses maxSteps as its bounded turn budget. Once
  // that ceiling is reached while the roster remains, report an explicit
  // failure so callers cannot mistake a bounded run for successful work.
  // Keep this branch centralized so a future engine can adjust the terminal
  // mapping without changing sequence selection or handoff behavior.
  if (decision.reason === "max_steps_reached") {
    return { status: "failed", errorCode: "MAX_STEPS_EXCEEDED" };
  }
  if (decision.reason === "terminal_state") {
    return { status: currentStatus };
  }
  return { status: "failed", errorCode: sequenceFailureCode(decision.reason) };
}

function previousHandoff(state: GraphState) {
  const previous = state.turns[state.turns.length - 1];
  if (!previous) return null;
  return {
    sourceParticipantId: previous.participantId,
    sourceAgentId: previous.agentId,
    sourceRunId: previous.runId,
    content: previous.output,
    truncated: previous.outputTruncated,
  };
}

async function invokeAgentNode(
  state: GraphState,
  runtime: { signal: AbortSignal },
  options: OrchestrationGraphOptions,
): Promise<GraphUpdate> {
  if (state.status !== "running") return {};
  if (runtime.signal.aborted) {
    return { status: "stopped", errorCode: "ORCHESTRATION_STOPPED" };
  }

  // This graph is the deterministic rollback path.  A supervisor request
  // must fail closed instead of silently dispatching the first roster entry.
  if (state.mode === "supervisor") {
    return { status: "failed", errorCode: "SUPERVISOR_UNAVAILABLE" };
  }

  // Do not ask even the deterministic selector for another turn once the
  // application-owned budget is reached. A sequential roster that completed
  // exactly at its declared length remains a natural success.
  if (state.stepIndex >= state.maxSteps) {
    if (state.mode === "sequential" && state.stepIndex >= state.participants.length) {
      return {
        status: "completed",
        errorCode: null,
        completionReason: "roster_exhausted",
      };
    }
    return { status: "failed", errorCode: "MAX_STEPS_EXCEEDED" };
  }

  // A caller may seed state when invoking the graph directly. The service
  // starts with an empty turn list, but a seeded list still has to respect the
  // session's authoritative dispatch budget before another turn is appended.
  if (state.turns.length > state.maxSteps) {
    return { status: "failed", errorCode: "INVALID_INPUT" };
  }

  const decision = advanceSequence({
    participants: state.participants,
    stepIndex: state.stepIndex,
    maxSteps: state.maxSteps,
    mode: state.mode,
    status: state.status as SequenceStatus,
  });
  if (decision.kind === "end") {
    return terminalUpdate(decision, state.status);
  }

  const participant = decision.participant;
  const handoff = buildHandoffPrompt(
    {
      originalPrompt: state.originalPrompt,
      participant,
      contextTurns: state.contextTurns,
      recentTurns: state.turns,
      previous: previousHandoff(state),
    },
    options.handoffLimits,
  );

  if (handoff.envelope) {
    await options.hooks?.onHandoffApplied?.({
      participant,
      envelope: handoff.envelope,
      stepIndex: decision.stepIndex,
    });
  }

  try {
    await options.hooks?.onBeforeDispatch?.({
      participant,
      prompt: handoff.prompt,
      stepIndex: decision.stepIndex,
    });
  } catch (error) {
    const failure = classifyFailure(error, runtime.signal);
    await options.hooks?.onParticipantFailed?.({
      participant,
      prompt: handoff.prompt,
      runId: null,
      stepIndex: decision.stepIndex,
      error,
      errorCode: failure.errorCode,
    });
    return { status: failure.status, errorCode: failure.errorCode };
  }

  let acceptedRunId: string | null = null;

  try {
    const result = await options.invoker.invoke({
      agentId: participant.agentId,
      prompt: handoff.prompt,
      ...(options.orchestrationId === undefined ? {} : { orchestrationId: options.orchestrationId }),
      timeoutMs: timeoutFor(options),
      signal: runtime.signal,
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
    // The platform adapter reports acceptance before waiting, but a small
    // test/integration invoker may only expose the accepted ID in its result.
    // Preserve the dispatch journal contract without double-recording when
    // the callback was already delivered.
    if (
      acceptedRunId === null &&
      typeof result.runId === "string" &&
      result.runId.trim().length > 0
    ) {
      acceptedRunId = result.runId;
      await options.hooks?.onRunAccepted?.({
        participant,
        prompt: handoff.prompt,
        runId: result.runId,
        stepIndex: decision.stepIndex,
      });
    }
    if (runtime.signal.aborted) {
      const error = new Error("Orchestration stopped");
      await options.hooks?.onParticipantFailed?.({
        participant,
        prompt: handoff.prompt,
        runId: acceptedRunId,
        stepIndex: decision.stepIndex,
        error,
        errorCode: "ORCHESTRATION_STOPPED",
      });
      return { status: "stopped", errorCode: "ORCHESTRATION_STOPPED" };
    }
    if (
      typeof result.output !== "string" ||
      result.output.trim().length === 0 ||
      typeof result.runId !== "string" ||
      result.runId.trim().length === 0
    ) {
      const error = new Error("Agent returned invalid output");
      await options.hooks?.onParticipantFailed?.({
        participant,
        prompt: handoff.prompt,
        runId: acceptedRunId,
        stepIndex: decision.stepIndex,
        error,
        errorCode: "INVALID_OUTPUT",
      });
      return { status: "failed", errorCode: "INVALID_OUTPUT" };
    }

    const envelope = createHandoffEnvelope(
      {
        sourceParticipantId: participant.id,
        sourceAgentId: participant.agentId,
        sourceRunId: result.runId,
        content: result.output,
      },
      options.handoffLimits,
    );
    const turn: OrchestrationGraphState["turns"][number] = {
      participantId: participant.id,
      agentId: participant.agentId,
      runId: result.runId,
      position: participant.position,
      output: envelope.content,
      outputTruncated: envelope.truncated,
    };
    await options.hooks?.onRunCompleted?.({
      participant,
      prompt: handoff.prompt,
      runId: result.runId,
      output: result.output,
      envelope,
      turn,
      stepIndex: decision.stepIndex,
    });
    const nextStep = state.stepIndex + 1;
    const nextDecision = advanceSequence({
      participants: state.participants,
      stepIndex: nextStep,
      maxSteps: state.maxSteps,
      mode: state.mode,
      status: "running",
    });
    return {
      stepIndex: nextStep,
      lastRunId: result.runId,
      lastOutput: envelope.content,
      turns: [turn],
      ...terminalUpdate(nextDecision, "running"),
    };
  } catch (error) {
    const failure = classifyFailure(error, runtime.signal);
    await options.hooks?.onParticipantFailed?.({
      participant,
      prompt: handoff.prompt,
      runId: acceptedRunId,
      stepIndex: decision.stepIndex,
      error,
      errorCode: failure.errorCode,
    });
    return { status: failure.status, errorCode: failure.errorCode };
  }
}

/**
 * @internal Build one generic worker graph for the lifecycle service and tests.
 * Agent identity is always runtime roster data.
 */
export function createOrchestrationGraph(input: GraphBuilderInput) {
  const options = normalizeOptions(input);
  const builder = new StateGraph(OrchestrationGraphStateSchema)
    .addNode("invoke_agent", (state, runtime) =>
      invokeAgentNode(state, runtime, options),
    )
    .addEdge(START, "invoke_agent")
    .addConditionalEdges("invoke_agent", (state) =>
      state.status === "running" ? "invoke_agent" : END,
    );

  // No retryPolicy is attached: replaying this side-effecting node can create
  // a duplicate Codex Run. Reliability retries belong after dispatch idempotency.
  return builder.compile({ checkpointer: false });
}

/** @internal Descriptive alias used by callers that name the seam a graph builder. */
export const buildOrchestrationGraph = createOrchestrationGraph;

/** Invoke a graph with an explicit recursion guard derived from maxSteps. */
export async function runOrchestrationGraph(
  input: OrchestrationGraphInput,
  options: OrchestrationGraphRunOptions,
): Promise<OrchestrationGraphState> {
  const graph = createOrchestrationGraph(options);
  const recursionLimit =
    options.recursionLimit ?? getOrchestrationRecursionLimit(input.maxSteps);
  // LangGraph state is mutable at its framework boundary. Copy the
  // application-owned readonly projections before handing them to it.
  const {
    contextTurns,
    turns,
    participants,
    ...inputWithoutMutableCollections
  } = input;
  const graphInput = {
    ...inputWithoutMutableCollections,
    participants: participants.map((participant) => ({ ...participant })),
    ...(turns === undefined
      ? {}
      : { turns: turns.map((turn) => ({ ...turn })) }),
    ...(contextTurns === undefined
      ? {}
      : {
          contextTurns: contextTurns.map((turn) => ({ ...turn })),
        }),
  };
  const result = await graph.invoke(graphInput, {
    recursionLimit,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return result as OrchestrationGraphState;
}
