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
  AgentConversation,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Database,
  Message,
  MessageOrigin,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import type { PreviewLifecycleCleanup } from "./preview/preview-service.js";
import {
  composeRuntimeContextPrompt,
  type PreviewContextProvider,
} from "./preview/preview-context-provider.js";
import {
  projectRuntimeContextLines,
  type ProjectExecutionScope,
  type ProjectRunBinding,
} from "./projects/project-execution.js";

const now = () => new Date().toISOString();
const RUN_POLL_INTERVAL_MS = 50;
const DEFAULT_CONVERSATION_TITLE = "New conversation";
const MAX_CONVERSATION_TITLE_LENGTH = 80;

/**
 * Derives a conversation title from the user's first message.
 *
 * Deliberately mechanical: naming a conversation is not worth a second model
 * call, and a deterministic title is easier to test.
 */
export function deriveConversationTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n").find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return DEFAULT_CONVERSATION_TITLE;
  if (collapsed.length <= MAX_CONVERSATION_TITLE_LENGTH) return collapsed;
  const clipped = collapsed.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 24 ? clipped.slice(0, lastSpace) : clipped).trimEnd() + "…";
}

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


function normalizeConversationTitle(title: string | undefined): string | null {
  const trimmed = (title ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

/**
 * Adopts pre-conversation direct history into one default conversation.
 *
 * The old `Agent.codexThreadId` was the Agent's private session, so it moves to
 * that conversation rather than being copied: leaving it on the Agent as well
 * would let a Team turn and a private turn resume the same thread. Project
 * threads live on the attachment and are never touched here.
 */
function migrateLegacyConversations(database: Database): void {
  const orphans = database.messages.filter(
    (message) =>
      message.conversationId === undefined && (message.origin ?? "direct") === "direct",
  );
  if (orphans.length === 0) return;

  const byAgent = new Map<string, Message[]>();
  for (const message of orphans) {
    const bucket = byAgent.get(message.agentId) ?? [];
    bucket.push(message);
    byAgent.set(message.agentId, bucket);
  }

  for (const [agentId, messages] of byAgent) {
    const agent = database.agents.find((item) => item.id === agentId);
    if (!agent) continue;
    const ordered = [...messages].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    const firstPrompt = ordered.find((message) => message.role === "user")?.content ?? "";
    const timestamp = now();
    const conversation: AgentConversation = {
      id: randomUUID(),
      agentId,
      title: firstPrompt
        ? deriveConversationTitle(firstPrompt)
        : DEFAULT_CONVERSATION_TITLE,
      codexThreadId: agent.codexThreadId,
      createdAt: ordered[0]?.createdAt ?? timestamp,
      updatedAt: ordered[ordered.length - 1]?.createdAt ?? timestamp,
    };
    database.agentConversations.push(conversation);
    agent.codexThreadId = null;

    const runIds = new Set<string>();
    for (const message of ordered) {
      const stored = database.messages.find((item) => item.id === message.id);
      if (!stored) continue;
      stored.conversationId = conversation.id;
      runIds.add(stored.runId);
    }
    for (const run of database.runs) {
      if (run.agentId === agentId && runIds.has(run.id)) {
        run.conversationId = conversation.id;
      }
    }
  }
}

export class AgentService {
  private previewLifecycle: PreviewLifecycleCleanup | undefined;
  private previewContext: PreviewContextProvider | undefined;
  private projectScope: ProjectExecutionScope | undefined;
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

  /** Attach the Project seam that scopes a run to a shared workspace. */
  setProjectExecutionScope(projectScope: ProjectExecutionScope): void {
    this.projectScope = projectScope;
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
      migrateLegacyConversations(database);
    });
  }

  // ------------------------------------------------- private conversations

  listConversations(agentId: string): AgentConversation[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .agentConversations.filter((item) => item.agentId === agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getConversation(agentId: string, conversationId: string): AgentConversation {
    const conversation = this.store
      .snapshot()
      .agentConversations.find(
        (item) => item.id === conversationId && item.agentId === agentId,
      );
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }
    return conversation;
  }

  /**
   * Starts a new private conversation.
   *
   * A fresh conversation means fresh messages and a fresh Codex thread, but
   * deliberately the same Agent workspace: the point of a second conversation
   * is to work on the same files with a clean session.
   */
  async createConversation(agentId: string, title?: string): Promise<AgentConversation> {
    this.getAgent(agentId);
    const timestamp = now();
    const conversation: AgentConversation = {
      id: randomUUID(),
      agentId,
      title: normalizeConversationTitle(title) ?? DEFAULT_CONVERSATION_TITLE,
      codexThreadId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.agentConversations.push(conversation);
    });
    return conversation;
  }

  async renameConversation(
    agentId: string,
    conversationId: string,
    title: string,
  ): Promise<AgentConversation> {
    this.getConversation(agentId, conversationId);
    const normalized = normalizeConversationTitle(title);
    if (!normalized) {
      throw new HttpError(422, "A conversation title is required");
    }
    return this.store.mutate((database) => {
      const stored = database.agentConversations.find((item) => item.id === conversationId);
      if (!stored) throw new HttpError(404, "Conversation not found");
      stored.title = normalized;
      stored.updatedAt = now();
      return structuredClone(stored);
    });
  }

  /**
   * Deletes one conversation and its history.
   *
   * The Agent, its workspace files, its other conversations, its preview, and
   * its Project attachments are all untouched — only this thread of talk goes.
   */
  async deleteConversation(
    agentId: string,
    conversationId: string,
  ): Promise<{ deleted: true }> {
    this.getConversation(agentId, conversationId);
    await this.store.mutate((database) => {
      database.agentConversations = database.agentConversations.filter(
        (item) => item.id !== conversationId,
      );
      database.messages = database.messages.filter(
        (item) => item.conversationId !== conversationId,
      );
      database.runs = database.runs.filter(
        (item) => item.conversationId !== conversationId,
      );
    });
    return { deleted: true };
  }

  /** Resolves the conversation a direct turn belongs to, creating one if needed. */
  private async resolveConversation(
    agentId: string,
    conversationId: string | undefined,
  ): Promise<AgentConversation> {
    if (conversationId !== undefined) {
      return this.getConversation(agentId, conversationId);
    }
    const existing = this.listConversations(agentId)[0];
    return existing ?? (await this.createConversation(agentId));
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
        // Private conversations each hold their own thread, so all of them
        // reset too. Project sessions belong to the Project attachment and are
        // deliberately left alone.
        agent.codexThreadId = null;
        for (const conversation of database.agentConversations) {
          if (conversation.agentId !== id) continue;
          conversation.codexThreadId = null;
          conversation.updatedAt = now();
        }
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
      database.agentConversations = database.agentConversations.filter(
        (item) => item.agentId !== id,
      );
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

  /**
   * The Agent's own Playground conversation.
   *
   * Team turns are deliberately excluded: the orchestrator authored those
   * prompts, not the user, so projecting them here would put words in the
   * user's mouth. They remain persisted, and remain visible in the Team
   * conversation and timeline.
   */
  getMessages(
    agentId: string,
    options: { origin?: MessageOrigin | "all"; conversationId?: string } = {},
  ): Message[] {
    this.getAgent(agentId);
    const origin = options.origin ?? "direct";
    const conversationId = options.conversationId;
    if (conversationId !== undefined) this.getConversation(agentId, conversationId);
    return this.store
      .snapshot()
      .messages.filter(
        (message) =>
          message.agentId === agentId &&
          (origin === "all" || (message.origin ?? "direct") === origin) &&
          (conversationId === undefined || message.conversationId === conversationId),
      )
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

  getRuns(agentId: string, options: { conversationId?: string } = {}): AgentRun[] {
    this.getAgent(agentId);
    const conversationId = options.conversationId;
    return this.store
      .snapshot()
      .runs.filter(
        (run) =>
          run.agentId === agentId &&
          (conversationId === undefined || run.conversationId === conversationId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    options: {
      projectId?: string | undefined;
      /** Team turns are tagged so the Playground never shows them. */
      origin?: MessageOrigin | undefined;
      /** Private conversation for a direct turn; ignored for Team turns. */
      conversationId?: string | undefined;
    } = {},
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
    // Validate Project membership before a Run record exists, so an
    // unattached Agent never leaves a queued run behind.
    const projectId = options.projectId;
    if (projectId !== undefined) {
      this.requireProjectScope().assertRunnable(projectId, agentId);
    }
    // Only direct Playground turns belong to a private conversation. Team turns
    // keep their own session scope and stay out of private history entirely.
    const origin: MessageOrigin = options.origin ?? "direct";
    const conversation =
      origin === "direct" && projectId === undefined
        ? await this.resolveConversation(agentId, options.conversationId)
        : null;
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      ...(conversation === null ? {} : { conversationId: conversation.id }),
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
      origin,
      ...(conversation === null ? {} : { conversationId: conversation.id }),
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
      if (conversation !== null) {
        const storedConversation = database.agentConversations.find(
          (item) => item.id === conversation.id,
        );
        if (storedConversation) {
          if (storedConversation.title === DEFAULT_CONVERSATION_TITLE) {
            storedConversation.title = deriveConversationTitle(prompt);
          }
          storedConversation.updatedAt = timestamp;
        }
      }
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(
      agentAtStart,
      run,
      runtimeModel,
      projectId,
      origin,
      conversation,
    );
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
    projectId?: string | undefined,
    origin: MessageOrigin = "direct",
    conversation: AgentConversation | null = null,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    // Held for the whole turn when the run is Project-scoped. The lease and
    // the shared-scope thread are settled in the `finally` below.
    let binding: ProjectRunBinding | null = null;
    let outcome: { codexThreadId: string | null } | null = null;
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
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: binding?.workspacePath ?? agentAtStart.workspacePath,
        ...(projectId === undefined ? {} : { projectId }),
        prompt: await this.executionPrompt(agentAtStart.id, run.prompt, binding),
        threadId: binding
          ? binding.codexThreadId
          : conversation
            ? conversation.codexThreadId
            : agentAtStart.codexThreadId,
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
      if (binding !== null) outcome = { codexThreadId: result.threadId };
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
    } finally {
      // The write lease must never outlive its turn, on any path: success,
      // failure, cancellation, or a runner that threw before producing output.
      if (binding !== null) {
        await this.requireProjectScope()
          .endTurn(binding.projectId, agentAtStart.id, run.id, outcome)
          .catch(() => undefined);
      }
    }
  }

  private requireProjectScope(): ProjectExecutionScope {
    if (!this.projectScope) {
      throw new HttpError(503, "Project execution is not configured");
    }
    return this.projectScope;
  }

  /**
   * Builds the prompt the worker actually executes.
   *
   * Trusted platform state is composed here, at the runtime boundary, rather
   * than in the client or in the persisted message, so the Agent sees current
   * Preview state without the conversation history being rewritten. A missing
   * or failing provider degrades to the untouched user prompt.
   */
  private async executionPrompt(
    agentId: string,
    prompt: string,
    binding: ProjectRunBinding | null,
  ): Promise<string> {
    const projectLines = binding ? projectRuntimeContextLines(binding) : [];
    if (!this.previewContext) {
      return projectLines.length === 0
        ? prompt
        : composeRuntimeContextPrompt(prompt, { status: "not_started" }, projectLines);
    }
    try {
      const context = await this.previewContext.getForAgent(agentId);
      return composeRuntimeContextPrompt(prompt, context, projectLines);
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
