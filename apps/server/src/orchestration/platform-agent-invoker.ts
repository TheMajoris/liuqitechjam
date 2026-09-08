import type { AgentService } from "../agent-service.js";
import { isAuthorizationError } from "../access/authorization-service.js";
import { ProjectPermissionDeniedError } from "../errors.js";

export interface PlatformAgentInvokerInput {
  agentId: string;
  prompt: string;
  /** Scopes the child Run to a shared Project workspace when present. */
  projectId?: string | undefined;
  /** Correlates this child Run with its parent orchestration. */
  orchestrationId?: string | undefined;
  /** Audit span of the dispatching participant; the child Run parents under it. */
  parentSpan?: { traceId: string; spanId: string } | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Absolute deadline for this participant operation, including acceptance. */
  deadlineAt?: number;
  /** Called after the platform accepts the child Run, before waiting for it. */
  onRunAccepted?: (runId: string) => void | Promise<void>;
}

export interface PlatformAgentInvokerContract {
  invoke(input: PlatformAgentInvokerInput): Promise<{ runId: string; output: string }>;
  cancel(runId: string): Promise<void>;
  /** Physical-only cancellation for storage-fatal shutdown. */
  cancelForStorageFailure?(runId: string): Promise<void>;
}

type AgentServiceBridge = Pick<
  AgentService,
  "sendMessage" | "waitForRun" | "cancelRun"
> & {
  cancelRunForStorageFailure?: (runId: string) => Promise<void>;
};

interface OperationSignal {
  signal: AbortSignal;
  deadlineAt: number;
  dispose: () => void;
}

function waitError(name: "AbortError" | "TimeoutError", message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function operationError(
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Error | undefined {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
      return reason;
    }
    return waitError("AbortError", "Participant operation was aborted");
  }
  if (Date.now() >= deadlineAt) {
    return waitError("TimeoutError", "Participant operation timed out");
  }
  return undefined;
}

/**
 * Gives acceptance and waiting one signal whose timer starts before the
 * platform sendMessage call. The caller owns the controller for the whole
 * invocation, so an accepted Run can still be cancelled if sendMessage
 * returns after the deadline.
 */
function createOperationSignal(
  inputSignal: AbortSignal | undefined,
  deadlineAt: number,
): OperationSignal {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(inputSignal?.reason);
  };
  if (inputSignal) {
    inputSignal.addEventListener("abort", onAbort, { once: true });
    if (inputSignal.aborted) onAbort();
  }
  if (!controller.signal.aborted) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      controller.abort(waitError("TimeoutError", "Participant operation timed out"));
    } else {
      timeout = setTimeout(() => {
        controller.abort(waitError("TimeoutError", "Participant operation timed out"));
      }, remaining);
      timeout.unref();
    }
  }
  return {
    signal: controller.signal,
    deadlineAt,
    dispose: () => {
      if (timeout) clearTimeout(timeout);
      inputSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Adapts the platform AgentService to the orchestration worker seam.
 *
 * Orchestration code intentionally sees only accepted Run IDs and terminal
 * output. The AgentRunner remains an implementation detail of AgentService.
 */
export class PlatformAgentInvoker implements PlatformAgentInvokerContract {
  constructor(private readonly service: AgentServiceBridge) {}

  async invoke(
    input: PlatformAgentInvokerInput,
  ): Promise<{ runId: string; output: string }> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative finite number");
    }
    // Establish the absolute budget before sendMessage. This is deliberately
    // not a Promise.race: the platform call may accept a Run after a timer
    // fires, and that accepted Run must be explicitly cancelled and settled.
    const deadlineAt =
      input.deadlineAt !== undefined && Number.isFinite(input.deadlineAt)
        ? input.deadlineAt
        : Date.now() + input.timeoutMs;
    const operation = createOperationSignal(input.signal, deadlineAt);
    // Every Team turn is tagged at this boundary. The prompt still reaches
    // AgentService and the runner unchanged — only the Playground projection
    // excludes it, because the orchestrator authored it, not the user.
    try {
      let accepted: Awaited<ReturnType<AgentService["sendMessage"]>>;
      try {
        accepted = await this.service.sendMessage(input.agentId, input.prompt, {
          origin: "orchestration",
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.orchestrationId === undefined ? {} : { orchestrationId: input.orchestrationId }),
          ...(input.parentSpan === undefined ? {} : { parentSpan: input.parentSpan }),
          signal: operation.signal,
          deadlineAt: operation.deadlineAt,
        });
      } catch (error) {
        // Project authorization is checked before AgentService creates a Run.
        // Replace only that trusted error class with a fixed orchestration code;
        // never copy its reason, which may contain policy or resource details.
        if (input.projectId !== undefined && isAuthorizationError(error)) {
          throw new ProjectPermissionDeniedError();
        }
        throw error;
      }

      let run;
      try {
        await input.onRunAccepted?.(accepted.run.id);
        const beforeWait = operationError(operation.signal, operation.deadlineAt);
        if (beforeWait) throw beforeWait;
        const remainingTimeoutMs = operation.deadlineAt - Date.now();
        if (remainingTimeoutMs <= 0) {
          throw waitError(
            "TimeoutError",
            "Run " + accepted.run.id + " did not finish within the participant deadline",
          );
        }
        run = await this.service.waitForRun(accepted.run.id, {
          timeoutMs: remainingTimeoutMs,
          signal: operation.signal,
        });
        const afterWait = operationError(operation.signal, operation.deadlineAt);
        if (afterWait) throw afterWait;
      } catch (error) {
        // A timed-out or aborted wait must not leave the accepted child Run
        // running in the background. Preserve the original wait failure even
        // if cleanup itself cannot complete.
        try {
          await this.service.cancelRun(accepted.run.id);
        } catch {
          // The original failure is more actionable to the orchestration layer.
        }
        throw error;
      }

      if (run.status !== "completed") {
        const error = new Error(
          "Agent Run " +
            run.id +
            " " +
            run.status +
            (run.error ? ": " + run.error : ""),
        );
        // Preserve server-owned lifecycle codes across the orchestration
        // boundary. Consumers classify this field directly and never need to
        // infer a web permission denial from persisted prose.
        if (run.errorCode !== undefined) {
          Object.assign(error, { orchestrationErrorCode: run.errorCode });
        }
        throw error;
      }
      if (run.output === null || run.output.trim().length === 0) {
        throw new Error("Agent Run " + run.id + " completed without output");
      }
      return { runId: run.id, output: run.output };
    } finally {
      operation.dispose();
    }
  }

  async cancel(runId: string): Promise<void> {
    await this.service.cancelRun(runId);
  }

  async cancelForStorageFailure(runId: string): Promise<void> {
    // Keep the optional runtime check for older/fake bridges while production
    // AgentService always supplies the memory-first method.
    if (typeof this.service.cancelRunForStorageFailure === "function") {
      await this.service.cancelRunForStorageFailure(runId);
      return;
    }
    await this.service.cancelRun(runId);
  }
}

// Keep the adapter name explicit for callers that distinguish the platform
// service implementation from the generic invoker seam.
export { PlatformAgentInvoker as AgentServicePlatformAgentInvoker };
