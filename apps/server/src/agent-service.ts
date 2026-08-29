import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { ModelCatalogError } from "./models/errors.js";
import {
  createWorkerModelResolver,
  modelRefsEqual,
  normalizeModelRef,
} from "./models/worker-model-resolver.js";
import type {
  ModelRef,
  WorkerModelResolver,
  WorkerRuntimeModelConfig,
} from "./models/types.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import type { PreviewLifecycleCleanup } from "./preview/preview-service.js";
import {
  composeRuntimeContextPrompt,
  type PreviewContextProvider,
} from "./preview/preview-context-provider.js";

const now = () => new Date().toISOString();
const RUN_POLL_INTERVAL_MS = 50;

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

/** Optional helpers are supplied by the canonical Ark resolver. Keeping them
 * optional preserves the small WorkerModelResolver injection seam for tests
 * and future providers. */
type AgentModelResolver = WorkerModelResolver & {
  defaultModelRef?: () => ModelRef | undefined;
  effectiveModelRef?: (modelRef: ModelRef | undefined) => ModelRef | undefined;
};

export class AgentService {
  private previewLifecycle: PreviewLifecycleCleanup | undefined;
  private previewContext: PreviewContextProvider | undefined;
  private readonly activeExecutions = new Map<
    string,
    { runId: string; execution: Promise<void> }
  >();
  private readonly cancellationRequests = new Set<string>();
  private readonly runCancellations = new Map<string, Promise<AgentRun>>();
  private readonly agentCancellationLocks = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly modelResolver: AgentModelResolver =
      createWorkerModelResolver(config),
    previewLifecycle?: PreviewLifecycleCleanup,
    previewContext?: PreviewContextProvider,
  ) {
    this.previewLifecycle = previewLifecycle;
    this.previewContext = previewContext;
  }

  /** Attach the preview cleanup seam after both services have been assembled. */
  setPreviewLifecycle(previewLifecycle: PreviewLifecycleCleanup): void {
    this.previewLifecycle = previewLifecycle;
  }

  /** Attach the read-only Preview state seam used to build runtime context. */
  setPreviewContextProvider(previewContext: PreviewContextProvider): void {
    this.previewContext = previewContext;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const modelRef = this.resolveModelRefForCreate(input.modelRef);
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      ...(modelRef === undefined ? {} : { modelRef }),
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const nextModelRef =
      input.modelRef === undefined
        ? current.modelRef
        : this.effectiveModelRef(input.modelRef);
    if (input.modelRef !== undefined) {
      // Validate before entering the store mutation so invalid model changes
      // cannot partially update the Agent or its workspace instructions.
      this.modelResolver.resolve(input.modelRef);
    }
    const currentEffectiveModelRef = this.effectiveModelRef(current.modelRef);
    const modelChanged = !modelRefsEqual(
      currentEffectiveModelRef,
      input.modelRef === undefined
        ? currentEffectiveModelRef
        : nextModelRef,
    );
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      if (input.modelRef !== undefined) {
        if (nextModelRef === undefined) {
          delete agent.modelRef;
        } else {
          agent.modelRef = nextModelRef;
        }
      }
      if (modelChanged) {
        // Codex sessions are model/provider-specific. Keep the old session
        // files in CODEX_HOME, but force the next run to create a fresh thread.
        agent.codexThreadId = null;
      }
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    // Close the PreviewService start gate before cleanup. Any start already
    // holding the per-Agent preview lock completes first and is then stopped;
    // later starts observe the stopped Agent and are rejected.
    await this.setStatus(id, "stopped");
    await this.previewLifecycle?.stopForAgent(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.previews = database.previews.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    const stopped = await this.setStatus(id, "stopped");
    await this.previewLifecycle?.stopForAgent(id);
    return stopped;
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  async waitForRun(
    runId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<AgentRun> {
    const timeoutMs = options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative finite number");
    }

    const initial = this.getRun(runId);
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
          const current = this.getRun(runId);
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

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (this.agentCancellationLocks.has(agentId)) {
      throw new HttpError(409, "This Agent is currently being cancelled");
    }
    const agentBeforeRun = this.getAgent(agentId);
    if (!this.config.arkApiKey || this.config.arkApiKey.startsWith("replace-")) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        503,
        "Worker runtime credentials are not configured.",
      );
    }
    const runtimeModel = this.modelResolver.resolve(agentBeforeRun.modelRef);
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run, runtimeModel);
    this.activeExecutions.set(agentId, { runId, execution });
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId)?.runId === runId) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    runtimeModel: WorkerRuntimeModelConfig,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(run.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: await this.executionPrompt(agentAtStart.id, run.prompt),
        threadId: agentAtStart.codexThreadId,
        model: runtimeModel,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        if (isTerminalRun(storedRun)) return;
        if (this.cancellationRequests.has(run.id)) {
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
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled =
        error instanceof RunCancelledError || this.cancellationRequests.has(run.id);
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
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
    }
  }

  /**
   * Builds the prompt the worker actually executes.
   *
   * Trusted platform state is composed here, at the runtime boundary, rather
   * than in the client or in the persisted message, so the Agent sees current
   * Preview state without the conversation history being rewritten. A missing
   * or failing provider degrades to the untouched user prompt.
   */
  private async executionPrompt(agentId: string, prompt: string): Promise<string> {
    if (!this.previewContext) return prompt;
    try {
      const context = await this.previewContext.getForAgent(agentId);
      return composeRuntimeContextPrompt(prompt, context);
    } catch {
      return prompt;
    }
  }

  private resolveModelRefForCreate(modelRef: ModelRef | undefined): ModelRef | undefined {
    const effective = this.effectiveModelRef(modelRef);
    // Validate before creating the workspace/store record. In particular, a
    // malformed explicit ref must not leave a partially-created Agent behind.
    if (modelRef !== undefined || effective !== undefined) {
      this.modelResolver.resolve(modelRef);
    }
    return effective;
  }

  private effectiveModelRef(modelRef: ModelRef | undefined): ModelRef | undefined {
    if (this.modelResolver.effectiveModelRef) {
      return this.modelResolver.effectiveModelRef(modelRef);
    }
    if (modelRef !== undefined) return normalizeModelRef(modelRef);
    if (!this.config.arkModel) return undefined;
    return {
      providerId: "volcengine_ark",
      modelId: this.config.arkModel,
    };
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    const active = this.activeExecutions.get(agentId);
    if (!active) {
      await this.runner.cancel(agentId);
      return;
    }

    this.agentCancellationLocks.add(agentId);
    this.cancellationRequests.add(active.runId);
    try {
      await this.runner.cancel(agentId);
      await active.execution;
    } finally {
      this.cancellationRequests.delete(active.runId);
      this.agentCancellationLocks.delete(agentId);
    }
  }

  private async cancelRunInternal(runId: string): Promise<AgentRun> {
    const initial = this.getRun(runId);
    if (isTerminalRun(initial)) return initial;

    const active = this.activeExecutions.get(initial.agentId);
    if (!active || active.runId !== runId) {
      const current = this.getRun(runId);
      if (isTerminalRun(current)) return current;
      throw new HttpError(409, "Run is not currently active");
    }

    this.agentCancellationLocks.add(initial.agentId);
    this.cancellationRequests.add(runId);
    try {
      await this.runner.cancel(initial.agentId);
      await active.execution;
      return this.getRun(runId);
    } finally {
      this.cancellationRequests.delete(runId);
      this.agentCancellationLocks.delete(initial.agentId);
    }
  }
}
