import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { PostgresStore as MastraPostgresStore } from "@mastra/pg";
import { InMemoryStore } from "@mastra/core/storage";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { AgentService } from "./agent-service.js";
import { createAgentAuthoringService } from "./agent-authoring.js";
import { createApp } from "./app.js";
import {
  isArkConfigured,
  toolApprovalStartupDiagnostic,
  writeCodexConfig,
  type AppConfig,
} from "./config.js";
import { createRunner } from "./runner-factory.js";
import {
  ArkModelCatalogService,
  ArkLiveModelState,
  ArkManagementClient,
  ModelCatalogError,
  createModelRegistry,
  createWorkerModelResolver,
  normalizeModelRef,
  findAgentsOnReservedModel,
} from "./models/index.js";
import type { WorkerModelResolver } from "./models/types.js";
import {
  JsonStore,
  normalizeDatabase,
  type Storage,
} from "./store.js";
import { PostgresStore } from "./persistence/postgres-store.js";
import type { AgentRunner, Database } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { OrchestrationService } from "./orchestration/orchestration-service.js";
import {
  ArkResponsesSupervisorProvider,
  createOrchestrationParticipantSelector,
} from "./orchestration/supervisor/index.js";
import { RepositoryAuthorizationService } from "./access/repository-authorization-service.js";
import { RoleTemplateAuthorizationService } from "./access/role-template-authorization-service.js";
import { LocalContainerPreviewRuntime } from "./preview/local-container-preview-runtime.js";
import { PreviewCommandResolver } from "./preview/preview-command-resolver.js";
import { StorePreviewContextProvider } from "./preview/preview-context-provider.js";
import { ProjectService } from "./projects/project-service.js";
import { ProjectServiceExecutionScope } from "./projects/project-execution.js";
import { GitWorkspaceCheckpointStore } from "./projects/git-workspace-checkpoint-store.js";
import { WorkspaceCheckpointService } from "./projects/workspace-checkpoint-service.js";
import { WorkspaceOperationCoordinator } from "./projects/workspace-operation-coordinator.js";
import { createWorkspaceRecoveryFacade } from "./projects/workspace-recovery-facade.js";
import { createSearchProvider } from "./tools/search-provider-factory.js";
import { WebFetchAdapter } from "./tools/web-fetch-adapter.js";
import { McpSessionService } from "./tools/mcp-session-service.js";
import { EffectiveToolResolver } from "./tools/effective-tool-resolver.js";
import {
  createBuiltInToolRegistry,
  ToolService,
} from "./tools/tool-service.js";
import { createBuiltInSkillRegistry, SkillService } from "./skills/index.js";
import { RoleService } from "./roles/index.js";
import { ProjectWorkspaceManager } from "./projects/project-workspace.js";
import {
  PreviewService,
  previewResourceLimitsFromConfig,
} from "./preview/preview-service.js";
import { AuditService, StorageAuditStoreAdapter } from "./audit/audit-service.js";
import { createRuntimeTelemetry } from "./telemetry/runtime-telemetry.js";
import type { RuntimeTelemetry } from "./telemetry/telemetry-types.js";
import { AgentMetricsService } from "./usage/agent-metrics.js";
import { ApplicationHealth } from "./application-health.js";
import { reconcileLocalProcessStartup } from "./runtime-reconciliation.js";
import {
  ToolApprovalService,
} from "./tools/tool-approval-service.js";
import {
  ToolApprovalStore,
} from "./tools/tool-approval-store.js";
import { ToolApprovalWorkflowService } from "./tools/tool-approval-workflow.js";

const LIFECYCLE_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface BootstrapOptions {
  /**
   * Replaces the configured Codex runtime. Used by the deterministic
   * checkpoint demo harness and never selected by configuration: there is no
   * production switch that swaps a scripted worker in.
   */
  runner?: AgentRunner | undefined;
  /** Replaces the live ModelArk-backed worker resolver (offline demos, tests). */
  workerModelResolver?: WorkerModelResolver | undefined;
  /** Test/local injection seam for a verified native Mastra workflow store. */
  approvalWorkflowStorage?: MastraCompositeStore | undefined;
  /** Alias retained for callers that name the dependency after the feature. */
  toolApprovalWorkflowStorage?: MastraCompositeStore | undefined;
}

export interface BootstrappedApplication {
  app: FastifyInstance;
  config: AppConfig;
  store: Storage;
  telemetry: RuntimeTelemetry;
  applicationHealth: ApplicationHealth;
  agentService: AgentService;
  projectService: ProjectService;
  orchestrationService: OrchestrationService;
  workspaceCheckpoints: WorkspaceCheckpointService;
  workspaceOperations: WorkspaceOperationCoordinator;
  projectWorkspaces: ProjectWorkspaceManager;
  /** Present only when MCP tool approval is enabled and fully initialized. */
  toolApprovalService?: ToolApprovalService;
  /** Native workflow owner, exposed for bounded lifecycle tests/inspection. */
  toolApprovalWorkflowService?: ToolApprovalWorkflowService;
  /** Quiesce Agents and Teams, then close the app, store, and telemetry. */
  shutdown: (signal: string) => Promise<void>;
}

async function boundedLifecycleWait(
  operation: Promise<unknown>,
  timeoutMs = LIFECYCLE_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  const boundedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? timeoutMs
      : LIFECYCLE_SHUTDOWN_TIMEOUT_MS;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), boundedTimeout);
    timer.unref();
  });
  // Observe rejection even when the unhealthy shutdown deadline wins. The
  // owned lifecycle operation continues its own best-effort settlement.
  const observed = operation.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const hasDatabaseData = (database: Database): boolean =>
  database.modelCatalog !== null ||
  database.auditChainAnchor != null ||
  database.agents.length > 0 ||
  database.agentConversations.length > 0 ||
  database.messages.length > 0 ||
  database.runs.length > 0 ||
  database.orchestrations.length > 0 ||
  database.orchestrationTurns.length > 0 ||
  database.orchestrationEvents.length > 0 ||
  database.orchestrationContinuationPrompts.length > 0 ||
  database.previews.length > 0 ||
  database.projects.length > 0 ||
  database.projectAgents.length > 0 ||
  database.projectLeases.length > 0 ||
  database.approvalRequests.length > 0 ||
  database.capabilityGrants.length > 0 ||
  database.auditEvents.length > 0 ||
  database.permitApprovalCorrelations.length > 0 ||
  database.roles.length > 0 ||
  database.installedSkills.length > 0 ||
  database.workspaceCheckpoints.length > 0 ||
  database.workspaceExecutionCycles.length > 0 ||
  database.workspaceOperations.length > 0 ||
  database.toolApprovalInvocations.length > 0;

/**
 * The composition root. Everything the server is made of is assembled here
 * in dependency order, including startup reconciliation, and returned with
 * one shutdown function. `index.ts` only adds process signals and listens.
 */
export async function bootstrapApplication(
  config: AppConfig,
  options: BootstrapOptions = {},
): Promise<BootstrappedApplication> {
  const legacyJsonPath = path.join(config.dataDirectory, "launchpad.json");
  const applicationHealth = new ApplicationHealth();
  const store: Storage = config.persistenceBackend === "postgres"
    ? new PostgresStore(config.databaseUrl)
    : new JsonStore(legacyJsonPath);
  applicationHealth.attachStorage(store);
  const auditStore = new StorageAuditStoreAdapter(store);
  const audit = new AuditService(auditStore, auditStore, config.modelContextWindows);
  const telemetry = createRuntimeTelemetry(config);
  const workspaces = new WorkspaceManager(config.workspaceRoot);
  // `containerHealthSampler` is only set for the container runtime provider.
  const configuredRunner = options.runner === undefined ? createRunner(config) : undefined;
  const runner: AgentRunner = options.runner ?? configuredRunner!.runner;
  const containerHealthSampler = configuredRunner?.healthSampler;
  const mcpSessions = new McpSessionService(config.mcpTokenTtlMs, { audit });
  const modelCatalog = new ArkModelCatalogService(store);
  // ModelArk management credentials stay in this server-owned client/state and
  // are never copied into a worker environment or persisted catalog.
  const modelArkClient = new ArkManagementClient({
    accessKey: config.byteplusAccessKey,
    secretKey: config.byteplusSecretKey,
    region: config.byteplusRegion,
    baseUrl: config.byteplusManagementBaseUrl,
    timeoutMs: config.byteplusManagementTimeoutMs,
    maxResponseBytes: config.byteplusManagementMaxResponseBytes,
  });
  /**
   * The server-wide supervisor endpoint: the persisted operator override when
   * one is set, otherwise SUPERVISOR_MODEL. Resolved lazily because the catalog
   * is only initialized once the persistence checks below have passed.
   */
  const resolvedSupervisorModelId = (): string => {
    let override: string | undefined;
    try {
      override = modelCatalog.get().supervisorModelRef?.modelId;
    } catch {
      override = undefined;
    }
    const resolved = (override ?? config.supervisorModel).trim();
    return resolved.includes("replace-") ? "" : resolved;
  };
  const modelArkState = new ArkLiveModelState({
    client: modelArkClient,
    ttlMs: config.workerModelCacheTtlMs,
    reservedSupervisorModelId: resolvedSupervisorModelId,
  });

  try {
    await store.initialize();

    /**
     * A configured PostgreSQL backend must never make an existing local JSON
     * database look like a fresh installation. Import is deliberately offline;
     * startup only detects the unsafe collision and explains how to resolve it.
     */
    if (config.persistenceBackend === "postgres") {
      let rawLegacy: string;
      try {
        rawLegacy = await readFile(legacyJsonPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        rawLegacy = "";
      }
      if (rawLegacy.trim().length > 0) {
        let legacyDatabase: Database;
        try {
          legacyDatabase = normalizeDatabase(JSON.parse(rawLegacy));
        } catch (error) {
          throw new Error(
            `Cannot use PostgreSQL while ${legacyJsonPath} exists but is not a valid database: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (hasDatabaseData(legacyDatabase) && !hasDatabaseData(store.snapshot())) {
          throw new Error(
            `PostgreSQL persistence is empty while ${legacyJsonPath} contains data. ` +
            "Run the offline JSON import before starting with PERSISTENCE_BACKEND=postgres.",
          );
        }
      }
    }
  } catch (error) {
    // PostgreSQL may hold an advisory single-owner lock or pool handles after a
    // failed startup check. Release them before surfacing the actionable error.
    await store.close().catch(() => undefined);
    throw error;
  }

  // Avoid writing the shared Codex runtime configuration until persistence
  // ownership and legacy-data checks have completed successfully.
  await writeCodexConfig(config);
  await modelCatalog.initialize({
    provider: "volcengine_ark",
    baseUrl: config.arkBaseUrl,
    apiKeyEnv: "ARK_API_KEY",
    models: [...config.workerCuratedModels],
    defaultModelRef: null,
    revision: 1,
  });
  const workerModelResolver =
    options.workerModelResolver ??
    createWorkerModelResolver(config, {
      catalog: modelCatalog,
      liveCatalog: modelArkState,
      liveRefresh: () => modelArkState.refresh(),
      liveRevision: () => modelArkState.getCatalogRevision(),
    });
  const modelRegistry = createModelRegistry(config, {
    workerResolver: workerModelResolver,
    catalog: modelCatalog,
    modelArkState,
  });
  const service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    workerModelResolver,
  );
  service.setLifecycleFailureSink(applicationHealth);
  service.setAuditRecorder(audit);
  service.setMcpSessionService(mcpSessions);
  service.setTelemetry(telemetry);
  const agentMetrics = new AgentMetricsService({
    agents: () => service.listAgents(),
    runs: (agentId) => service.getRuns(agentId),
    audit,
    ...(containerHealthSampler === undefined ? {} : { healthSampler: containerHealthSampler }),
  });
  const policyAuthorization = new RepositoryAuthorizationService(store);
  const authorization = new RoleTemplateAuthorizationService(store, policyAuthorization);
  const projectWorkspaces = new ProjectWorkspaceManager(
    path.join(config.dataDirectory, "projects"),
  );
  const projectService = new ProjectService(
    store,
    projectWorkspaces,
    service,
    authorization,
  );
  projectService.setLifecycleFailureSink(applicationHealth);
  /**
   * Source checkpoints live in a private bare Git store beside, never inside,
   * the Project workspaces, so no Agent or preview mount can reach them. The
   * scanner is handed the runtime secrets privately so a copied credential can
   * never become a blob.
   */
  const checkpointStore = new GitWorkspaceCheckpointStore({
    privateRoot: path.join(config.dataDirectory, "workspace-checkpoints"),
    workspacePathFor: (projectId) => projectWorkspaces.workspacePath(projectId),
    gitBinary: config.workspaceCheckpointGitBin,
    configuredSecrets: () =>
      [config.arkApiKey, config.byteplusAccessKey, config.byteplusSecretKey, config.authToken, config.databaseUrl]
        .filter((value) => value.length >= 8 && !value.startsWith("replace-")),
  });
  const workspaceCheckpoints = new WorkspaceCheckpointService({
    store,
    gitStore: checkpointStore,
    enabled: config.workspaceCheckpointsEnabled,
    audit,
  });
  const workspaceOperations = new WorkspaceOperationCoordinator(store);
  const checkpointRuntimeSupported =
    config.runtimeProvider === "container" || config.workspaceCheckpointLocalProcess === "allow";
  projectService.setWorkspaceCheckpoints(workspaceCheckpoints, workspaceOperations, {
    settlementPolicy:
      config.runtimeProvider === "container" ? "require_proof" : "trust_process_exit",
    runtimeSupported: checkpointRuntimeSupported,
  });
  const previewRuntime = new LocalContainerPreviewRuntime(config);
  const previewService = new PreviewService(
    store,
    service,
    previewRuntime,
    new PreviewCommandResolver(),
    authorization,
    {
      resourceLimits: previewResourceLimitsFromConfig(config),
      telemetry,
      // Project previews serve the shared workspace the Team collaborates on.
      ownerResolver: {
        async resolve(owner) {
          if (owner.kind !== "project") {
            throw new Error("Unsupported preview owner");
          }
          return {
            workspacePath: projectWorkspaces.workspacePath(owner.projectId),
            label: "Project",
          };
        },
      },
    },
  );
  const previewContext = new StorePreviewContextProvider(store);
  projectService.setProjectPreviewLifecycle(previewService);
  // A Project preview is a workspace writer too; it may not start while a
  // checkpoint cycle or restore owns the Project.
  previewService.setWorkspaceAdmissionGuard((projectId) =>
    workspaceOperations.assertAdmission(store.snapshot(), projectId),
  );
  service.setPreviewLifecycle(previewService);
  service.setPreviewContextProvider(previewContext);
  service.setProjectExecutionScope(
    new ProjectServiceExecutionScope(projectService, (projectId) =>
      previewContext.getForProject(projectId).then((context) => context.status),
    ),
  );
  const searchProvider = createSearchProvider(config);
  const webFetch = new WebFetchAdapter({
    timeoutMs: config.webFetchTimeoutMs,
    maxResponseBytes: config.webFetchMaxResponseBytes,
    maxRedirects: config.webFetchMaxRedirects,
  });
  const toolRegistry = createBuiltInToolRegistry({
    search: searchProvider,
    fetch: webFetch,
    preview: previewService,
  });
  const toolService = new ToolService(
    toolRegistry,
    authorization,
    store,
    audit,
    telemetry,
  );
  const skillService = new SkillService(
    createBuiltInSkillRegistry(),
    toolService,
    authorization,
    audit,
    { store },
  );
  const roleService = new RoleService(store, toolService, skillService, authorization);
  toolService.setProjectRoleToolResolver(roleService);
  skillService.setProjectRoleSkillResolver(roleService);
  const effectiveToolResolver = new EffectiveToolResolver();
  // Approval mode is fixed at startup for every newly minted MCP Run. Keep
  // sensitive tools absent from new capability snapshots until the durable
  // projection and native workflow provider have both passed readiness.
  let approvalAvailable = !config.mcpToolApprovalEnabled;
  service.setEffectiveToolResolution((agent, projectId, projection) => {
    if (config.mcpScopedAdvertisement && projection === undefined) {
      return {
        ok: false,
        advertisedToolIds: [],
        diagnostics: {
          status: "failed",
          configuredCatalogueSize: toolRegistry.list().length,
          advertisedToolCount: 0,
          reason: "Runtime capability projection is unavailable",
        },
      };
    }
    const effectiveRole = roleService.getEffectiveRole(agent.id, projectId, agent);
    const resolution = effectiveToolResolver.resolve({
      registry: toolRegistry,
      ...(effectiveRole === undefined ? {} : { effectiveRole }),
      assignedSkills: projection?.skills ?? [],
      capabilities: projection?.toolCapabilities ?? [],
      legacyFullAdvertisement: !config.mcpScopedAdvertisement,
    });
    if (!config.mcpToolApprovalEnabled || approvalAvailable) return resolution;
    if (!resolution.ok) return resolution;
    const sensitiveIds = new Set(
      toolRegistry
        .list()
        .filter((definition) => definition.approvalPolicy?.mode === "required")
        .map((definition) => definition.id),
    );
    const advertisedToolIds = resolution.advertisedToolIds.filter((id) => !sensitiveIds.has(id));
    return {
      ...resolution,
      advertisedToolIds: Object.freeze(advertisedToolIds),
      diagnostics: {
        ...resolution.diagnostics,
        advertisedToolCount: advertisedToolIds.length,
      },
    };
  });
  service.setSkillService(skillService);
  projectService.setSkillService(skillService);
  // Reconcile disposable runtimes once, before any service can reset a busy
  // Agent or release a persisted Project writer lease. The same evidence is
  // passed to all lifecycle owners so startup cannot make independent guesses.
  const startupSnapshot = store.snapshot();
  const agentStartupReconciliation =
    (await runner.reconcileStartup?.(startupSnapshot)) ??
    reconcileLocalProcessStartup(startupSnapshot);
  // Agent local-process mode still owns the Agent safety gate, but previews use
  // disposable labeled containers regardless of that provider. Let the preview
  // runtime reconcile its own persisted IDs and merge the evidence before any
  // service resets status or leases.
  const previewStartupReconciliation =
    agentStartupReconciliation.provider === "local-process"
      ? await previewRuntime.reconcileStartup?.(startupSnapshot)
      : undefined;
  const union = (left: readonly string[], right: readonly string[]): string[] =>
    [...new Set([...left, ...right])].sort();
  const startupReconciliation = {
    provider: agentStartupReconciliation.provider,
    confirmedAgentIds: [...agentStartupReconciliation.confirmedAgentIds],
    confirmedPreviewIds: union(
      agentStartupReconciliation.confirmedPreviewIds,
      previewStartupReconciliation?.confirmedPreviewIds ?? [],
    ),
    unresolvedAgentIds: [...agentStartupReconciliation.unresolvedAgentIds],
    unresolvedPreviewIds: union(
      agentStartupReconciliation.unresolvedPreviewIds,
      previewStartupReconciliation?.unresolvedPreviewIds ?? [],
    ),
  };
  service.setStartupReconciliation(startupReconciliation);
  projectService.setStartupReconciliation(startupReconciliation);
  // Interrupted captures are reconciled before any service can refresh a
  // workspace or release a gate; nothing here dispatches an Agent.
  await workspaceCheckpoints.initialize();
  await service.initialize();
  await roleService.initialize();
  await previewService.initialize(startupReconciliation);
  await projectService.initialize(startupReconciliation);
  if (config.workspaceCheckpointsEnabled) {
    const capability = workspaceCheckpoints.capability();
    if (!capability.available) {
      console.warn(
        "Workspace checkpoints are enabled but unavailable (" +
          String(capability.errorCode) +
          "); Project conversations will be rejected until Git is reachable",
      );
    } else if (!checkpointRuntimeSupported) {
      console.warn(
        "Workspace checkpoints are enabled on the local-process runtime without WORKSPACE_CHECKPOINT_LOCAL_PROCESS=allow; Project conversations will be rejected",
      );
    }
  }

  /**
   * Report — never repair — Agents pointed at the reserved supervisor endpoint.
   *
   * Worker resolution rejects that endpoint, so an Agent assigned to it cannot
   * run. Booting used to rewrite those assignments to the catalog default, which
   * meant a restart silently moved an Agent onto a different model while its
   * owner was mid-conversation. A model assignment is the operator's choice, so
   * it is left exactly as persisted and the conflict is reported instead: the
   * Agent surfaces `modelConflict`, and changing the supervisor endpoint through
   * `PUT /api/supervisor-model` still offers the explicit, acknowledged move.
   */
  const reportReservedSupervisorEndpointConflicts = (
    log: { warn(details: unknown, message: string): void },
  ): void => {
    try {
      const reservedModelId = resolvedSupervisorModelId();
      if (reservedModelId.length === 0) return;
      for (const conflict of findAgentsOnReservedModel(service, reservedModelId)) {
        log.warn(
          { reservedModelId, ...conflict },
          "Agent is assigned to the endpoint reserved for supervisor routing and cannot run until it is reassigned",
        );
      }
    } catch (error) {
      log.warn(
        { error },
        "Could not check Agent assignments against the reserved supervisor endpoint",
      );
    }
  };

  // Credentials decide whether the selector exists at all. The model itself is
  // resolved per selection, so an operator can point the supervisor at a
  // different endpoint without restarting the server.
  /**
   * Optional writing help for the Agent form. It borrows the supervisor endpoint
   * when one is set and otherwise the catalog's default worker endpoint, so no
   * extra configuration is needed to turn it on and nothing is reserved for it.
   */
  const agentAuthoring = createAgentAuthoringService(config, () => {
    const supervisor = resolvedSupervisorModelId();
    if (supervisor.length > 0) return supervisor;
    try {
      return modelCatalog.get().defaultModelRef?.modelId ?? "";
    } catch {
      return "";
    }
  });

  const supervisorSelector = isArkConfigured(config)
    ? createOrchestrationParticipantSelector(
        new ArkResponsesSupervisorProvider({
          apiKey: config.arkApiKey,
          baseUrl: config.arkBaseUrl,
          model: config.supervisorModel,
          timeoutMs: config.supervisorTimeoutMs,
        }),
      )
    : undefined;
  const orchestrationService = new OrchestrationService({
    store,
    agentService: service,
    audit,
    // Attaching here keeps Project membership rules inside ProjectService while
    // letting each Conversation declare its shared Workspace at creation time.
    projectBinding: {
      async bindConversation(projectId, conversationId, agentIds) {
        await projectService.bindConversation(projectId, conversationId, agentIds);
      },
      // Keep the old injection name usable for callers that have not migrated
      // their wiring yet; orchestration still gets the multi-conversation
      // semantics through the ProjectService method above.
      async bindTeam(projectId, conversationId, agentIds) {
        await projectService.bindConversation(projectId, conversationId, agentIds);
      },
      assertProjectMutationAllowed(projectId) {
        projectService.assertProjectMutationAllowed(projectId);
      },
    },
    workspaceRecovery: createWorkspaceRecoveryFacade({
      projects: projectService,
      checkpoints: workspaceCheckpoints,
      operations: workspaceOperations,
    }),
    ...(supervisorSelector === undefined
      ? {}
      : { selectNextParticipant: supervisorSelector }),
    resolveSupervisorModel: async () => {
      const supervisorModelId = resolvedSupervisorModelId();
      if (!isArkConfigured(config) || supervisorModelId.length === 0) {
        throw new ModelCatalogError(
          "MODEL_RUNTIME_CONFIGURATION_INVALID",
          503,
          "A supervisor model and the Ark inference key must be configured for supervisor routing",
        );
      }
      const modelRef = normalizeModelRef({
        providerId: "volcengine_ark",
        modelId: supervisorModelId,
      });
      return {
        modelRef,
        modelId: modelRef.modelId,
        catalogRevision: modelCatalog.get().revision ?? 0,
      };
    },
    supervisorTimeoutMs: config.supervisorTimeoutMs,
  });
  projectService.setConversationLifecycle({
    async stopForProject(projectId) {
      await orchestrationService.stopSessionsForProject(projectId);
    },
    async removeForProject(projectId) {
      await orchestrationService.removeSessionsForProject(projectId, { archiveOwned: true });
    },
  });

  let toolApprovalService: ToolApprovalService | undefined;
  let toolApprovalWorkflowService: ToolApprovalWorkflowService | undefined;
  let approvalWorkflowStorage: MastraCompositeStore | undefined;

  if (config.mcpToolApprovalEnabled) {
    try {
      const injectedStorage =
        options.approvalWorkflowStorage ?? options.toolApprovalWorkflowStorage;
      approvalWorkflowStorage = injectedStorage ?? (
        config.mcpToolApprovalStorage === "memory"
          ? new InMemoryStore({ id: `lqam-tool-approval-${config.runtimeInstanceId}` })
          : new MastraPostgresStore({
              id: `lqam-tool-approval-${config.runtimeInstanceId}`,
              connectionString: config.databaseUrl,
              schemaName: config.mcpToolApprovalSchema,
              // The exact pinned @mastra/pg provider initializes this dedicated
              // schema before the bridge is exposed. Its runtime role therefore
              // needs CREATE privileges for the configured schema on first boot.
              disableInit: false,
            })
      );

      const approvalStore = new ToolApprovalStore(store, { audit });
      const allowInMemoryStore =
        (config.nodeEnv === "development" || config.nodeEnv === "test") &&
        (config.mcpToolApprovalStorage === "memory" ||
          approvalWorkflowStorage instanceof InMemoryStore);
      const workflow = new ToolApprovalWorkflowService({
        approvalStore,
        toolService,
        workflowStorage: approvalWorkflowStorage,
        allowInMemoryStore,
        environment: config.nodeEnv,
      });
      toolApprovalWorkflowService = workflow;
      await workflow.initialize();
      // A provider supplied by the application is still subject to the native
      // workflow CAS check. The concrete Postgres path additionally verifies
      // the configured schema and snapshot table with the same connection.
      // This runs after provider init so every deployment verifies the same
      // schema/table that the pinned provider will use for workflow snapshots.
      if (approvalWorkflowStorage instanceof MastraPostgresStore) {
        await approvalWorkflowStorage.pool.query("SELECT 1");
        const schemaCheck = await approvalWorkflowStorage.pool.query<{ schema_name: string | null }>(
          "SELECT to_regnamespace($1::text)::text AS schema_name",
          [config.mcpToolApprovalSchema],
        );
        if (!schemaCheck.rows[0]?.schema_name) {
          throw new Error("MCP tool approval schema is unavailable");
        }
        const tableCheck = await approvalWorkflowStorage.pool.query<{ relation_name: string | null }>(
          "SELECT to_regclass($1::text)::text AS relation_name",
          [`${config.mcpToolApprovalSchema}.mastra_workflow_snapshot`],
        );
        if (!tableCheck.rows[0]?.relation_name) {
          throw new Error("MCP tool approval workflow snapshot table is unavailable");
        }
      }

      const bridge = new ToolApprovalService({
        approvalStore,
        toolService,
        workflowService: workflow,
        approvalTimeoutMs: config.mcpToolApprovalTimeoutMs,
        audit,
        telemetry,
        onAvailabilityChange: (available) => {
          // Once a native or durable dependency fails, sensitive tools remain
          // unavailable for newly minted Runs. Existing advertisements are
          // still denied by the MCP dispatch guard.
          approvalAvailable = available;
        },
      });
      await bridge.initialize();
      toolApprovalService = bridge;
      approvalAvailable = true;
    } catch {
      // Startup is allowed to serve safe, already-authorized tools while an
      // enabled approval deployment is unhealthy. Sensitive tools remain
      // absent from new advertisements and dispatch always denies them.
      approvalAvailable = false;
      await toolApprovalWorkflowService?.close().catch(() => undefined);
      if (toolApprovalWorkflowService === undefined) {
        await approvalWorkflowStorage?.close().catch(() => undefined);
      }
      toolApprovalWorkflowService = undefined;
      toolApprovalService = undefined;
      console.warn(toolApprovalStartupDiagnostic(config));
    }
  }

  if (toolApprovalService !== undefined) {
    // Every lifecycle owner shares one durable fence. This is attached before
    // orchestration initialization so stop/reconcile paths cannot race a
    // newly accepted approval invocation.
    service.setToolApprovalInvalidator(toolApprovalService);
    projectService.setToolApprovalInvalidator(toolApprovalService);
    orchestrationService.setToolApprovalInvalidator(toolApprovalService);
    mcpSessions.setLifecycleHandler(async ({ context, reason }) => {
      await toolApprovalService?.invalidateForSession(
        context.sessionId,
        reason === "expired"
          ? "The originating MCP session expired"
          : "The originating MCP session was revoked",
      );
    });
  } else {
    mcpSessions.setLifecycleHandler(undefined);
  }
  await orchestrationService.initialize();
  orchestrationService.setTelemetry(telemetry);

  const app = await createApp(
    config,
    service,
    orchestrationService,
    modelRegistry,
    previewService,
    projectService,
    {
      sessions: mcpSessions,
      toolService,
      legacyFullAdvertisement: !config.mcpScopedAdvertisement,
      approvalFeatureEnabled: config.mcpToolApprovalEnabled,
      approvalAvailable,
      ...(toolApprovalService === undefined ? {} : { approvalService: toolApprovalService }),
      authorizationService: authorization,
      skillService,
      roleService,
      auditService: audit,
      searchProvider,
      webFetch,
      telemetry,
    },
    modelCatalog,
    agentMetrics,
    agentAuthoring,
    applicationHealth,
  );

  reportReservedSupervisorEndpointConflicts(app.log);

  let shutdownInProgress = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    app.log.info({ signal }, "Shutting down");
    // This is deliberately synchronous and happens before any async quiesce or
    // fence work. A request arriving during shutdown can no longer create a
    // sensitive invocation while the durable/native resources are draining.
    toolApprovalService?.disableAdmissions();
    // Normal signals must quiesce direct Agent runs as well as Team sessions
    // before app/store close. Storage-fatal shutdown already started the same
    // memory-first Agent sweep in the fatal listener below.
    if (signal !== "STORAGE_FATAL") {
      const quiesced = await boundedLifecycleWait(
        service.quiesceForStorageFailure({ timeoutMs: LIFECYCLE_SHUTDOWN_TIMEOUT_MS }),
      );
      if (!quiesced) {
        app.log.error("Agent quiesce exceeded the shutdown bound; leaving dependent stores open");
        return;
      }
    }
    const orchestrationStopped = await boundedLifecycleWait(orchestrationService.shutdown());
    if (!orchestrationStopped) {
      app.log.error("Orchestration shutdown exceeded the bound; leaving dependent stores open");
      return;
    }
    // Approval handles are tied to live MCP responses. Fence and settle them
    // before closing the native Mastra provider or the application store.
    const approvalsStopped = await boundedLifecycleWait(
      toolApprovalService?.shutdown("Server shutdown cancelled the approval invocation") ??
        Promise.resolve(),
    );
    if (!approvalsStopped) {
      app.log.error("Tool approval drain exceeded the shutdown bound; leaving dependent stores open");
      return;
    }
    const appClosed = await boundedLifecycleWait(app.close());
    if (!appClosed) {
      app.log.error("HTTP application close exceeded the shutdown bound; leaving storage open");
      return;
    }
    const storeClosed = await boundedLifecycleWait(store.close());
    if (!storeClosed) {
      app.log.error("Application storage close exceeded the shutdown bound");
      return;
    }
    await boundedLifecycleWait(telemetry.shutdown());
  };

  // A fatal adapter transition is terminal for this process. Quiesce all
  // in-memory Agent and Team handles first, then give the normal supervisor a
  // bounded unhealthy shutdown signal. No storage snapshot is consulted here.
  applicationHealth.onStorageFatal(() => {
    toolApprovalService?.disableAdmissions();
    void (async () => {
      const quiesced = await boundedLifecycleWait(
        Promise.all([
          service.quiesceForStorageFailure({ timeoutMs: LIFECYCLE_SHUTDOWN_TIMEOUT_MS }),
          orchestrationService.quiesceForStorageFailure({
            timeoutMs: LIFECYCLE_SHUTDOWN_TIMEOUT_MS,
          }),
        ]),
      );
      if (!quiesced) {
        app.log.error("Storage-fatal quiesce exceeded the bound; leaving dependent stores open");
        return;
      }
      await shutdown("STORAGE_FATAL");
      process.exit(0);
    })();
  });

  return {
    app,
    config,
    store,
    telemetry,
    applicationHealth,
    agentService: service,
    projectService,
    orchestrationService,
    workspaceCheckpoints,
    workspaceOperations,
    projectWorkspaces,
    ...(toolApprovalService === undefined ? {} : { toolApprovalService }),
    ...(toolApprovalWorkflowService === undefined
      ? {}
      : { toolApprovalWorkflowService }),
    shutdown,
  };
}
