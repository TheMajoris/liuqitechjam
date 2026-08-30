import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError } from "./errors.js";
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
  Message,
  MessageOrigin,
  UpdateAgentInput,
} from "./types.js";
import {
  AgentConversationService,
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
} from "./agent-conversation-service.js";
export { deriveConversationTitle } from "./agent-conversation-service.js";
import { WorkspaceManager } from "./workspace.js";
import type { PreviewLifecycleCleanup } from "./preview/preview-service.js";
import type { PreviewContextProvider } from "./preview/preview-context-provider.js";
import {
  type ProjectExecutionScope,
} from "./projects/project-execution.js";
import { AgentRunCoordinator } from "./agent-run-coordinator.js";
import type { SkillRuntimeContext } from "./skills/skill-types.js";
import type { SkillService } from "./skills/skill-service.js";
import { AgentRuntimePromptComposer } from "./agent-runtime-prompt.js";
import type { RuntimeTelemetry } from "./telemetry/telemetry-types.js";
import type { McpSessionService } from "./tools/mcp-session-service.js";
import type { PermitDirectoryReconciliationSink } from "./access/permit-directory-reconciler.js";
import { buildUsageReport } from "./usage/usage-aggregator.js";
import type { UsageReport, UsageReportOptions } from "./usage/usage-types.js";

const now = () => new Date().toISOString();

/** Optional helpers are supplied by the canonical Ark resolver. Keeping them
 * optional preserves the small WorkerModelResolver injection seam for tests
 * and future providers. */
type AgentModelResolver = WorkerModelResolver & {
  defaultModelRef?: () => ModelRef | undefined;
  effectiveModelRef?: (modelRef: ModelRef | undefined) => ModelRef | undefined;
};

export class AgentService {
  private readonly conversations: AgentConversationService;
  private readonly runCoordinator: AgentRunCoordinator;
  private previewLifecycle: PreviewLifecycleCleanup | undefined;
  private previewContext: PreviewContextProvider | undefined;
  private projectScope: ProjectExecutionScope | undefined;
  private mcpSessions: McpSessionService | undefined;
  private skillService: SkillService | undefined;
  private telemetry: RuntimeTelemetry | undefined;
  private permitDirectory: PermitDirectoryReconciliationSink | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly modelResolver: AgentModelResolver =
      createWorkerModelResolver(config),
    previewLifecycle?: PreviewLifecycleCleanup,
    previewContext?: PreviewContextProvider,
    skillService?: SkillService,
  ) {
    this.conversations = new AgentConversationService(store, (agentId) => {
      this.getAgent(agentId);
    });
    const runtimePrompt = new AgentRuntimePromptComposer(
      () => this.previewContext,
      (agent, projectId, runId, orchestrationId) =>
        this.runtimeSkillContext(agent, projectId, runId, orchestrationId),
    );
    this.runCoordinator = new AgentRunCoordinator({
      config,
      store,
      runner,
      prompt: runtimePrompt,
      getProjectScope: () => this.projectScope,
      getMcpSessions: () => this.mcpSessions,
      getTelemetry: () => this.telemetry,
      getRun: (runId) => this.getRun(runId),
    });
    this.previewLifecycle = previewLifecycle;
    this.previewContext = previewContext;
    this.skillService = skillService;
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

  /** Attach the per-run MCP session authority after the app graph is assembled. */
  setMcpSessionService(mcpSessions: McpSessionService): void {
    this.mcpSessions = mcpSessions;
  }

  /** Attach the code-owned skill/capability composer after app assembly. */
  setSkillService(skillService: SkillService): void {
    this.skillService = skillService;
  }

  /** Attach runtime telemetry after the service graph has been assembled. */
  setTelemetry(telemetry: RuntimeTelemetry): void {
    this.telemetry = telemetry;
  }

  /** Attach the Permit directory synchronization seam after app assembly. */
  setPermitDirectoryReconciler(
    reconciler: PermitDirectoryReconciliationSink,
  ): void {
    this.permitDirectory = reconciler;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.skillService?.reconcileAgentSkillIds(this.store);
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
      this.conversations.migrateLegacyConversations(database);
    });
  }

  // ------------------------------------------------- private conversations

  listConversations(agentId: string): AgentConversation[] {
    return this.conversations.list(agentId);
  }

  getConversation(agentId: string, conversationId: string): AgentConversation {
    return this.conversations.get(agentId, conversationId);
  }

  /** Starts a new private conversation in the Agent's shared workspace. */
  async createConversation(agentId: string, title?: string): Promise<AgentConversation> {
    return this.conversations.create(agentId, title);
  }

  async renameConversation(
    agentId: string,
    conversationId: string,
    title: string,
  ): Promise<AgentConversation> {
    return this.conversations.rename(agentId, conversationId, title);
  }

  /** Deletes one conversation and its associated history. */
  async deleteConversation(
    agentId: string,
    conversationId: string,
  ): Promise<{ deleted: true }> {
    return this.conversations.delete(agentId, conversationId);
  }

  /** Resolves the conversation a direct turn belongs to, creating one if needed. */
  private async resolveConversation(
    agentId: string,
    conversationId: string | undefined,
  ): Promise<AgentConversation> {
    return this.conversations.resolve(agentId, conversationId);
  }

  listAgents(): Agent[] {
    const agents = this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (!this.skillService) return agents;
    return agents.map((agent) => ({
      ...agent,
      skillIds: this.skillService!.normalizeLegacySkillIds(agent.skillIds),
    }));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    if (!this.skillService) return agent;
    return {
      ...agent,
      skillIds: this.skillService.normalizeLegacySkillIds(agent.skillIds),
    };
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    if (input.skillIds !== undefined) {
      await this.skillService?.authorizeAssignment([], input.skillIds, id);
    }
    const modelRef = this.resolveModelRefForCreate(input.modelRef);
    const skillIds = this.normalizeSkillIds(input.skillIds);
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      skillIds,
      status: "ready",
      ...(modelRef === undefined ? {} : { modelRef }),
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let workspaceCreated = false;
    let persisted = false;
    try {
      await this.workspaces.create(agent, await this.runtimeSkillContext(agent));
      workspaceCreated = true;
      await this.store.mutate((database) => database.agents.push(agent));
      persisted = true;
      await this.permitDirectory?.reconcile();
      return agent;
    } catch (error) {
      // A directory failure must not leave a new repository identity behind
      // without its Permit representation. Compensate the local mutation and
      // archive the just-created workspace before surfacing the failure.
      if (persisted) {
        await this.store.mutate((database) => {
          database.agents = database.agents.filter((item) => item.id !== id);
        });
      }
      if (workspaceCreated) {
        await this.workspaces.archive(agent).catch(() => undefined);
      }
      throw error;
    }
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    if (input.skillIds !== undefined) {
      await this.skillService?.authorizeAssignment(
        current.skillIds,
        input.skillIds,
        id,
      );
    }
    const nextModelRef =
      input.modelRef === undefined
        ? current.modelRef
        : this.effectiveModelRef(input.modelRef);
    const nextSkillIds =
      input.skillIds === undefined
        ? current.skillIds
        : this.normalizeSkillIds(input.skillIds);
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
    const before = this.store.snapshot().agents.find((item) => item.id === id);
    if (!before) throw new HttpError(404, "Agent not found");
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
      if (input.skillIds !== undefined || this.skillService) {
        agent.skillIds = nextSkillIds ?? [];
      }
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
    try {
      await this.workspaces.writeInstructions(updated, await this.runtimeSkillContext(updated));
      await this.permitDirectory?.reconcile();
      return updated;
    } catch (error) {
      // Restore both the JSON identity fact and generated instructions if the
      // external authorization directory could not be synchronized.
      await this.store.mutate((database) => {
        const stored = database.agents.find((item) => item.id === id);
        if (stored) Object.assign(stored, structuredClone(before));
      });
      await this.workspaces
        .writeInstructions(before, await this.runtimeSkillContext(before))
        .catch(() => undefined);
      throw error;
    }
  }

  /** Replaces the Agent-global skill assignment at a trusted server boundary. */
  async updateAgentSkills(id: string, skillIds: string[]): Promise<Agent> {
    return this.updateAgent(id, { skillIds });
  }

  /** Returns the assigned skills and current capability state for one Agent. */
  async getAgentSkills(id: string, projectId?: string) {
    const agent = this.getAgent(id);
    if (!this.skillService) {
      return {
        agentId: agent.id,
        projectId: projectId ?? null,
        skillIds: [...(agent.skillIds ?? [])],
        skills: [],
      };
    }
    return this.skillService.readAgentSkills(agent, projectId);
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    // Close the PreviewService start gate before cleanup. Any start already
    // holding the per-Agent preview lock completes first and is then stopped;
    // later starts observe the stopped Agent and are rejected.
    await this.setStatus(id, "stopped");
    await this.previewLifecycle?.stopForAgent(id);
    const stoppedAgent = this.getAgent(id);
    const before = this.store.snapshot();
    const previousAttachments = before.projectAgents.filter((item) => item.agentId === id);
    const archivedWorkspace = await this.workspaces.archive(stoppedAgent);
    try {
      await this.store.mutate((database) => {
        database.agents = database.agents.filter((item) => item.id !== id);
        database.agentConversations = database.agentConversations.filter(
          (item) => item.agentId !== id,
        );
        database.messages = database.messages.filter((item) => item.agentId !== id);
        database.runs = database.runs.filter((item) => item.agentId !== id);
        database.previews = database.previews.filter((item) => item.agentId !== id);
        // Cancellation has settled any active Project turn, so these records
        // cannot be live anymore. Remove both membership and lease remnants so
        // a deleted Agent can never retain Project authority or block a writer.
        database.projectAgents = database.projectAgents.filter(
          (item) => item.agentId !== id,
        );
        database.projectLeases = database.projectLeases.filter(
          (item) => item.agentId !== id,
        );
      });
      await this.permitDirectory?.reconcile();
      return { archivedWorkspace };
    } catch (error) {
      // Deletion is a privileged directory mutation. Reconstitute the Agent
      // and its Project memberships if synchronization fails, then restore
      // the physical workspace so the local facts and authority can retry.
      await this.store.mutate((database) => {
        database.agents = database.agents.filter((item) => item.id !== id);
        const previousAgent = before.agents.find((item) => item.id === id);
        database.agents.push(structuredClone(previousAgent ?? stoppedAgent));
        database.agentConversations = database.agentConversations.filter(
          (item) => item.agentId !== id,
        );
        database.agentConversations.push(
          ...before.agentConversations
            .filter((item) => item.agentId === id)
            .map((item) => structuredClone(item)),
        );
        database.messages = database.messages.filter((item) => item.agentId !== id);
        database.messages.push(
          ...before.messages
            .filter((item) => item.agentId === id)
            .map((item) => structuredClone(item)),
        );
        database.runs = database.runs.filter((item) => item.agentId !== id);
        database.runs.push(
          ...before.runs
            .filter((item) => item.agentId === id)
            .map((item) => structuredClone(item)),
        );
        database.previews = database.previews.filter((item) => item.agentId !== id);
        database.previews.push(
          ...before.previews
            .filter((item) => item.agentId === id)
            .map((item) => structuredClone(item)),
        );
        database.projectAgents = database.projectAgents.filter(
          (item) => item.agentId !== id,
        );
        database.projectAgents.push(...previousAttachments.map((item) => structuredClone(item)));
        database.projectLeases = database.projectLeases.filter(
          (item) => item.agentId !== id,
        );
        database.projectLeases.push(
          ...before.projectLeases
            .filter((item) => item.agentId === id)
            .map((item) => structuredClone(item)),
        );
      });
      await this.workspaces.restore(stoppedAgent, archivedWorkspace).catch(() => undefined);
      throw error;
    }
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
    return this.conversations.getMessages(agentId, options);
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
    return this.runCoordinator.waitForRun(runId, options);
  }

  async cancelRun(runId: string): Promise<AgentRun> {
    return this.runCoordinator.cancelRun(runId);
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
      /** Parent orchestration ID for Team turns. */
      orchestrationId?: string | undefined;
    } = {},
  ): Promise<{ run: AgentRun; message: Message }> {
    if (this.runCoordinator.isCancelling(agentId)) {
      throw new HttpError(409, "This Agent is currently being cancelled");
    }
    const agentBeforeRun = this.getAgent(agentId);
    // Validate Project membership before a Run record exists, so an
    // unattached or unauthorized Agent never leaves a queued run behind. This
    // intentionally precedes runtime credential/model checks as well.
    const projectId = options.projectId;
    if (projectId !== undefined) {
      await this.requireProjectScope().assertRunnable(projectId, agentId);
    }
    if (!this.config.arkApiKey || this.config.arkApiKey.startsWith("replace-")) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        503,
        "Worker runtime credentials are not configured.",
      );
    }
    const runtimeModel = this.modelResolver.resolve(agentBeforeRun.modelRef);
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
    this.runCoordinator.start(
      agentAtStart,
      run,
      runtimeModel,
      projectId,
      origin,
      conversation,
      options.orchestrationId,
    );
    return { run, message };
  }

  /**
   * Aggregate usage across every scope from one consistent store snapshot.
   *
   * Reading the snapshot directly rather than the bounded audit query keeps
   * the report complete: `AuditReader.query` caps results for HTTP callers.
   */
  usageReport(options: UsageReportOptions = {}): UsageReport {
    const snapshot = this.store.snapshot();
    return buildUsageReport(
      {
        agents: snapshot.agents,
        runs: snapshot.runs,
        messages: snapshot.messages,
        orchestrations: snapshot.orchestrations,
        orchestrationTurns: snapshot.orchestrationTurns,
        projects: snapshot.projects,
        auditEvents: snapshot.auditEvents,
      },
      options,
    );
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

  private requireProjectScope(): ProjectExecutionScope {
    if (!this.projectScope) {
      throw new HttpError(503, "Project execution is not configured");
    }
    return this.projectScope;
  }

  private normalizeSkillIds(skillIds: string[] | undefined): string[] {
    if (skillIds === undefined) return [];
    if (!Array.isArray(skillIds)) throw new TypeError("skillIds must be an array");
    if (this.skillService) return this.skillService.validateSkillIds(skillIds);
    if (skillIds.some((skillId) => typeof skillId !== "string")) {
      throw new TypeError("skillIds must contain strings");
    }
    return [...new Set(skillIds)];
  }

  private async runtimeSkillContext(
    agent: Agent,
    projectId?: string,
    runId?: string,
    orchestrationId?: string,
  ): Promise<SkillRuntimeContext | undefined> {
    if (!this.skillService) return undefined;
    try {
      return await this.skillService.runtimeContext(agent, projectId, runId, orchestrationId);
    } catch {
      // Skills are additive runtime guidance. A transient capability lookup
      // must never make an otherwise valid Agent impossible to edit or run.
      return undefined;
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
    await this.runCoordinator.cancelExecution(agentId);
  }
}
