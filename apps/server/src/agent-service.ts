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
import type { Storage } from "./store.js";
import type {
  Agent,
  AgentAppearance,
  AgentConversation,
  AgentModelSnapshot,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  MessageOrigin,
  OperationOptions,
  RuntimeReconciliationResult,
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
import type {
  SkillRuntimeContext,
  SkillRuntimeProjection,
} from "./skills/skill-types.js";
import type { SkillService } from "./skills/skill-service.js";
import { AgentRuntimePromptComposer } from "./agent-runtime-prompt.js";
import type { RuntimeTelemetry } from "./telemetry/telemetry-types.js";
import type { AuditRecorder } from "./audit/audit-types.js";
import type { McpSessionService } from "./tools/mcp-session-service.js";
import type { EffectiveToolResolution } from "./tools/effective-tool-resolver.js";
import { buildUsageReport } from "./usage/usage-aggregator.js";
import type { UsageReport, UsageReportOptions } from "./usage/usage-types.js";
import { normalizeAppearance } from "./agent-appearance.js";
import { AgentRoleSchema } from "./roles/role-types.js";
import { RoleError } from "./roles/role-service.js";
import type {
  ApplicationLifecycleFailure,
  ApplicationLifecycleFailureSink,
} from "./application-health.js";
import { reconcileLocalProcessStartup } from "./runtime-reconciliation.js";

const now = () => new Date().toISOString();
const STARTUP_RUNTIME_RECOVERY_MESSAGE =
  "Startup could not verify the previous local runtime; operator recovery is required before this Agent can run";

export type EffectiveToolResolutionReader = (
  agent: Agent,
  projectId: string | undefined,
  projection: SkillRuntimeProjection | undefined,
) => EffectiveToolResolution;

function operationError(operation: OperationOptions): Error | undefined {
  if (operation.signal?.aborted) {
    const reason = operation.signal.reason;
    if (reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
      return reason;
    }
    const error = new Error("Operation was aborted");
    error.name = "AbortError";
    return error;
  }
  if (
    operation.deadlineAt !== undefined &&
    Number.isFinite(operation.deadlineAt) &&
    Date.now() >= operation.deadlineAt
  ) {
    const error = new Error("Operation timed out");
    error.name = "TimeoutError";
    return error;
  }
  return undefined;
}

function assertOperationActive(operation: OperationOptions): void {
  const error = operationError(operation);
  if (error) throw error;
}

/** Optional helpers are supplied by the canonical Ark resolver. Keeping them
 * optional preserves the small WorkerModelResolver injection seam for tests
 * and future providers. */
type AgentModelResolver = WorkerModelResolver & {
  defaultModelRef?: () => ModelRef | undefined;
  effectiveModelRef?: (modelRef: ModelRef | undefined) => ModelRef | undefined;
  /** Optional revision exposed by a live model catalog implementation. */
  getCatalogRevision?: () => string | number | undefined;
  catalogRevision?: () => string | number | undefined;
  /** Refresh the live provider snapshot before validating an assignment. */
  refresh?: () => Promise<void>;
};

interface AgentRuntimeModelPlan {
  primaryRef: ModelRef;
  fallbackRefs: ModelRef[];
  primary: WorkerRuntimeModelConfig;
  fallbacks: WorkerRuntimeModelConfig[];
  snapshot: AgentModelSnapshot;
}

function modelRefListEqual(
  left: readonly ModelRef[] | undefined,
  right: readonly ModelRef[] | undefined,
): boolean {
  const leftList = left ?? [];
  const rightList = right ?? [];
  return (
    leftList.length === rightList.length &&
    leftList.every((item, index) => modelRefsEqual(item, rightList[index]))
  );
}

export class AgentService {
  private readonly conversations: AgentConversationService;
  private readonly runCoordinator: AgentRunCoordinator;
  private previewLifecycle: PreviewLifecycleCleanup | undefined;
  private previewContext: PreviewContextProvider | undefined;
  private projectScope: ProjectExecutionScope | undefined;
  private mcpSessions: McpSessionService | undefined;
  private skillService: SkillService | undefined;
  private effectiveToolResolution: EffectiveToolResolutionReader | undefined;
  private telemetry: RuntimeTelemetry | undefined;
  private audit: AuditRecorder | undefined;
  private lifecycleFailureSink: ApplicationLifecycleFailureSink | undefined;
  private startupReconciliation: RuntimeReconciliationResult | undefined;
  private readonly startupRecoveryAgents = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: Storage,
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
      getEffectiveToolResolution: () => this.effectiveToolResolution,
      getTelemetry: () => this.telemetry,
      getAudit: () => this.audit,
      getRun: (runId) => this.getRun(runId),
      reportLifecycleFailure: (failure: ApplicationLifecycleFailure) =>
        this.lifecycleFailureSink?.reportLifecycleFailure(failure),
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

  /** Attach the discovery-only resolver after roles, skills, and tools exist. */
  setEffectiveToolResolution(reader: EffectiveToolResolutionReader): void {
    this.effectiveToolResolution = reader;
  }

  /** Attach runtime telemetry after the service graph has been assembled. */
  setTelemetry(telemetry: RuntimeTelemetry): void {
    this.telemetry = telemetry;
  }

  /** Attach the server-owned audit sink used for model fallback evidence. */
  setAuditRecorder(audit: AuditRecorder): void {
    this.audit = audit;
  }

  /** Attach the application-owned lifecycle failure sink after app assembly. */
  setLifecycleFailureSink(sink: ApplicationLifecycleFailureSink): void {
    this.lifecycleFailureSink = sink;
  }

  /** Supply the one startup reconciliation result shared with Project/Preview. */
  setStartupReconciliation(result: RuntimeReconciliationResult): void {
    this.startupReconciliation = {
      provider: result.provider,
      confirmedAgentIds: [...result.confirmedAgentIds],
      confirmedPreviewIds: [...result.confirmedPreviewIds],
      unresolvedAgentIds: [...result.unresolvedAgentIds],
      unresolvedPreviewIds: [...result.unresolvedPreviewIds],
    };
  }

  getStartupReconciliation(): RuntimeReconciliationResult | undefined {
    if (this.startupReconciliation === undefined) return undefined;
    return {
      provider: this.startupReconciliation.provider,
      confirmedAgentIds: [...this.startupReconciliation.confirmedAgentIds],
      confirmedPreviewIds: [...this.startupReconciliation.confirmedPreviewIds],
      unresolvedAgentIds: [...this.startupReconciliation.unresolvedAgentIds],
      unresolvedPreviewIds: [...this.startupReconciliation.unresolvedPreviewIds],
    };
  }

  /**
   * Quiesce direct and Team Agent runs after a fatal storage transition. The
   * coordinator uses only its in-memory execution handles on this path.
   */
  async quiesceForStorageFailure(options: { timeoutMs?: number } = {}): Promise<void> {
    await this.runCoordinator.quiesceForStorageFailure(options);
  }

  /** Physical-only cancellation used by Team fatal-storage quiescence. */
  async cancelRunForStorageFailure(runId: string): Promise<void> {
    await this.runCoordinator.cancelRunForStorageFailure(runId);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    if (this.startupReconciliation === undefined) {
      const snapshot = this.store.snapshot();
      this.startupReconciliation =
        (await this.runner.reconcileStartup?.(snapshot)) ??
        reconcileLocalProcessStartup(snapshot);
    }
    this.startupRecoveryAgents.clear();
    for (const agentId of this.startupReconciliation.unresolvedAgentIds) {
      this.startupRecoveryAgents.add(agentId);
    }
    await this.skillService?.reconcileInstalledSkills(this.store);
    await this.skillService?.reconcileAgentSkillIds(this.store);
    await this.workspaces.initialize();
    const startupRecoveryAgents = this.startupRecoveryAgents;
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          if (startupRecoveryAgents.has(run.agentId)) continue;
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (startupRecoveryAgents.has(agent.id)) {
          agent.status = "error";
          agent.lastError = STARTUP_RUNTIME_RECOVERY_MESSAGE;
          agent.updatedAt = now();
        } else if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }

        // Legacy Agents may not have a modelRef. Keep them readable, but do
        // not silently assign a global/default model: they must be edited
        // before they can be run.
        if (agent.modelRef !== undefined) {
          // Normalize persisted whitespace/reasoning shape without resolving
          // it here: a removed catalog entry must remain visible and should
          // invalidate only new execution, not server startup.
          try {
            const normalized = normalizeModelRef(agent.modelRef);
            if (!modelRefsEqual(agent.modelRef, normalized)) {
              agent.modelRef = normalized;
              agent.updatedAt = now();
            }
          } catch {
            // Preserve malformed legacy data for the Agent settings surface;
            // sendMessage will return the stable model configuration error.
          }
        }

        if (Array.isArray(agent.fallbackModelRefs)) {
          try {
            const normalized = this.normalizeFallbackModelRefs(
              agent.fallbackModelRefs,
              agent.modelRef,
              false,
            );
            if (!modelRefListEqual(agent.fallbackModelRefs, normalized)) {
              agent.fallbackModelRefs = normalized;
              agent.updatedAt = now();
            }
          } catch {
            // As with a removed primary, retain malformed/removed fallbacks so
            // the UI can show the assignment and an operator can replace it.
          }
        }
      }
      this.conversations.migrateLegacyConversations(database);
    });

    // Existing private workspaces may still contain the pre-runtime skill
    // payload. Refresh only known platform-managed files; arbitrary
    // AGENTS.md files and removed workspaces are intentionally left alone.
    // Migration is best effort so a filesystem problem does not change the
    // pre-existing startup behavior for otherwise readable Agents.
    await Promise.all(
      this.store.snapshot().agents
        .filter((agent) => !this.startupRecoveryAgents.has(agent.id))
        .map((agent) =>
          this.workspaces.refreshInstructions(agent).catch(() => undefined),
        ),
    );
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
    const globalRoleId = this.validateGlobalRoleId(input.globalRoleId);
    if (input.skillIds !== undefined) {
      await this.skillService?.authorizeAssignment([], input.skillIds, id);
    }
    if (input.modelRef === undefined) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "A primary worker model must be selected when creating an Agent.",
      );
    }
    if (input.modelRef !== undefined || input.fallbackModelRefs !== undefined) {
      await this.refreshWorkerModelCatalog();
    }
    const modelRef = this.resolveModelRefForCreate(input.modelRef);
    const fallbackModelRefs = this.normalizeFallbackModelRefs(
      input.fallbackModelRefs,
      modelRef,
      true,
    );
    const skillIds = this.normalizeSkillIds(input.skillIds);
    const appearance = normalizeAppearance(input.appearance);
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      skillIds,
      ...(globalRoleId === undefined ? {} : { globalRoleId }),
      ...(appearance === undefined ? {} : { appearance }),
      status: "ready",
      modelRef,
      ...(input.fallbackModelRefs === undefined && fallbackModelRefs.length === 0
        ? {}
        : { fallbackModelRefs }),
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let workspaceCreated = false;
    let persisted = false;
    try {
      await this.workspaces.create(agent);
      workspaceCreated = true;
      await this.store.mutate((database) => database.agents.push(agent));
      persisted = true;
      return agent;
    } catch (error) {
      // Compensate any local mutation and archive the just-created workspace
      // before surfacing a failed create.
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
    if (current.modelRef === undefined && input.modelRef === undefined) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "This legacy Agent has no primary worker model; edit it before running or saving it.",
      );
    }
    if (input.modelRef !== undefined || input.fallbackModelRefs !== undefined) {
      await this.refreshWorkerModelCatalog();
    }
    const nextGlobalRoleId =
      input.globalRoleId === undefined
        ? current.globalRoleId
        : this.validateGlobalRoleId(input.globalRoleId);
    const currentEffectiveModelRef = this.effectiveModelRef(current.modelRef);
    const nextModelRef =
      input.modelRef === undefined
        ? currentEffectiveModelRef
        : this.effectiveModelRef(input.modelRef);
    if (nextModelRef === undefined) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        503,
        "The Agent has no configured primary worker model.",
      );
    }
    const currentFallbackModelRefs = current.fallbackModelRefs ?? [];
    let nextFallbackModelRefs = structuredClone(currentFallbackModelRefs);
    if (input.fallbackModelRefs !== undefined) {
      nextFallbackModelRefs = this.normalizeFallbackModelRefs(
        input.fallbackModelRefs,
        nextModelRef,
        true,
      );
    } else {
      try {
        nextFallbackModelRefs = this.normalizeFallbackModelRefs(
          currentFallbackModelRefs,
          nextModelRef,
          false,
        );
      } catch (error) {
        // Keep a removed/malformed legacy fallback visible while unrelated
        // fields are edited. Changing the primary in that state is rejected
        // because it could create a duplicate assignment silently.
        if (input.modelRef !== undefined) throw error;
      }
    }
    const nextSkillIds =
      input.skillIds === undefined
        ? current.skillIds
        : this.normalizeSkillIds(input.skillIds);
    if (input.modelRef !== undefined) {
      // Validate before entering the store mutation so invalid model changes
      // cannot partially update the Agent or its workspace instructions.
      this.modelResolver.resolve(nextModelRef);
    }
    const modelChanged =
      !modelRefsEqual(currentEffectiveModelRef, nextModelRef) ||
      !modelRefListEqual(currentFallbackModelRefs, nextFallbackModelRefs);
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
      if (input.globalRoleId !== undefined) {
        if (nextGlobalRoleId === undefined) {
          delete agent.globalRoleId;
        } else {
          agent.globalRoleId = nextGlobalRoleId;
        }
      }
      // New and updated Agents always carry an explicit primary assignment.
      // This also upgrades a legacy Agent when any other field is edited.
      agent.modelRef = nextModelRef;
      if (input.fallbackModelRefs !== undefined || nextFallbackModelRefs.length > 0) {
        agent.fallbackModelRefs = nextFallbackModelRefs;
      } else {
        delete agent.fallbackModelRefs;
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
      await this.workspaces.writeInstructions(updated);
      return updated;
    } catch (error) {
      // Restore both the persisted identity fact and generated instructions if
      // writing the local workspace failed.
      await this.store.mutate((database) => {
        const stored = database.agents.find((item) => item.id === id);
        if (stored) Object.assign(stored, structuredClone(before));
      });
      await this.workspaces
        .writeInstructions(before)
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Cosmetic character update.
   *
   * Deliberately not part of `updateAgent`: appearance is never in the runtime
   * prompt, so a recolour must not rewrite AGENTS.md or be rolled back when
   * workspace instructions are unavailable. It is also allowed while the Agent is
   * busy, because restyling a working Agent changes nothing about the run.
   */
  async updateAgentAppearance(
    id: string,
    appearance: AgentAppearance,
  ): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      // Merged field by field, so setting one knob keeps the other choices.
      const merged = normalizeAppearance({
        ...(agent.appearance ?? {}),
        ...appearance,
      });
      if (merged === undefined) delete agent.appearance;
      else agent.appearance = merged;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
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

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string | null }> {
    const agent = this.getAgent(id);
    if (this.startupRecoveryAgents.has(id)) {
      // A local runtime identity may still be alive after restart. Deleting
      // its row would erase the only durable owner evidence and bypass the
      // same recovery gate used by start/sendMessage.
      throw new HttpError(409, STARTUP_RUNTIME_RECOVERY_MESSAGE);
    }
    await this.cancelExecution(id);
    // Close the PreviewService start gate before cleanup. Any start already
    // holding the per-Agent preview lock completes first and is then stopped;
    // later starts observe the stopped Agent and are rejected.
    await this.setStatus(id, "stopped");
    await this.previewLifecycle?.stopForAgent(id);
    const stoppedAgent = this.getAgent(id);
    const before = this.store.snapshot();
    const previousAttachments = before.projectAgents.filter((item) => item.agentId === id);
    const hasProjectOwnership =
      previousAttachments.length > 0 ||
      before.projectLeases.some((item) => item.agentId === id);
    const beginAgentDeletion = this.projectScope?.beginAgentDeletion;
    if (hasProjectOwnership && beginAgentDeletion === undefined) {
      throw new HttpError(
        503,
        "Project deletion coordination is not configured; retry after Project services are initialized",
      );
    }
    const releaseProjectMutation =
      this.projectScope?.beginAgentDeletion?.(id) ?? (() => undefined);
    try {
      const archivedWorkspace = await this.workspaces.archive(stoppedAgent);
      const deletedAt = now();
      try {
        await this.store.mutate((database) => {
          database.agents = database.agents.filter((item) => item.id !== id);
          database.agentConversations = database.agentConversations.filter(
            (item) => item.agentId !== id,
          );
          database.messages = database.messages.filter((item) => item.agentId !== id);
          // Runs are historical execution records, not Agent state: they are
          // retained and tombstoned so their traces and audit evidence stay
          // understandable once the live Agent record is gone.
          for (const run of database.runs) {
            if (run.agentId !== id) continue;
            if (run.agentName === undefined) run.agentName = stoppedAgent.name;
            run.agentDeletedAt = deletedAt;
          }
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
          // Membership is not the only place an Agent is listed. A draft
          // Conversation is still being composed, so a roster entry pointing at
          // an Agent that no longer exists is stale rather than historical: it
          // keeps a desk in the room, and starting the Conversation fails with
          // AGENT_NOT_FOUND until the whole thing is deleted. Started and
          // finished Conversations keep their roster verbatim, because those
          // records explain runs that actually happened.
          for (const session of database.orchestrations) {
            if (session.status !== "draft") continue;
            if (!session.participants.some((item) => item.agentId === id)) continue;
            session.participants = session.participants
              .filter((item) => item.agentId !== id)
              .map((item, position) => ({ ...item, position }));
            session.updatedAt = deletedAt;
          }
        });
        return { archivedWorkspace };
      } catch (error) {
        // Reconstitute the Agent and its Project memberships if local cleanup
        // fails, then restore the physical workspace so the operation can retry.
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
          // Restore the draft rosters this delete trimmed, so a failed cleanup
          // leaves the Agent exactly as usable as it was before it was tried.
          for (const session of database.orchestrations) {
            const original = before.orchestrations.find((item) => item.id === session.id);
            if (!original || original.status !== "draft") continue;
            if (!original.participants.some((item) => item.agentId === id)) continue;
            session.participants = structuredClone(original.participants);
            session.updatedAt = original.updatedAt;
          }
        });
        if (archivedWorkspace !== null) {
          await this.workspaces.restore(stoppedAgent, archivedWorkspace).catch(() => undefined);
        }
        throw error;
      }
    }
    finally {
      releaseProjectMutation();
    }
  }

  async startAgent(id: string): Promise<Agent> {
    if (this.startupRecoveryAgents.has(id)) {
      throw new HttpError(409, STARTUP_RUNTIME_RECOVERY_MESSAGE);
    }
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
      /** Audit span this Run's span should be parented under. */
      parentSpan?: { traceId: string; spanId: string } | undefined;
      /** Control-plane cancellation for pre-acceptance work. */
      signal?: AbortSignal;
      /** Absolute deadline covering validation and acceptance. */
      deadlineAt?: number;
    } = {},
  ): Promise<{ run: AgentRun; message: Message }> {
    const operation: OperationOptions = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
    };
    assertOperationActive(operation);
    if (this.runCoordinator.isCancelling(agentId)) {
      throw new HttpError(409, "This Agent is currently being cancelled");
    }
    const agentBeforeRun = this.getAgent(agentId);
    if (this.startupRecoveryAgents.has(agentId)) {
      throw new HttpError(409, STARTUP_RUNTIME_RECOVERY_MESSAGE);
    }
    // Validate Project membership before a Run record exists, so an
    // unattached or unauthorized Agent never leaves a queued run behind. This
    // intentionally precedes runtime credential/model checks as well.
    const projectId = options.projectId;
    if (projectId !== undefined) {
      await this.requireProjectScope().assertRunnable(projectId, agentId, operation);
      assertOperationActive(operation);
    }
    if (agentBeforeRun.modelRef === undefined) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "This legacy Agent has no primary worker model; edit it before running.",
      );
    }
    if (!this.config.arkApiKey || this.config.arkApiKey.startsWith("replace-")) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        503,
        "Worker runtime credentials are not configured.",
      );
    }
    // Resolve the complete assignment before creating a queued Run. The
    // resolver is the catalog authority, so removed providers/models produce
    // a stable error and never leave an orphaned queued record behind.
    await this.refreshWorkerModelCatalog();
    assertOperationActive(operation);
    const modelPlan = this.resolveAgentModelPlan(agentBeforeRun);
    // Only direct Playground turns belong to a private conversation. Team turns
    // keep their own session scope and stay out of private history entirely.
    const origin: MessageOrigin = options.origin ?? "direct";
    const conversation =
      origin === "direct" && projectId === undefined
        ? await this.resolveConversation(agentId, options.conversationId)
        : null;
    assertOperationActive(operation);
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      // Snapshotted so the Run stays readable after the Agent is deleted.
      agentName: agentBeforeRun.name,
      ...(conversation === null ? {} : { conversationId: conversation.id }),
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      modelSnapshot: modelPlan.snapshot,
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
    assertOperationActive(operation);
    const agentAtStart = await this.store.mutate((database) => {
      // Storage serializes this callback. Checking again inside the mutation
      // prevents a cancellation observed while the acceptance write waited in
      // the queue from creating a Run after the operation stopped.
      assertOperationActive(operation);
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
      // Agent edits are rejected while busy, but a model update may have
      // completed between the read above and this atomic queue mutation. Do
      // not run with a stale assignment in that race.
      const storedPrimary = this.effectiveModelRef(storedAgent.modelRef);
      const storedFallbacks = storedAgent.fallbackModelRefs ?? [];
      const currentCatalogRevision = this.readCatalogRevision();
      if (
        !modelRefsEqual(storedPrimary, modelPlan.primaryRef) ||
        !modelRefListEqual(storedFallbacks, modelPlan.fallbackRefs) ||
        (modelPlan.snapshot.catalogRevision !== undefined &&
          currentCatalogRevision !== modelPlan.snapshot.catalogRevision)
      ) {
        throw new HttpError(409, "Agent model assignments changed; retry the Run");
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
      modelPlan.primary,
      projectId,
      origin,
      conversation,
      options.orchestrationId,
      modelPlan.fallbacks,
      modelPlan.snapshot,
      options.parentSpan,
      operation,
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

  /** Validate a role reference before changing the Agent identity record. */
  private validateGlobalRoleId(globalRoleId: string | null | undefined): string | undefined {
    if (globalRoleId === undefined || globalRoleId === null) return undefined;
    const role = this.store.snapshot().roles.find((item) => item.id === globalRoleId);
    if (!role || !AgentRoleSchema.safeParse(role).success) {
      throw new RoleError("ROLE_NOT_FOUND", "Role not found");
    }
    return globalRoleId;
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

  private resolveModelRefForCreate(modelRef: ModelRef | undefined): ModelRef {
    const effective = this.effectiveModelRef(modelRef);
    // Validate before creating the workspace/store record. In particular, a
    // malformed explicit ref must not leave a partially-created Agent behind.
    if (effective === undefined) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        503,
        "The Agent has no configured primary worker model.",
      );
    }
    this.modelResolver.resolve(effective);
    return structuredClone(effective);
  }

  private async refreshWorkerModelCatalog(): Promise<void> {
    await this.modelResolver.refresh?.();
  }

  private effectiveModelRef(modelRef: ModelRef | undefined): ModelRef | undefined {
    if (this.modelResolver.effectiveModelRef) {
      return this.modelResolver.effectiveModelRef(modelRef);
    }
    if (modelRef !== undefined) return normalizeModelRef(modelRef);
    return undefined;
  }

  /**
   * Normalize an Agent's ordered fallback list and, when requested, resolve
   * each entry through the same runtime/catalog authority as the primary.
   * Removed entries intentionally remain persistable so settings can show an
   * unavailable assignment and let an operator replace it.
   */
  private normalizeFallbackModelRefs(
    fallbackModelRefs: readonly ModelRef[] | undefined,
    primaryModelRef: ModelRef | undefined,
    validate: boolean,
  ): ModelRef[] {
    if (fallbackModelRefs === undefined) return [];
    if (!Array.isArray(fallbackModelRefs)) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "Fallback worker models must be an array.",
      );
    }
    const normalized: ModelRef[] = [];
    for (const fallback of fallbackModelRefs) {
      const modelRef = normalizeModelRef(fallback);
      if (primaryModelRef !== undefined && modelRefsEqual(modelRef, primaryModelRef)) {
        throw new ModelCatalogError(
          "MODEL_RUNTIME_CONFIGURATION_INVALID",
          422,
          "A fallback worker model must differ from the primary model.",
        );
      }
      if (normalized.some((item) => modelRefsEqual(item, modelRef))) {
        throw new ModelCatalogError(
          "MODEL_RUNTIME_CONFIGURATION_INVALID",
          422,
          "Fallback worker models must be unique and ordered.",
        );
      }
      if (validate) this.modelResolver.resolve(modelRef);
      normalized.push(modelRef);
    }
    return normalized;
  }

  /** Resolve and snapshot the complete assignment for one accepted Run. */
  private resolveAgentModelPlan(agent: Agent): AgentRuntimeModelPlan {
    const primaryRef = this.effectiveModelRef(agent.modelRef);
    if (primaryRef === undefined) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        503,
        "The Agent has no configured primary worker model.",
      );
    }
    const normalizedPrimary = normalizeModelRef(primaryRef);
    const fallbackRefs = this.normalizeFallbackModelRefs(
      agent.fallbackModelRefs,
      normalizedPrimary,
      true,
    );
    const catalogRevision = this.readCatalogRevision();
    return {
      primaryRef: normalizedPrimary,
      fallbackRefs,
      primary: this.modelResolver.resolve(normalizedPrimary),
      fallbacks: fallbackRefs.map((modelRef) => this.modelResolver.resolve(modelRef)),
      snapshot: {
        modelRef: structuredClone(normalizedPrimary),
        fallbackModelRefs: structuredClone(fallbackRefs),
        ...(catalogRevision === undefined ? {} : { catalogRevision }),
      },
    };
  }

  private readCatalogRevision(): string | number | undefined {
    const resolver = this.modelResolver;
    const candidate =
      typeof resolver.getCatalogRevision === "function"
        ? resolver.getCatalogRevision()
        : typeof resolver.catalogRevision === "function"
          ? resolver.catalogRevision()
          : undefined;
    return typeof candidate === "string" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
      ? candidate
      : undefined;
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
