import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { HttpError, RetryableModelError, RunCancelledError } from "./errors.js";
import { AgentRuntimePromptComposer } from "./agent-runtime-prompt.js";
import type { WorkerRuntimeModelConfig } from "./models/types.js";
import {
  type ProjectExecutionScope,
  type ProjectRunBinding,
} from "./projects/project-execution.js";
import {
  McpSessionService,
  type MintedMcpSession,
} from "./tools/mcp-session-service.js";
import type { RuntimeTelemetry, TelemetrySpan } from "./telemetry/telemetry-types.js";
import { correlationAttributes } from "./telemetry/telemetry-types.js";
import { usageAttributes } from "./telemetry/telemetry-usage.js";
import type {
  Agent,
  AgentConversation,
  AgentModelSnapshot,
  AgentRun,
  AgentRunner,
  MessageOrigin,
  RunnerResult,
} from "./types.js";
import { JsonStore } from "./store.js";
import { safeRuntimeError } from "./safe-runtime-error.js";
import type {
  AuditEventInput,
  AuditRecorder,
  AuditSpan,
} from "./audit/audit-types.js";
import { newSpanId } from "./audit/audit-span.js";
import {
  createRuntimeActionObserver,
  type RuntimeActionObserver,
} from "./audit/runtime-action-audit.js";
import {
  createSandboxAuditSink,
  type SandboxAuditSink,
} from "./audit/sandbox-audit.js";
import { agentPrincipal } from "./access/access-types.js";

const RUN_POLL_INTERVAL_MS = 50;
const now = () => new Date().toISOString();

function isTerminalRun(run: AgentRun): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

function waitError(name: "AbortError" | "TimeoutError", message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function modelRefForRuntime(runtimeModel: WorkerRuntimeModelConfig) {
  return {
    providerId: runtimeModel.providerId,
    modelId: runtimeModel.modelId,
  };
}

export interface AgentRunCoordinatorDependencies {
  config: AppConfig;
  store: JsonStore;
  runner: AgentRunner;
  prompt: AgentRuntimePromptComposer;
  getProjectScope: () => ProjectExecutionScope | undefined;
  getMcpSessions: () => McpSessionService | undefined;
  getTelemetry: () => RuntimeTelemetry | undefined;
  /** Optional server-owned audit sink for fallback usage events. */
  getAudit?: () => AuditRecorder | undefined;
  getRun: (runId: string) => AgentRun;
}

/**
 * Coordinates one Agent's active Run and cancellation state.
 *
 * AgentService remains the public facade and owns Agent/Project CRUD. This
 * module owns the temporal protocol around a running turn: register before
 * cancellation can observe it, persist terminal state, release a Project
 * lease, and revoke the per-run MCP session on every exit path.
 */
export class AgentRunCoordinator {
  private readonly activeExecutions = new Map<
    string,
    { runId: string; execution: Promise<void> }
  >();
  private readonly cancellationRequests = new Set<string>();
  private readonly runCancellations = new Map<string, Promise<AgentRun>>();
  private readonly agentCancellationLocks = new Set<string>();
  /** Audit span of each in-flight Run, so runtime events can parent under it. */
  private readonly runSpans = new Map<string, AuditSpan>();

  constructor(private readonly dependencies: AgentRunCoordinatorDependencies) {}

  isCancelling(agentId: string): boolean {
    return this.agentCancellationLocks.has(agentId);
  }

  /** The audit span of a currently executing Run, if one is in flight. */
  runSpan(runId: string): AuditSpan | undefined {
    const span = this.runSpans.get(runId);
    return span === undefined ? undefined : { ...span };
  }

  /** An audit sink failure must never change the outcome of a Run. */
  private async recordAudit(input: AuditEventInput): Promise<void> {
    const audit = this.dependencies.getAudit?.();
    if (!audit) return;
    await audit.record(input).catch((error) => {
      console.warn("audit write failed", error);
    });
  }

  /** Starts and registers a Run after the facade has persisted its queue record. */
  start(
    agentAtStart: Agent,
    run: AgentRun,
    runtimeModel: WorkerRuntimeModelConfig,
    projectId?: string,
    origin: MessageOrigin = "direct",
    conversation: AgentConversation | null = null,
    orchestrationId?: string,
    fallbackModels: readonly WorkerRuntimeModelConfig[] = [],
    modelSnapshot?: AgentModelSnapshot,
    parentSpan?: { traceId: string; spanId: string },
  ): void {
    const execution = this.executeRun(
      agentAtStart,
      run,
      runtimeModel,
      projectId,
      origin,
      conversation,
      orchestrationId,
      fallbackModels,
      modelSnapshot,
      parentSpan,
    );
    this.activeExecutions.set(agentAtStart.id, { runId: run.id, execution });
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentAtStart.id)?.runId === run.id) {
          this.activeExecutions.delete(agentAtStart.id);
        }
      })
      .catch(() => undefined);
  }

  async waitForRun(
    runId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<AgentRun> {
    const timeoutMs = options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative finite number");
    }

    const initial = this.dependencies.getRun(runId);
    if (isTerminalRun(initial)) return initial;
    if (options.signal?.aborted) {
      throw waitError("AbortError", "Waiting for Run " + runId + " was aborted");
    }

    return new Promise<AgentRun>((resolve, reject) => {
      let settled = false;
      let interval: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (interval) clearInterval(interval);
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };

      const settle = (settler: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        settler();
      };

      const poll = () => {
        try {
          const current = this.dependencies.getRun(runId);
          if (isTerminalRun(current)) {
            settle(() => resolve(current));
          }
        } catch (error) {
          settle(() => reject(error));
        }
      };

      const onAbort = () => {
        settle(() =>
          reject(waitError("AbortError", "Waiting for Run " + runId + " was aborted")),
        );
      };

      options.signal?.addEventListener("abort", onAbort, { once: true });
      interval = setInterval(poll, RUN_POLL_INTERVAL_MS);
      interval.unref();
      timeout = setTimeout(() => {
        settle(() =>
          reject(
            waitError(
              "TimeoutError",
              "Run " + runId + " did not finish within " + timeoutMs + " ms",
            ),
          ),
        );
      }, timeoutMs);
      timeout.unref();
      poll();
    });
  }

  async cancelRun(runId: string): Promise<AgentRun> {
    const existing = this.runCancellations.get(runId);
    if (existing) return existing;

    const cancellation = this.cancelRunInternal(runId);
    this.runCancellations.set(runId, cancellation);
    try {
      return await cancellation;
    } finally {
      if (this.runCancellations.get(runId) === cancellation) {
        this.runCancellations.delete(runId);
      }
    }
  }

  async cancelExecution(agentId: string): Promise<void> {
    const active = this.activeExecutions.get(agentId);
    if (!active) {
      await this.dependencies.runner.cancel(agentId);
      return;
    }

    this.agentCancellationLocks.add(agentId);
    this.cancellationRequests.add(active.runId);
    try {
      await this.dependencies.runner.cancel(agentId);
      await active.execution;
    } finally {
      this.cancellationRequests.delete(active.runId);
      this.agentCancellationLocks.delete(agentId);
    }
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    runtimeModel: WorkerRuntimeModelConfig,
    projectId?: string,
    origin: MessageOrigin = "direct",
    conversation: AgentConversation | null = null,
    orchestrationId?: string,
    fallbackModels: readonly WorkerRuntimeModelConfig[] = [],
    modelSnapshot?: AgentModelSnapshot,
    parentSpan?: { traceId: string; spanId: string },
  ): Promise<void> {
    const telemetry = this.dependencies.getTelemetry();
    const attributes = correlationAttributes({
      principalKind: "agent",
      principalId: agentAtStart.id,
      agentId: agentAtStart.id,
      ...(projectId === undefined ? {} : { projectId }),
      runId: run.id,
      ...(orchestrationId === undefined ? {} : { orchestrationId }),
    });
    if (telemetry) {
      await telemetry.withSpan(
        "agent.run",
        {
          ...attributes,
          "llm.system": "codex-cli",
          "gen_ai.system": "codex",
          "gen_ai.request.model": runtimeModel.codexModel,
        },
        (span) => this.executeRunInternal(
          agentAtStart,
          run,
          runtimeModel,
          projectId,
          origin,
          conversation,
          orchestrationId,
          fallbackModels,
          modelSnapshot,
          span,
          parentSpan,
        ),
      );
      return;
    }
    await this.executeRunInternal(
      agentAtStart,
      run,
      runtimeModel,
      projectId,
      origin,
      conversation,
      orchestrationId,
      fallbackModels,
      modelSnapshot,
      undefined,
      parentSpan,
    );
  }

  private async executeRunInternal(
    agentAtStart: Agent,
    run: AgentRun,
    runtimeModel: WorkerRuntimeModelConfig,
    projectId?: string,
    origin: MessageOrigin = "direct",
    conversation: AgentConversation | null = null,
    orchestrationId?: string,
    fallbackModels: readonly WorkerRuntimeModelConfig[] = [],
    modelSnapshot?: AgentModelSnapshot,
    runSpan?: TelemetrySpan,
    parentSpan?: { traceId: string; spanId: string },
  ): Promise<void> {
    const startedAt = now();
    await this.dependencies.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = startedAt;
      }
    });
    // One span identity for the whole Run: every lifecycle event of this turn
    // shares it, and runtime events can parent under it via runSpan().
    const auditSpan: AuditSpan = {
      traceId:
        parentSpan?.traceId ??
        (orchestrationId !== undefined ? orchestrationId : run.id),
      spanId: newSpanId(),
      ...(parentSpan?.spanId === undefined
        ? {}
        : { parentSpanId: parentSpan.spanId }),
    };
    this.runSpans.set(run.id, auditSpan);
    const correlation = {
      agentId: agentAtStart.id,
      ...(projectId === undefined ? {} : { projectId }),
      runId: run.id,
      ...(orchestrationId === undefined ? {} : { orchestrationId }),
      principal: agentPrincipal(agentAtStart.id),
      span: auditSpan,
    } as const;
    await this.recordAudit({
      ...correlation,
      type: "run_started",
      status: "success",
      summary: "Run started",
      metadata: {
        model: runtimeModel.modelId,
        providerId: runtimeModel.providerId,
        fallbackCount: fallbackModels.length,
        origin,
        hasProject: projectId !== undefined,
      },
    });
    // Held for the whole turn when the run is Project-scoped. The lease and
    // the shared-scope thread are settled in the finally below.
    let binding: ProjectRunBinding | null = null;
    let outcome: { codexThreadId: string | null } | null = null;
    let mintedMcpSession: MintedMcpSession | null = null;
    try {
      if (this.cancellationRequests.has(run.id)) {
        throw new RunCancelledError();
      }
      if (projectId !== undefined) {
        binding = await this.requireProjectScope().beginTurn(
          agentAtStart,
          projectId,
          run.id,
        );
        // Role changes can happen after acceptance or while waiting for the
        // Project lease. Recheck immediately before invoking the runner.
        await this.requireProjectScope().assertRunnable(projectId, agentAtStart.id);
      }
      const executionPrompt = await this.dependencies.prompt.compose(
        agentAtStart,
        run.prompt,
        binding,
        projectId,
        run.id,
        orchestrationId,
      );
      // Mint as late as possible: the opaque token exists only for the child
      // run and is revoked on every completion/failure/cancellation path.
      let mcpUrl: string | undefined;
      const traceCarrier: Record<string, string> = {};
      const telemetry = this.dependencies.getTelemetry();
      telemetry?.inject(traceCarrier);
      const mcpSessions = this.dependencies.getMcpSessions();
      if (mcpSessions) {
        mcpUrl = this.mcpUrl();
        mintedMcpSession = mcpSessions.mint({
          agentId: agentAtStart.id,
          ...(projectId === undefined ? {} : { projectId }),
          runId: run.id,
          ...(orchestrationId === undefined ? {} : { orchestrationId }),
          ...(traceCarrier.traceparent === undefined
            ? {}
            : { traceparent: traceCarrier.traceparent }),
        });
      }
      const initialThreadId = binding
        ? binding.codexThreadId
        : conversation
          ? conversation.codexThreadId
          : agentAtStart.codexThreadId;
      const assignmentSnapshot =
        modelSnapshot === undefined && run.modelSnapshot === undefined
          ? undefined
          : structuredClone(modelSnapshot ?? run.modelSnapshot);
      // One tap per Run: worker stdout events are audited as children of the
      // Run span. Omitted entirely when no audit sink is configured.
      const auditSink = this.dependencies.getAudit?.();
      const observer: RuntimeActionObserver | undefined = auditSink
        ? createRuntimeActionObserver({
            audit: auditSink,
            runId: run.id,
            agentId: agentAtStart.id,
            ...(projectId === undefined ? {} : { projectId }),
            ...(orchestrationId === undefined ? {} : { orchestrationId }),
            parentSpan: auditSpan,
          })
        : undefined;
      const sandboxAudit: SandboxAuditSink | undefined = auditSink
        ? createSandboxAuditSink({
            audit: auditSink,
            runId: run.id,
            agentId: agentAtStart.id,
            ...(projectId === undefined ? {} : { projectId }),
            ...(orchestrationId === undefined ? {} : { orchestrationId }),
            parentSpan: auditSpan,
          })
        : undefined;
      const modelAttempts = [runtimeModel, ...fallbackModels];
      let result: RunnerResult | undefined;
      let selectedModelIndex = -1;
      let lastModelError: unknown;
      for (const [modelIndex, attempt] of modelAttempts.entries()) {
        if (this.cancellationRequests.has(run.id)) {
          throw new RunCancelledError();
        }
        try {
          result = await this.dependencies.runner.run({
            agentId: agentAtStart.id,
            runId: run.id,
            workspacePath: binding?.workspacePath ?? agentAtStart.workspacePath,
            ...(projectId === undefined ? {} : { projectId }),
            prompt: executionPrompt,
            // A Codex thread is provider/model-specific. A fallback starts a
            // fresh thread rather than attempting to resume the failed model's
            // conversation with a different model.
            threadId: modelIndex === 0 ? initialThreadId : null,
            model: attempt,
            ...(observer === undefined ? {} : { observer }),
            ...(sandboxAudit === undefined ? {} : { sandboxAudit }),
            ...(assignmentSnapshot === undefined
              ? {}
              : { modelSnapshot: structuredClone(assignmentSnapshot) }),
            ...(mcpUrl === undefined || mintedMcpSession === null
              ? {}
              : {
                  mcp: {
                    url: mcpUrl,
                    token: mintedMcpSession.token,
                    ...(mintedMcpSession.context.traceparent === undefined
                      ? {}
                      : { traceparent: mintedMcpSession.context.traceparent }),
                  },
                }),
          });
          selectedModelIndex = modelIndex;
          break;
        } catch (error) {
          if (
            error instanceof RunCancelledError ||
            this.cancellationRequests.has(run.id)
          ) {
            throw error;
          }
          // A generic runner failure may already have changed the workspace
          // or invoked a tool. Only a runner-authored, explicitly typed
          // pre-execution/model-availability signal is safe to retry.
          if (!(error instanceof RetryableModelError)) throw error;
          lastModelError = error;
          if (modelIndex === modelAttempts.length - 1) throw error;
          const nextAttempt = modelAttempts[modelIndex + 1];
          if (nextAttempt !== undefined) {
            await this.recordAudit({
              ...correlation,
              type: "run_retried",
              status: "success",
              summary: "Retrying the Run on the next worker model",
              metadata: {
                fromModel: attempt.modelId,
                toModel: nextAttempt.modelId,
                attemptIndex: modelIndex + 1,
                retryOfRunId: run.id,
              },
            });
          }
        }
      }
      if (result === undefined) {
        throw lastModelError ?? new Error("No worker model attempt completed");
      }
      const selectedModelRef = assignmentSnapshot
        ? selectedModelIndex === 0
          ? assignmentSnapshot.modelRef
          : assignmentSnapshot.fallbackModelRefs[selectedModelIndex - 1] ??
            modelRefForRuntime(modelAttempts[selectedModelIndex] ?? runtimeModel)
        : modelRefForRuntime(modelAttempts[selectedModelIndex] ?? runtimeModel);
      runSpan?.setAttributes({
        ...usageAttributes(result.usage),
        "gen_ai.response.model": (modelAttempts[selectedModelIndex] ?? runtimeModel).codexModel,
        ...(selectedModelIndex > 0
          ? { "launchpad.model.fallback_index": selectedModelIndex }
          : {}),
      });
      runSpan?.setStatus("ok");
      const completedAt = now();
      let persistedCompletion = false;
      let cancelledWhileCompleting = false;
      await this.dependencies.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        if (isTerminalRun(storedRun)) return;
        if (this.cancellationRequests.has(run.id)) {
          cancelledWhileCompleting = true;
          storedRun.status = "cancelled";
          storedRun.error = "Run cancelled";
          storedRun.completedAt = completedAt;
          if (agent.status !== "stopped") agent.status = "ready";
          agent.lastError = null;
          agent.updatedAt = completedAt;
          return;
        }
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.modelUsed = structuredClone(selectedModelRef);
        if (selectedModelIndex > 0) {
          storedRun.fallbackUsed = {
            index: selectedModelIndex,
            modelRef: structuredClone(selectedModelRef),
          };
        }
        storedRun.completedAt = completedAt;
        persistedCompletion = true;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          origin,
          ...(conversation === null ? {} : { conversationId: conversation.id }),
          createdAt: completedAt,
        });
        agent.status = "ready";
        if (binding === null && conversation === null) {
          // A Team turn with no Project: the Agent-level session is its scope.
          agent.codexThreadId = result.threadId;
        }
        if (conversation !== null) {
          const storedConversation = database.agentConversations.find(
            (item) => item.id === conversation.id,
          );
          if (storedConversation) {
            storedConversation.codexThreadId = result.threadId;
            storedConversation.updatedAt = completedAt;
          }
        }
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      if (selectedModelIndex > 0 && persistedCompletion) {
        await this.recordAudit({
          ...correlation,
          type: "model_fallback",
          status: "success",
          summary: "Worker model fallback used",
          metadata: {
            fallbackIndex: selectedModelIndex,
            primaryModel: runtimeModel.modelId,
            selectedModel: (modelAttempts[selectedModelIndex] ?? runtimeModel).modelId,
          },
        });
      }
      const durationMs = Math.max(
        0,
        Date.parse(completedAt) - Date.parse(startedAt),
      );
      if (cancelledWhileCompleting) {
        await this.recordAudit({
          ...correlation,
          type: "run_cancelled",
          status: "success",
          summary: "Run cancelled",
          durationMs,
          metadata: { exitReason: "cancelled" },
        });
      } else if (persistedCompletion) {
        await this.recordAudit({
          ...correlation,
          type: "run_completed",
          status: "success",
          summary: "Run completed",
          durationMs,
          metadata: {
            ...(result.usage?.inputTokens === undefined
              ? {}
              : { inputTokens: result.usage.inputTokens }),
            ...(result.usage?.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: result.usage.cachedInputTokens }),
            ...(result.usage?.outputTokens === undefined
              ? {}
              : { outputTokens: result.usage.outputTokens }),
            modelUsed: selectedModelRef.modelId,
            ...(selectedModelIndex > 0
              ? { fallbackIndex: selectedModelIndex }
              : {}),
            exitReason: "completed",
          },
        });
      }
      if (binding !== null) outcome = { codexThreadId: result.threadId };
    } catch (error) {
      const completedAt = now();
      const cancelled =
        error instanceof RunCancelledError || this.cancellationRequests.has(run.id);
      runSpan?.setStatus(cancelled ? "ok" : "error");
      const message = safeRuntimeError(error);
      await this.dependencies.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun && isTerminalRun(storedRun)) {
          if (agent) {
            if (agent.status !== "stopped") agent.status = "ready";
            agent.updatedAt = completedAt;
          }
          return;
        }
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = cancelled ? "Run cancelled" : message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      const durationMs = Math.max(
        0,
        Date.parse(completedAt) - Date.parse(startedAt),
      );
      // The error message can carry a path or prompt fragment; only its class
      // is safe evidence.
      await this.recordAudit(
        cancelled
          ? {
              ...correlation,
              type: "run_cancelled",
              status: "success",
              summary: "Run cancelled",
              durationMs,
              metadata: { exitReason: "cancelled" },
            }
          : {
              ...correlation,
              type: "run_failed",
              status: "failure",
              summary: "Run failed",
              durationMs,
              metadata: {
                exitReason: "error",
                errorClass:
                  (error as { constructor?: { name?: string } } | null)
                    ?.constructor?.name ?? "Error",
              },
            },
      );
    } finally {
      this.runSpans.delete(run.id);
      // The write lease must never outlive its turn, on any path: success,
      // failure, cancellation, or a runner that threw before producing output.
      if (binding !== null) {
        await this.requireProjectScope()
          .endTurn(binding.projectId, agentAtStart.id, run.id, outcome)
          .catch(() => undefined);
      }
      if (mintedMcpSession !== null) {
        this.dependencies.getMcpSessions()?.revoke(mintedMcpSession.token);
      }
    }
  }

  private async cancelRunInternal(runId: string): Promise<AgentRun> {
    const initial = this.dependencies.getRun(runId);
    if (isTerminalRun(initial)) return initial;

    const active = this.activeExecutions.get(initial.agentId);
    if (!active || active.runId !== runId) {
      const current = this.dependencies.getRun(runId);
      if (isTerminalRun(current)) return current;
      throw new HttpError(409, "Run is not currently active");
    }

    this.agentCancellationLocks.add(initial.agentId);
    this.cancellationRequests.add(runId);
    try {
      await this.dependencies.runner.cancel(initial.agentId);
      await active.execution;
      return this.dependencies.getRun(runId);
    } finally {
      this.cancellationRequests.delete(runId);
      this.agentCancellationLocks.delete(initial.agentId);
    }
  }

  private requireProjectScope(): ProjectExecutionScope {
    const projectScope = this.dependencies.getProjectScope();
    if (!projectScope) {
      throw new HttpError(503, "Project execution is not configured");
    }
    return projectScope;
  }

  /** Resolve the worker-reachable MCP URL without exposing it in prompts. */
  private mcpUrl(): string {
    if (this.dependencies.config.runtimeProvider === "container") {
      const configured = this.dependencies.config.mcpContainerUrl;
      if (!configured) {
        throw new HttpError(
          503,
          "MCP tools are enabled but MCP_CONTAINER_URL is not configured",
        );
      }
      return configured;
    }
    return this.dependencies.config.mcpPublicUrl;
  }
}
