import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import {
  isSupervisorConfigured,
  isPermitConfigured,
  loadConfig,
  writeCodexConfig,
} from "./config.js";
import { createRunner } from "./runner-factory.js";
import { createModelRegistry, createWorkerModelResolver } from "./models/index.js";
import { JsonStore } from "./store.js";
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
import { BraveSearchAdapter } from "./tools/brave-search-adapter.js";
import { McpSessionService } from "./tools/mcp-session-service.js";
import {
  createBuiltInToolRegistry,
  ToolService,
} from "./tools/tool-service.js";
import { createBuiltInSkillRegistry, SkillService } from "./skills/index.js";
import { ProjectWorkspaceManager } from "./projects/project-workspace.js";
import {
  PreviewService,
  previewResourceLimitsFromConfig,
} from "./preview/preview-service.js";
import { AuditService, JsonAuditStoreAdapter } from "./audit/audit-service.js";
import { createRuntimeTelemetry } from "./telemetry/runtime-telemetry.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const auditStore = new JsonAuditStoreAdapter(store);
const audit = new AuditService(auditStore, auditStore);
const telemetry = createRuntimeTelemetry(config);
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const mcpSessions = new McpSessionService(config.mcpTokenTtlMs);
const permitSynchronizationGate = new PermitSynchronizationGate();
const workerModelResolver = createWorkerModelResolver(config);
const modelRegistry = createModelRegistry(config, {
  workerResolver: workerModelResolver,
});
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  workerModelResolver,
);
service.setMcpSessionService(mcpSessions);
service.setTelemetry(telemetry);
const permitMode = config.authorizationMode === "permit";
// Permit is the only authorization authority in the production graph. Local
// POC mode uses the repository's fixed role policy and never constructs a
// Permit adapter, directory reconciler, or external approval service.
const authorization = permitMode
  ? createPermitAuthorizationAdapter(
      config,
      permitSynchronizationGate,
      audit,
      telemetry,
    )
  : new RepositoryAuthorizationService(store);
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
const toolRegistry = createBuiltInToolRegistry({
  search: new BraveSearchAdapter({
    apiKey: config.braveSearchApiKey,
    timeoutMs: config.braveSearchTimeoutMs,
    maxResults: config.braveSearchMaxResults,
  }),
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
);
service.setSkillService(skillService);
projectService.setSkillService(skillService);
await service.initialize();
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

const supervisorSelector = isSupervisorConfigured(config)
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
  // Attaching here keeps Project membership rules inside ProjectService while
  // letting a Team declare its shared artifact at creation time.
  projectBinding: {
    async bindTeam(projectId, teamId, agentIds) {
      await projectService.attachTeam(projectId, teamId);
      const attached = new Set((await projectService.get(projectId)).agentIds);
      for (const agentId of agentIds) {
        if (attached.has(agentId)) continue;
        await projectService.attachAgent(projectId, agentId);
        attached.add(agentId);
      }
    },
  },
  ...(supervisorSelector === undefined
    ? {}
    : { selectNextParticipant: supervisorSelector }),
  supervisorTimeoutMs: config.supervisorTimeoutMs,
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
    ...(permitApprovalService === undefined ? {} : { approvalService: permitApprovalService }),
    auditService: audit,
    telemetry,
  },
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await orchestrationService.shutdown();
  await app.close();
  await telemetry.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
