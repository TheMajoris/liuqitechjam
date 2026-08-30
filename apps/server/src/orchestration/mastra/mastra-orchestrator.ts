import {
  OrchestrationErrorCodeSchema,
  OrchestrationModeSchema,
  OrchestrationParticipantSchema,
  ORCHESTRATION_LIMITS,
} from "../schemas.js";
import {
  advanceSequence,
  type SequenceDecision,
} from "../sequence.js";
import { SupervisorError } from "../supervisor/index.js";
import type { PlatformAgentInvokerContract } from "../platform-agent-invoker.js";
import type {
  OrchestrationExecutionInput,
  OrchestrationExecutionOptions,
  OrchestrationExecutionResult,
  OrchestrationParticipantSelector,
  Orchestrator,
  OrchestrationSelectionInput,
} from "../orchestrator.js";
import type { OrchestrationErrorCode } from "../types.js";
import { mastraExecutionStateSchema } from "./agent-step.js";
import { createMastraOrchestrationWorkflow } from "./workflow-factory.js";
import type { MastraExecutionState } from "./types.js";

/** Conservative default used when a caller does not carry the session guardrail. */
export const DEFAULT_MASTRA_AGENT_TIMEOUT_MS = 300_000;

interface StepFailureContext {
  error: unknown;
  errorCode: OrchestrationErrorCode;
}

interface WorkflowResultLike {
  status?: unknown;
  result?: unknown;
  state?: unknown;
  error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  if (typeof record?.message === "string") return record.message;
  return String(error);
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  const result = new Error(asErrorMessage(error));
  const record = asRecord(error);
  if (typeof record?.name === "string") result.name = record.name;
  return result;
}

function isAbortError(error: unknown): boolean {
  return asError(error).name === "AbortError";
}

function abortError(): Error {
  const result = new Error("Orchestration stopped");
  result.name = "AbortError";
  return result;
}

function classifyFailure(
  error: unknown,
  mode: OrchestrationExecutionInput["mode"] = "sequential",
): OrchestrationErrorCode {
  const record = asRecord(error);
  const explicitCode = record?.orchestrationErrorCode;
  if (
    typeof explicitCode === "string" &&
    OrchestrationErrorCodeSchema.safeParse(explicitCode).success
  ) {
    return explicitCode as OrchestrationErrorCode;
  }

  const name = asError(error).name.toLowerCase();
  const message = asErrorMessage(error).toLowerCase();
  if (
    name.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return mode === "supervisor" ? "SUPERVISOR_TIMED_OUT" : "RUN_TIMED_OUT";
  }
  if (name.includes("abort") || message.includes("cancel")) {
    return "RUN_CANCELLED";
  }
  if (
    message.includes("without output") ||
    message.includes("invalid output") ||
    message.includes("empty output")
  ) {
    return mode === "supervisor"
      ? "SUPERVISOR_INVALID_RESPONSE"
      : "INVALID_OUTPUT";
  }
  return mode === "supervisor" ? "SUPERVISOR_FAILED" : "RUN_FAILED";
}

function timeoutFor(options: OrchestrationExecutionOptions): number {
  const value = options.perAgentTimeoutMs;
  if (
    value !== undefined &&
    Number.isInteger(value) &&
    value >= ORCHESTRATION_LIMITS.minPerAgentTimeoutMs &&
    value <= ORCHESTRATION_LIMITS.maxPerAgentTimeoutMs
  ) {
    return value;
  }
  return DEFAULT_MASTRA_AGENT_TIMEOUT_MS;
}

function stateToResult(state: MastraExecutionState): OrchestrationExecutionResult {
  return {
    sessionId: state.sessionId,
    originalPrompt: state.originalPrompt,
    participants: state.participants.map((participant) => ({ ...participant })),
    mode: state.mode,
    completionReason: state.completionReason,
    stepIndex: state.stepIndex,
    maxSteps: state.maxSteps,
    lastRunId: state.lastRunId,
    lastOutput: state.lastOutput,
    turns: state.turns.map((turn) => ({ ...turn })),
    status: state.status,
    errorCode: state.errorCode,
  };
}

function failedState(
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

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function invalidResult(input: unknown): OrchestrationExecutionResult {
  const record = asRecord(input);
  const participants = Array.isArray(record?.participants)
    ? record.participants
        .filter((participant): participant is MastraExecutionState["participants"][number] => {
          return OrchestrationParticipantSchema.safeParse(participant).success;
        })
        .map((participant) => ({ ...participant }))
    : [];
  const mode = OrchestrationModeSchema.safeParse(record?.mode).success
    ? (record?.mode as "sequential" | "round_robin" | "supervisor")
    : "sequential";
  const maxSteps = validPositiveInteger(record?.maxSteps)
    ? Math.min(record.maxSteps, ORCHESTRATION_LIMITS.maxSteps)
    : 1;
  const stepIndex =
    typeof record?.stepIndex === "number" &&
    Number.isInteger(record.stepIndex) &&
    record.stepIndex >= 0
      ? record.stepIndex
      : 0;
  return {
    sessionId: typeof record?.sessionId === "string" ? record.sessionId : "",
    originalPrompt:
      typeof record?.originalPrompt === "string" ? record.originalPrompt : "",
    participants,
    mode,
    completionReason: null,
    stepIndex,
    maxSteps,
    lastRunId: null,
    lastOutput: null,
    turns: [],
    status: "failed",
    errorCode: "INVALID_INPUT",
  };
}

function normalizeInput(input: OrchestrationExecutionInput): MastraExecutionState {
  const contextTurns = (
    input as OrchestrationExecutionInput & Pick<MastraExecutionState, "contextTurns">
  ).contextTurns;
  return {
    sessionId: input.sessionId,
    originalPrompt: input.originalPrompt,
    participants: [...input.participants],
    mode: input.mode ?? "sequential",
    completionReason: input.completionReason ?? null,
    stepIndex: input.stepIndex ?? 0,
    maxSteps: input.maxSteps,
    lastRunId: input.lastRunId ?? null,
    lastOutput: input.lastOutput ?? null,
    ...(contextTurns === undefined
      ? {}
      : { contextTurns: contextTurns.map((turn) => ({ ...turn })) }),
    turns: input.turns ? [...input.turns] : [],
    status: input.status ?? "running",
    errorCode: input.errorCode ?? null,
  };
}

function workflowResultError(result: WorkflowResultLike): Error {
  const direct = result.error;
  if (direct !== undefined) return asError(direct);
  const state = asRecord(result.state);
  const nested = state?.error;
  if (nested !== undefined) return asError(nested);
  return new Error("Mastra orchestration workflow failed");
}

function workflowResultState(
  result: WorkflowResultLike,
  fallback: MastraExecutionState,
): MastraExecutionState {
  const candidate = result.result ?? result.state;
  const parsed = mastraExecutionStateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Mastra adapter for the repository-owned Orchestrator contract.
 *
 * Mastra-specific workflow/run objects remain entirely inside this class. A
 * single transient workflow owns the do-while progression for one
 * orchestration; the selector is an awaitable protected seam so a future
 * supervisor can choose only from the validated roster.
 */
export class MastraOrchestrator implements Orchestrator {
  constructor(private readonly defaultInvoker?: PlatformAgentInvokerContract) {}

  protected async selectNextParticipant(
    input: OrchestrationSelectionInput,
  ): Promise<SequenceDecision> {
    if (input.mode === "supervisor") {
      throw new SupervisorError(
        "SUPERVISOR_NOT_CONFIGURED",
        "Supervisor routing is unavailable",
      );
    }
    return advanceSequence({
      participants: input.participants,
      stepIndex: input.stepIndex,
      maxSteps: input.maxSteps,
      mode: input.mode,
      status: input.status,
    });
  }

  async run(
    input: OrchestrationExecutionInput,
    options: OrchestrationExecutionOptions,
  ): Promise<OrchestrationExecutionResult> {
    if (options.signal?.aborted) throw abortError();

    let state: MastraExecutionState;
    try {
      state = normalizeInput(input);
    } catch {
      return invalidResult(input);
    }

    const parsed = mastraExecutionStateSchema.safeParse(state);
    if (!parsed.success) return invalidResult(input);
    state = parsed.data;

    // The workflow is intentionally only started for active executions. This
    // preserves terminal state on resume/preflight calls and avoids forcing a
    // do-while iteration for already terminal input.
    if (state.status !== "running") return stateToResult(state);

    const invoker = options.invoker ?? this.defaultInvoker;
    if (!invoker) return stateToResult(failedState(state, "INTERNAL_ERROR"));

    const selector: OrchestrationParticipantSelector =
      options.selectNextParticipant ??
      ((selection) => this.selectNextParticipant(selection));

    const failureContext: { stepFailure?: StepFailureContext } = {};
    const workflow = createMastraOrchestrationWorkflow({
      id: `mastra-${state.sessionId}`,
      invoker,
      perAgentTimeoutMs: timeoutFor(options),
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.orchestrationId === undefined
        ? {}
        : { orchestrationId: options.orchestrationId }),
      ...(options.supervisorTimeoutMs === undefined
        ? {}
        : { supervisorTimeoutMs: options.supervisorTimeoutMs }),
      ...(options.participantProfiles === undefined
        ? {}
        : { participantProfiles: options.participantProfiles }),
      ...(options.handoffLimits === undefined
        ? {}
        : { handoffLimits: options.handoffLimits }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      onStepFailure: ({ error, errorCode }) => {
        failureContext.stepFailure = { error, errorCode };
      },
      selectNextParticipant: selector,
    });

    let workflowRun;
    try {
      workflowRun = await workflow.createRun();
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw abortError();
      return stateToResult(failedState(state, classifyFailure(error, state.mode)));
    }

    let cancellation: Promise<void> | undefined;
    const requestCancellation = (): void => {
      if (cancellation) return;
      try {
        cancellation = workflowRun.cancel().catch(() => undefined);
      } catch {
        cancellation = Promise.resolve();
      }
    };
    const onAbort = (): void => requestCancellation();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) requestCancellation();

    try {
      const workflowResult = (await workflowRun.start({
        inputData: state,
      })) as unknown as WorkflowResultLike;
      if (cancellation) await cancellation;
      if (options.signal?.aborted) throw abortError();

      if (workflowResult.status === "success") {
        return stateToResult(workflowResultState(workflowResult, state));
      }

      const error =
        failureContext.stepFailure?.error ?? workflowResultError(workflowResult);
      const errorCode =
        failureContext.stepFailure?.errorCode ?? classifyFailure(error, state.mode);
      return stateToResult(failedState(state, errorCode));
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw abortError();
      const originalError = failureContext.stepFailure?.error ?? error;
      const errorCode =
        failureContext.stepFailure?.errorCode ??
        classifyFailure(originalError, state.mode);
      return stateToResult(failedState(state, errorCode));
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (cancellation) await cancellation;
    }
  }
}
