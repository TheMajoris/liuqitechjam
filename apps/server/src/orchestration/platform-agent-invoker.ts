import type { AgentService } from "../agent-service.js";

export interface PlatformAgentInvokerInput {
  agentId: string;
  prompt: string;
  /** Scopes the child Run to a shared Project workspace when present. */
  projectId?: string | undefined;
  /** Correlates this child Run with its parent orchestration. */
  orchestrationId?: string | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called after the platform accepts the child Run, before waiting for it. */
  onRunAccepted?: (runId: string) => void | Promise<void>;
}

export interface PlatformAgentInvokerContract {
  invoke(input: PlatformAgentInvokerInput): Promise<{ runId: string; output: string }>;
  cancel(runId: string): Promise<void>;
}

type AgentServiceBridge = Pick<
  AgentService,
  "sendMessage" | "waitForRun" | "cancelRun"
>;

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
    // Every Team turn is tagged at this boundary. The prompt still reaches
    // AgentService and the runner unchanged — only the Playground projection
    // excludes it, because the orchestrator authored it, not the user.
    const accepted = await this.service.sendMessage(input.agentId, input.prompt, {
      origin: "orchestration",
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.orchestrationId === undefined ? {} : { orchestrationId: input.orchestrationId }),
    });
    let run;
    try {
      await input.onRunAccepted?.(accepted.run.id);
      if (input.signal?.aborted) {
        const error = new Error(
          "Waiting for Run " + accepted.run.id + " was aborted",
        );
        error.name = "AbortError";
        throw error;
      }
      run = await this.service.waitForRun(accepted.run.id, {
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
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
      throw new Error(
        "Agent Run " +
          run.id +
          " " +
          run.status +
          (run.error ? ": " + run.error : ""),
      );
    }
    if (run.output === null || run.output.trim().length === 0) {
      throw new Error("Agent Run " + run.id + " completed without output");
    }
    return { runId: run.id, output: run.output };
  }

  async cancel(runId: string): Promise<void> {
    await this.service.cancelRun(runId);
  }
}

// Keep the adapter name explicit for callers that distinguish the platform
// service implementation from the generic invoker seam.
export { PlatformAgentInvoker as AgentServicePlatformAgentInvoker };
