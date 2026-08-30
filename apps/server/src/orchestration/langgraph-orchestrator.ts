import {
  getOrchestrationRecursionLimit,
  runOrchestrationGraph,
  type OrchestrationGraphRunOptions,
} from "./graph.js";
import type {
  OrchestrationExecutionInput,
  OrchestrationExecutionOptions,
  OrchestrationExecutionResult,
  Orchestrator,
} from "./orchestrator.js";

function abortError(): Error {
  const error = new Error("Orchestration stopped");
  error.name = "AbortError";
  return error;
}

function supervisorUnavailableResult(
  input: OrchestrationExecutionInput,
): OrchestrationExecutionResult {
  return {
    sessionId: input.sessionId,
    originalPrompt: input.originalPrompt,
    participants: input.participants.map((participant) => ({ ...participant })),
    mode: input.mode,
    completionReason: null,
    stepIndex: input.stepIndex ?? 0,
    maxSteps: input.maxSteps,
    lastRunId: input.lastRunId ?? null,
    lastOutput: input.lastOutput ?? null,
    turns: input.turns ? input.turns.map((turn) => ({ ...turn })) : [],
    status: "failed",
    errorCode: "SUPERVISOR_UNAVAILABLE",
  };
}

/**
 * Compatibility runner shape retained for callers that injected the old
 * graphRunner test seam. It is intentionally expressed in application-owned
 * types so the service does not depend on LangGraph APIs.
 */
export type LangGraphOrchestrationRunner = (
  input: OrchestrationExecutionInput,
  options: OrchestrationExecutionOptions & {
    recursionLimit?: number | undefined;
  },
) => Promise<OrchestrationExecutionResult>;

/**
 * Adapts the current LangGraph implementation to the repository-owned
 * Orchestrator contract. LangGraph-specific recursion settings stay inside
 * this adapter and are derived from the authoritative maxSteps guard.
 */
export class LangGraphOrchestrator implements Orchestrator {
  constructor(
    private readonly runner: LangGraphOrchestrationRunner = runOrchestrationGraph,
  ) {}

  run(
    input: OrchestrationExecutionInput,
    options: OrchestrationExecutionOptions,
  ): Promise<OrchestrationExecutionResult> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    // LangGraph is retained as a deterministic rollback engine.  Never let
    // a supervisor mode silently fall back to roster order when an explicit
    // rollback implementation is selected.
    if ((input.mode ?? "sequential") === "supervisor") {
      return Promise.resolve(supervisorUnavailableResult(input));
    }
    const runnerOptions: OrchestrationGraphRunOptions = {
      invoker: options.invoker,
      recursionLimit: getOrchestrationRecursionLimit(input.maxSteps),
      ...(options.perAgentTimeoutMs === undefined
        ? {}
        : { perAgentTimeoutMs: options.perAgentTimeoutMs }),
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.orchestrationId === undefined
        ? {}
        : { orchestrationId: options.orchestrationId }),
      ...(options.handoffLimits === undefined
        ? {}
        : { handoffLimits: options.handoffLimits }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    };
    return this.runner(input, runnerOptions);
  }
}
