import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import {
  isPermitConfigured,
  loadConfig,
  writeCodexConfig,
} from "./config.js";
import { createRunner } from "./runner-factory.js";
import {
  ArkModelCatalogService,
  ModelCatalogError,
  createModelRegistry,
  createWorkerModelResolver,
  normalizeModelRef,
} from "./models/index.js";
import {
  JsonStore,
  normalizeDatabase,
  type Storage,
} from "./store.js";
import { PostgresStore } from "./persistence/postgres-store.js";
import type { Database } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { OrchestrationService } from "./orchestration/orchestration-service.js";
import {
  ArkResponsesSupervisorProvider,
  createOrchestrationParticipantSelector,
} from "./orchestration/supervisor/index.js";
import {
  createPermitAuthorizationAdapter,
} from "./access/permit-authorization-adapter.js";
import { RepositoryAuthorizationService } from "./access/repository-authorization-service.js";
import { RoleTemplateAuthorizationService } from "./access/role-template-authorization-service.js";
import { LocalPocApprovalGateway } from "./access/local-poc-approval-gateway.js";
import { PermitSynchronizationGate } from "./access/permit-synchronization-gate.js";
import {
  createPermitDirectoryClient,
  PermitDirectoryReconciler,
} from "./access/permit-directory-reconciler.js";
import {
  createPermitApprovalClient,
  PermitApprovalService,
} from "./access/permit-approval-service.js";
import { LocalContainerPreviewRuntime } from "./preview/local-container-preview-runtime.js";
import { PreviewCommandResolver } from "./preview/preview-command-resolver.js";
import { StorePreviewContextProvider } from "./preview/preview-context-provider.js";
import { ProjectService } from "./projects/project-service.js";
import { ProjectServiceExecutionScope } from "./projects/project-execution.js";
import { createSearchProvider } from "./tools/search-provider-factory.js";
import { WebFetchAdapter } from "./tools/web-fetch-adapter.js";
import { McpSessionService } from "./tools/mcp-session-service.js";
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
import { AgentMetricsService } from "./usage/agent-metrics.js";

const config = loadConfig();

// Database credentials are consumed by the server through the validated
// config object. Remove them from the inherited environment before any Agent
// worker or Codex child can observe process.env. Migration-owner credentials
// must never reach a runtime child process.
for (const key of [
  "DATABASE_ADMIN_URL",
  "DATABASE_RUNTIME_PASSWORD",
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
]) {
  delete process.env[key];
}

const legacyJsonPath = path.join(config.dataDirectory, "launchpad.json");
const store: Storage = config.persistenceBackend === "postgres"
  ? new PostgresStore(config.databaseUrl)
  : new JsonStore(legacyJsonPath);
const auditStore = new StorageAuditStoreAdapter(store);
const audit = new AuditService(auditStore, auditStore);
const telemetry = createRuntimeTelemetry(config);
const workspaces = new WorkspaceManager(config.workspaceRoot);
// `containerHealthSampler` is only set for the container runtime provider.
const { runner, healthSampler: containerHealthSampler } = createRunner(config);
const mcpSessions = new McpSessionService(config.mcpTokenTtlMs, { audit });
const modelCatalog = new ArkModelCatalogService(store);
// The live catalog must exist before AgentService.initialize() materializes
// defaults for legacy Agent records.
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
  database.installedSkills.length > 0;

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
const seededModelIds = Array.from(new Set([
  ...config.workerCuratedModels,
  ...(config.arkModel.length === 0 ? [] : [config.arkModel]),
]));
await modelCatalog.initialize({
  provider: "volcengine_ark",
  baseUrl: config.arkBaseUrl,
  apiKeyEnv: "ARK_API_KEY",
  models: seededModelIds,
  defaultModelRef:
    config.arkModel.length === 0
      ? null
      : { providerId: "volcengine_ark", modelId: config.arkModel },
  revision: 1,
});
const permitSynchronizationGate = new PermitSynchronizationGate();
const workerModelResolver = createWorkerModelResolver(config, {
  catalog: modelCatalog,
});
const modelRegistry = createModelRegistry(config, {
  workerResolver: workerModelResolver,
  catalog: modelCatalog,
});
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  workerModelResolver,
);
service.setAuditRecorder(audit);
service.setMcpSessionService(mcpSessions);
service.setTelemetry(telemetry);
const agentMetrics = new AgentMetricsService({
  agents: () => service.listAgents(),
  runs: (agentId) => service.getRuns(agentId),
  audit,
  ...(containerHealthSampler === undefined ? {} : { healthSampler: containerHealthSampler }),
});
const permitMode = config.authorizationMode === "permit";
// Permit is the only authorization authority in the production graph. Local
// POC mode uses the repository's fixed role policy and never constructs a
// Permit adapter, directory reconciler, or external approval service.
const policyAuthorization = permitMode
  ? createPermitAuthorizationAdapter(
      config,
      permitSynchronizationGate,
      audit,
      telemetry,
    )
  : new RepositoryAuthorizationService(store);
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
const permitDirectory = permitMode
  ? new PermitDirectoryReconciler(
      store,
      createPermitDirectoryClient(config),
      { tenantKey: config.permitTenantKey, synchronizationGate: permitSynchronizationGate },
    )
  : undefined;
const permitApprovalService = permitMode
  ? new PermitApprovalService(
      store,
      createPermitApprovalClient(config),
      { tenantKey: config.permitTenantKey, audit, telemetry },
    )
  : undefined;
if (permitDirectory !== undefined) {
  service.setPermitDirectoryReconciler(permitDirectory);
  projectService.setPermitDirectoryReconciler(permitDirectory);
}
const previewService = new PreviewService(
  store,
  service,
  new LocalContainerPreviewRuntime(config),
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
  permitApprovalService ?? new LocalPocApprovalGateway(),
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
service.setSkillService(skillService);
projectService.setSkillService(skillService);
await service.initialize();
await roleService.initialize();
await projectService.initialize();
// Reconcile existing repository facts before accepting privileged lifecycle
// mutations. A development Permit graph may be inspected without credentials;
// configured Permit deployments converge immediately, while production config
// validation above guarantees this call has a usable client.
if (
  permitDirectory !== undefined &&
  (config.nodeEnv === "production" || isPermitConfigured(config))
) {
  await permitDirectory.reconcile();
}
await previewService.initialize();

const supervisorCredentialsConfigured =
  config.arkApiKey.length > 0 && !config.arkApiKey.startsWith("replace-");
const supervisorSelector = supervisorCredentialsConfigured
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
  },
  ...(supervisorSelector === undefined
    ? {}
    : { selectNextParticipant: supervisorSelector }),
  resolveSupervisorModel: async (agent) => {
    if (agent.modelRef === undefined) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "Supervisor Agent must have an explicit primary model assignment",
      );
    }
    const modelRef = normalizeModelRef(agent.modelRef);
    const models = await modelRegistry.listModels(
      modelRef.providerId,
      "supervisor",
    );
    const descriptor = models.find((model) => model.id === modelRef.modelId);
    if (
      descriptor === undefined ||
      !descriptor.capabilities.scopes.includes("supervisor")
    ) {
      throw new ModelCatalogError(
        "MODEL_NOT_SUPPORTED_FOR_SUPERVISOR",
        422,
        "The Supervisor Agent model does not support supervisor routing",
      );
    }
    if (
      modelRef.reasoning?.effort !== undefined &&
      (!descriptor.capabilities.reasoning ||
        !descriptor.capabilities.reasoningEfforts?.includes(
          modelRef.reasoning.effort,
        ))
    ) {
      throw new ModelCatalogError(
        "MODEL_REASONING_NOT_SUPPORTED",
        422,
        "The Supervisor Agent model does not support reasoning controls",
      );
    }
    return {
      modelRef,
      modelId: descriptor.id,
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
    await orchestrationService.removeSessionsForProject(projectId);
  },
});
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
    skillService,
    roleService,
    ...(permitApprovalService === undefined ? {} : { approvalService: permitApprovalService }),
    auditService: audit,
    searchProvider,
    webFetch,
    telemetry,
  },
  modelCatalog,
  agentMetrics,
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await orchestrationService.shutdown();
  await app.close();
  await store.close();
  await telemetry.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
