import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import {
  HttpError,
  MODEL_INFERENCE_LIMIT_EXCEEDED,
  RetryableModelError,
  RunCancelledError,
  WEB_TOOL_PERMISSION_DENIED,
  WebToolPermissionDeniedError,
} from "./errors.js";
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
  OperationOptions,
  RunnerResult,
} from "./types.js";
import type { Storage } from "./store.js";
import type { ApplicationLifecycleFailure } from "./application-health.js";
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
const STORAGE_QUIESCE_TIMEOUT_MS = 5_000;
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

/**
 * Bound a shutdown/quiescence observer without detaching the owned operation.
 * All promise branches are observed, and the operation continues its own
 * cleanup after the observer's deadline if physical settlement is slower.
 */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const boundedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : STORAGE_QUIESCE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), boundedTimeout);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface RunControl {
  operation: OperationOptions;
  controller: AbortController;
  dispose: () => void;
}

function createRunControl(operation: OperationOptions): RunControl {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(operation.signal?.reason);
  };
  operation.signal?.addEventListener("abort", onAbort, { once: true });
  if (operation.signal?.aborted) onAbort();
  return {
    operation: { ...operation, signal: controller.signal },
    controller,
    dispose: () => operation.signal?.removeEventListener("abort", onAbort),
  };
}

function modelRefForRuntime(runtimeModel: WorkerRuntimeModelConfig) {
  return {
    providerId: runtimeModel.providerId,
    modelId: runtimeModel.modelId,
  };
}

function runtimeErrorCode(error: unknown):
  | typeof WEB_TOOL_PERMISSION_DENIED
  | typeof MODEL_INFERENCE_LIMIT_EXCEEDED
  | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as {
    code?: unknown;
    errorCode?: unknown;
    orchestrationErrorCode?: unknown;
  };
  const candidate = record.errorCode ?? record.orchestrationErrorCode ?? record.code;
  return candidate === WEB_TOOL_PERMISSION_DENIED ||
    candidate === MODEL_INFERENCE_LIMIT_EXCEEDED
    ? candidate
    : undefined;
}

export interface AgentRunCoordinatorDependencies {
  config: AppConfig;
  store: Storage;
  runner: AgentRunner;
  prompt: AgentRuntimePromptComposer;
  getProjectScope: () => ProjectExecutionScope | undefined;
  getMcpSessions: () => McpSessionService | undefined;
  getTelemetry: () => RuntimeTelemetry | undefined;
  /** Optional server-owned audit sink for fallback usage events. */
  getAudit?: () => AuditRecorder | undefined;
  getRun: (runId: string) => AgentRun;
  /** Application-owned sink for failures that need lifecycle attention. */
  reportLifecycleFailure?: (failure: ApplicationLifecycleFailure) => void;
}

interface ActiveExecution {
  runId: string;
  run: AgentRun;
  execution: Promise<void>;
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
    ActiveExecution
  >();
  private readonly cancellationRequests = new Set<string>();
  private readonly runCancellations = new Map<string, Promise<AgentRun>>();
  private readonly agentCancellationLocks = new Set<string>();
  /** Abort signal owned by each registered execution, including preparation. */
  private readonly runControls = new Map<string, RunControl>();
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

  /**
   * Request physical cancellation from the process-local ownership table.
   *
   * This path is intentionally independent of Storage: a fatal database
   * transition can make getRun/snapshot unavailable while a local or container
   * worker is still capable of writing to a workspace. Every cancellation
   * request is made before the bounded wait; executions retain their locks
   * until their own finally blocks have actually settled.
   */
  async quiesceForStorageFailure(options: { timeoutMs?: number } = {}): Promise<void> {
    const active = [...this.activeExecutions.entries()];
    if (active.length === 0) return;

    const alreadyCancelling = new Map(
      active.map(([agentId]) => [agentId, this.agentCancellationLocks.has(agentId)]),
    );
    for (const [agentId, execution] of active) {
      this.agentCancellationLocks.add(agentId);
      this.cancellationRequests.add(execution.runId);
      this.runControls.get(execution.runId)?.controller.abort(new RunCancelledError());
    }

    const cancellations = active.map(async ([agentId, execution]) => {
      try {
        // A Team cancellation can arrive through the orchestration invoker at
        // the same time as this storage-fatal sweep. The lock is the existing
        // process-local ownership gate; only its first owner may invoke the
        // physical runner stop.
        if (!alreadyCancelling.get(agentId)) {
          await this.dependencies.runner.cancel(agentId);
        }
      } catch (error) {
        this.reportLifecycleFailure({
          code: "RUNTIME_CANCELLATION_FAILED",
          message: "Physical Agent runtime cancellation failed during storage recovery",
          runId: execution.runId,
          agentId,
        });
      }
      try {
        await execution.execution;
      } catch (error) {
        this.reportLifecycleFailure({
          code: "EXECUTION_FINALIZATION_FAILED",
          message: "Agent Run execution did not settle cleanly during storage recovery",
          runId: execution.runId,
          agentId,
        });
      } finally {
        // If the bounded caller has already returned, this delayed cleanup is
        // still required before the Agent can ever be considered reusable.
        if (this.activeExecutions.get(agentId)?.runId === execution.runId) {
          this.activeExecutions.delete(agentId);
        }
        this.cancellationRequests.delete(execution.runId);
        this.agentCancellationLocks.delete(agentId);
      }
    });

    await settleWithin(
      Promise.all(cancellations).then(() => undefined),
      options.timeoutMs ?? STORAGE_QUIESCE_TIMEOUT_MS,
    );
  }

  /**
   * Cancel one known in-memory child without consulting Storage. The
   * orchestration fatal-shutdown path uses this when its journal is already
   * unavailable; the ordinary user cancellation path keeps its read-backed
   * result semantics separately.
   */
  async cancelRunForStorageFailure(runId: string): Promise<void> {
    const inMemory = this.activeExecutionByRunId(runId);
    if (!inMemory) return;
    const { agentId, execution } = inMemory;
    const alreadyCancelling = this.agentCancellationLocks.has(agentId);
    this.agentCancellationLocks.add(agentId);
    this.cancellationRequests.add(runId);
    this.runControls.get(runId)?.controller.abort(new RunCancelledError());
    let cancellationError: unknown;
    try {
      if (!alreadyCancelling) {
        try {
          await this.dependencies.runner.cancel(agentId);
        } catch (error) {
          cancellationError = error;
        }
      }
      await execution.execution;
    } finally {
      this.cancellationRequests.delete(runId);
      this.agentCancellationLocks.delete(agentId);
    }
    if (cancellationError) throw cancellationError;
  }

  /** An audit sink failure must never change the outcome of a Run. */
  private async recordAudit(input: AuditEventInput): Promise<void> {
    const audit = this.dependencies.getAudit?.();
    if (!audit) return;
    await audit.record(input).catch((error) => {
      console.warn("audit write failed", error);
    });
  }

  private reportLifecycleFailure(failure: ApplicationLifecycleFailure): void {
    try {
      this.dependencies.reportLifecycleFailure?.(failure);
    } catch {
      // Reporting is advisory to the execution boundary; a broken reporter
      // must never prevent the in-memory cancellation/settlement path.
    }
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
    operation: OperationOptions = {},
  ): void {
    const control = createRunControl(operation);
    // Queue the async body behind the registration. `executeRun` reaches its
    // first await synchronously, so invoking it before inserting this entry
    // leaves a cancellation or waitForRun call with no local execution to
    // observe during that first turn of the event loop.
    const execution = Promise.resolve().then(() =>
      this.executeRun(
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
        control.operation,
      ),
    );
    this.activeExecutions.set(agentAtStart.id, {
      runId: run.id,
      run: structuredClone(run),
      execution,
    });
    this.runControls.set(run.id, control);
    void execution.then(
      () => {
        if (this.activeExecutions.get(agentAtStart.id)?.runId === run.id) {
          this.activeExecutions.delete(agentAtStart.id);
        }
        if (this.runControls.get(run.id) === control) {
          control.dispose();
          this.runControls.delete(run.id);
        }
      },
      () => {
        if (this.activeExecutions.get(agentAtStart.id)?.runId === run.id) {
          this.activeExecutions.delete(agentAtStart.id);
        }
        if (this.runControls.get(run.id) === control) {
          control.dispose();
          this.runControls.delete(run.id);
        }
      },
    );
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
    if (isTerminalRun(initial) && !this.activeExecutionFor(initial.agentId, runId)) {
      return initial;
    }
    if (options.signal?.aborted) {
      const reason = options.signal.reason;
      throw reason instanceof Error &&
        (reason.name === "AbortError" || reason.name === "TimeoutError")
        ? reason
        : waitError("AbortError", "Waiting for Run " + runId + " was aborted");
    }

    return new Promise<AgentRun>((resolve, reject) => {
      let settled = false;
      let interval: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;
      let waitingForExecution = false;

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
        if (settled) return;
        try {
          const current = this.dependencies.getRun(runId);
          if (isTerminalRun(current)) {
            const execution = this.activeExecutionFor(current.agentId, runId);
            if (execution) {
              if (waitingForExecution) return;
              waitingForExecution = true;
              const resume = () => {
                waitingForExecution = false;
                if (!settled) poll();
              };
              // A local execution can still be running its finally block
              // after it persisted a terminal Run. Wait for both to settle;
              // supplying both handlers also keeps a rejected execution from
              // becoming an unhandled rejection for this observer.
              void execution.then(resume, resume);
              return;
            }
            settle(() => resolve(current));
          }
        } catch (error) {
          settle(() => reject(error));
        }
      };

      const onAbort = () => {
        const reason = options.signal?.reason;
        settle(() =>
          reject(
            reason instanceof Error &&
              (reason.name === "AbortError" || reason.name === "TimeoutError")
              ? reason
              : waitError("AbortError", "Waiting for Run " + runId + " was aborted"),
          ),
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

  private activeExecutionFor(agentId: string, runId: string): Promise<void> | undefined {
    const active = this.activeExecutions.get(agentId);
    return active?.runId === runId ? active.execution : undefined;
  }

  private activeExecutionByRunId(runId: string):
    | { agentId: string; execution: ActiveExecution }
    | undefined {
    for (const [agentId, execution] of this.activeExecutions) {
      if (execution.runId === runId) return { agentId, execution };
    }
    return undefined;
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

    const alreadyCancelling = this.agentCancellationLocks.has(agentId);
    this.agentCancellationLocks.add(agentId);
    this.cancellationRequests.add(active.runId);
    try {
      this.runControls.get(active.runId)?.controller.abort(new RunCancelledError());
      let cancellationError: unknown;
      try {
        if (!alreadyCancelling) await this.dependencies.runner.cancel(agentId);
      } catch (error) {
        cancellationError = error;
      }
      await active.execution;
      if (cancellationError) throw cancellationError;
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
    operation: OperationOptions = {},
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
          operation,
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
      operation,
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
    operation: OperationOptions = {},
  ): Promise<void> {
    const startedAt = now();
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
    const correlation = {
      agentId: agentAtStart.id,
      ...(projectId === undefined ? {} : { projectId }),
      runId: run.id,
      ...(orchestrationId === undefined ? {} : { orchestrationId }),
      principal: agentPrincipal(agentAtStart.id),
      span: auditSpan,
    } as const;
    // Held for the whole turn when the run is Project-scoped. The lease and
    // the shared-scope thread are settled in the finally below.
    let binding: ProjectRunBinding | null = null;
    let outcome: { codexThreadId: string | null } | null = null;
    let mintedMcpSession: MintedMcpSession | null = null;
    let terminalPersisted = false;
    let runningRecordFound = false;
    let terminalRecordFound = false;
    try {
      // Setup is part of the same guarded lifetime as the runner. If this
      // mutation fails, the catch below records the failure (when possible)
      // and, importantly, never dispatches a worker from a silently rejected
      // background promise.
      const initialControlError = this.executionControlError(run.id, operation);
      if (initialControlError) {
        terminalPersisted = await this.markRunCancelledBeforeExecution(
          run.id,
          agentAtStart.id,
        );
        return;
      }
      await this.dependencies.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun) {
          runningRecordFound = true;
          storedRun.status = "running";
          storedRun.startedAt = startedAt;
          // Persist the trace identity on the Run so historical evidence stays
          // reachable from the Run record alone.
          storedRun.traceId = auditSpan.traceId;
        }
      });
      if (!runningRecordFound) {
        throw new Error("Accepted Run was not found during execution setup");
      }
      const afterRunning = this.executionControlError(run.id, operation);
      if (afterRunning) {
        terminalPersisted = await this.markRunCancelledBeforeExecution(
          run.id,
          agentAtStart.id,
        );
        return;
      }
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
      const afterStartAudit = this.executionControlError(run.id, operation);
      if (afterStartAudit) {
        terminalPersisted = await this.markRunCancelledBeforeExecution(
          run.id,
          agentAtStart.id,
        );
        return;
      }
      this.runSpans.set(run.id, auditSpan);

      const beforePreparation = this.executionControlError(run.id, operation);
      if (beforePreparation) throw beforePreparation;
      if (projectId !== undefined) {
        binding = await this.requireProjectScope().beginTurn(
          agentAtStart,
          projectId,
          run.id,
          operation,
        );
        // Role changes can happen after acceptance or while waiting for the
        // Project lease. Recheck immediately before invoking the runner.
        await this.requireProjectScope().assertRunnable(
          projectId,
          agentAtStart.id,
          operation,
        );
        const afterProjectPreparation = this.executionControlError(run.id, operation);
        if (afterProjectPreparation) throw afterProjectPreparation;
      }
      const executionPrompt = await this.dependencies.prompt.compose(
        agentAtStart,
        run.prompt,
        binding,
        projectId,
        run.id,
        orchestrationId,
      );
      const afterPrompt = this.executionControlError(run.id, operation);
      if (afterPrompt) throw afterPrompt;
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
        const beforeRunner = this.executionControlError(run.id, operation);
        if (beforeRunner) throw beforeRunner;
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
            ...(operation.signal === undefined ? {} : { signal: operation.signal }),
            ...(operation.deadlineAt === undefined
              ? {}
              : { deadlineAt: operation.deadlineAt }),
          });
          const afterRunner = this.executionControlError(run.id, operation);
          if (afterRunner) throw afterRunner;
          // The model may swallow an MCP isError and return apparent output.
          // The authenticated MCP route latches the denial for this Run, so a
          // successful runner result cannot turn a denied tool call into a
          // completed Run.
          if (this.webToolPermissionDenied(run.id)) {
            throw new WebToolPermissionDeniedError();
          }
          selectedModelIndex = modelIndex;
          break;
        } catch (error) {
          const runnerControlError = this.executionControlError(run.id, operation);
          if (runnerControlError) {
            throw error;
          }
          // Check the terminal denial before considering a model fallback. A
          // tool authorization failure is a Run failure even when the runner
          // reports it through a retryable transport error.
          if (this.webToolPermissionDenied(run.id)) {
            throw new WebToolPermissionDeniedError();
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
      const beforeCompletion = this.executionControlError(run.id, operation);
      if (beforeCompletion) throw beforeCompletion;
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
        terminalRecordFound = true;
        if (isTerminalRun(storedRun)) return;
        if (this.executionControlError(run.id, operation)) {
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
      terminalPersisted = terminalRecordFound;
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
      const controlError = this.executionControlError(run.id, operation);
      const cancelled =
        error instanceof RunCancelledError ||
        this.cancellationRequests.has(run.id) ||
        controlError instanceof RunCancelledError;
      const webPermissionDenied =
        !cancelled &&
        (error instanceof WebToolPermissionDeniedError ||
          this.webToolPermissionDenied(run.id));
      const modelInferenceLimitExceeded =
        !cancelled && runtimeErrorCode(error) === MODEL_INFERENCE_LIMIT_EXCEEDED;
      runSpan?.setStatus(cancelled ? "ok" : "error");
      const message = safeRuntimeError(error);
      try {
        await this.dependencies.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (storedRun && isTerminalRun(storedRun)) {
            terminalRecordFound = true;
            if (agent) {
              if (agent.status !== "stopped") agent.status = "ready";
              agent.updatedAt = completedAt;
            }
            return;
          }
          if (storedRun) {
            terminalRecordFound = true;
            storedRun.status = cancelled ? "cancelled" : "failed";
            storedRun.error = cancelled ? "Run cancelled" : message;
            if (webPermissionDenied) {
              storedRun.errorCode = WEB_TOOL_PERMISSION_DENIED;
            } else if (modelInferenceLimitExceeded) {
              storedRun.errorCode = MODEL_INFERENCE_LIMIT_EXCEEDED;
            } else {
              delete storedRun.errorCode;
            }
            storedRun.completedAt = completedAt;
          }
          if (agent) {
            if (agent.status !== "stopped") {
              agent.status =
                cancelled || webPermissionDenied || modelInferenceLimitExceeded
                  ? "ready"
                  : "error";
            }
            agent.lastError =
              cancelled || webPermissionDenied || modelInferenceLimitExceeded
                ? null
                : message;
            agent.updatedAt = completedAt;
          }
        });
        terminalPersisted = terminalRecordFound;
      } catch {
        // A failed terminal write is uncertainty, not permission to release a
        // Project lease. Keep the ownership evidence in place and report the
        // failure through the application lifecycle sink.
        this.reportLifecycleFailure({
          code: "EXECUTION_FINALIZATION_FAILED",
          message: "Agent Run terminal state could not be persisted",
          runId: run.id,
          agentId: agentAtStart.id,
          ...(projectId === undefined ? {} : { projectId }),
        });
      }
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
                ...(webPermissionDenied
                  ? { errorCode: WEB_TOOL_PERMISSION_DENIED }
                  : modelInferenceLimitExceeded
                    ? { errorCode: MODEL_INFERENCE_LIMIT_EXCEEDED }
                  : {}),
                errorClass:
                  (error as { constructor?: { name?: string } } | null)
                    ?.constructor?.name ?? "Error",
              },
            },
      );
    } finally {
      this.runSpans.delete(run.id);
      // Release only after a terminal Run fact is known to be committed. A
      // failed terminal write leaves physical ownership uncertain, so keeping
      // the lease is the safe recovery gate rather than releasing a possibly
      // live writer.
      if (binding !== null) {
        if (terminalPersisted) {
          try {
            await this.requireProjectScope().endTurn(
              binding.projectId,
              agentAtStart.id,
              run.id,
              outcome,
            );
          } catch {
            this.reportLifecycleFailure({
              code: "PROJECT_LEASE_RELEASE_FAILED",
              message: "Project turn cleanup could not be completed",
              runId: run.id,
              agentId: agentAtStart.id,
              projectId: binding.projectId,
            });
          }
        } else {
          this.reportLifecycleFailure({
            code: "EXECUTION_FINALIZATION_FAILED",
            message: "Project lease retained because Agent Run settlement is uncertain",
            runId: run.id,
            agentId: agentAtStart.id,
            projectId: binding.projectId,
          });
        }
      }
      if (mintedMcpSession !== null) {
        this.dependencies.getMcpSessions()?.revoke(mintedMcpSession.token);
      }
      this.dependencies.getMcpSessions()?.clearWebToolPermissionDenied(run.id);
    }
  }

  private async cancelRunInternal(runId: string): Promise<AgentRun> {
    // Prefer the process-local handle before consulting Storage. A fatal
    // adapter transition may make the persisted snapshot unreadable while an
    // accepted child still needs an explicit physical cancellation.
    const inMemory = this.activeExecutionByRunId(runId);
    let initial: AgentRun;
    try {
      initial = this.dependencies.getRun(runId);
    } catch (error) {
      if (!inMemory) throw error;
      initial = structuredClone(inMemory.execution.run);
    }
    if (isTerminalRun(initial)) return initial;

    const active = this.activeExecutions.get(initial.agentId);
    if (!active || active.runId !== runId) {
      const current = this.dependencies.getRun(runId);
      if (isTerminalRun(current)) return current;
      throw new HttpError(409, "Run is not currently active");
    }

    const alreadyCancelling = this.agentCancellationLocks.has(initial.agentId);
    this.agentCancellationLocks.add(initial.agentId);
    this.cancellationRequests.add(runId);
    try {
      this.runControls.get(runId)?.controller.abort(new RunCancelledError());
      let cancellationError: unknown;
      try {
        if (!alreadyCancelling) await this.dependencies.runner.cancel(initial.agentId);
      } catch (error) {
        cancellationError = error;
      }
      await active.execution;
      if (cancellationError) throw cancellationError;
      try {
        return this.dependencies.getRun(runId);
      } catch {
        // Storage may remain unavailable after physical cancellation. Return
        // only an in-memory cancellation projection to the caller; no
        // fabricated terminal record is persisted.
        return {
          ...structuredClone(active.run),
          status: "cancelled",
          error: "Run cancelled",
          completedAt: now(),
        };
      }
    } finally {
      this.cancellationRequests.delete(runId);
      this.agentCancellationLocks.delete(initial.agentId);
    }
  }

  /**
   * A cancellation can arrive while the accepted Run is still queued. Make
   * that record terminal without entering the running/audit/runner path.
   */
  private async markRunCancelledBeforeExecution(
    runId: string,
    agentId: string,
  ): Promise<boolean> {
    const completedAt = now();
    let persisted = false;
    await this.dependencies.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === agentId);
      if (!storedRun || !agent || isTerminalRun(storedRun)) return;
      persisted = true;
      storedRun.status = "cancelled";
      storedRun.error = "Run cancelled";
      storedRun.completedAt = completedAt;
      if (agent.status !== "stopped") agent.status = "ready";
      agent.lastError = null;
      agent.updatedAt = completedAt;
    });
    return persisted;
  }

  private executionControlError(
    runId: string,
    operation: OperationOptions,
  ): Error | undefined {
    if (this.cancellationRequests.has(runId)) return new RunCancelledError();
    if (operation.signal?.aborted) {
      const reason = operation.signal.reason;
      if (reason instanceof Error && reason.name === "TimeoutError") return reason;
      return new RunCancelledError();
    }
    if (
      operation.deadlineAt !== undefined &&
      Number.isFinite(operation.deadlineAt) &&
      Date.now() >= operation.deadlineAt
    ) {
      return waitError("TimeoutError", "Run " + runId + " timed out");
    }
    return undefined;
  }

  private requireProjectScope(): ProjectExecutionScope {
    const projectScope = this.dependencies.getProjectScope();
    if (!projectScope) {
      throw new HttpError(503, "Project execution is not configured");
    }
    return projectScope;
  }

  private webToolPermissionDenied(runId: string): boolean {
    return this.dependencies.getMcpSessions()?.hasWebToolPermissionDenied(runId) ?? false;
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
