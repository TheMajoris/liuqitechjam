import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  STORAGE_UNAVAILABLE_CODE,
  STORAGE_UNAVAILABLE_MESSAGE,
  type ApplicationHealthContract,
} from "./application-health.js";
import type { AuditEventInput, AuditReader, AuditSpan } from "./audit/audit-types.js";
import { newSpanId } from "./audit/audit-span.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import {
  isAuthorizationError,
} from "./access/authorization-service.js";
import { humanPrincipal } from "./access/access-types.js";
import type { Principal } from "./access/access-types.js";
import type { AgentService } from "./agent-service.js";
import {
  AgentDraftRequestSchema,
  type AgentAuthoringService,
} from "./agent-authoring.js";
import { registerAgentMiddlewareRoutes } from "./http/agent-middleware-routes.js";
import { registerAgentMetricsRoutes } from "./http/agent-metrics-routes.js";
import {
  listVisibleToolApprovals,
  registerToolApprovalRoutes,
  type ToolApprovalRouteDependencies,
} from "./http/tool-approval-routes.js";
import type { AgentMetricsService } from "./usage/agent-metrics.js";
import { recordHumanAction } from "./http/human-action-audit.js";
import { agentIdParams, auditQuery, runIdParams } from "./http/route-schemas.js";
import { registerMcpRoute, type McpRouteDependencies } from "./mcp-server.js";
import { ToolError } from "./tools/tool-errors.js";
import { approvalDecisionAuthorityForTool } from "./tools/tool-types.js";
import { isSkillError } from "./skills/skill-service.js";
import { isRoleError } from "./roles/role-service.js";
import { isPreviewError } from "./preview/preview-service.js";
import type { PreviewLogsView } from "./preview/preview-service.js";
import type { PreviewOwnerRef, PreviewView } from "./preview/preview-types.js";
import {
  createModelRegistry,
  ModelCatalogError,
  ModelProviderParamsSchema,
  ModelRefSchema,
  ModelScopeQuerySchema,
  ARK_WORKER_PROVIDER_ID,
  parseSupervisorModelRef,
  releaseAgentsFromReservedModel,
  type ArkModelCatalogRecord,
  type ModelDescriptor,
  type ModelRef,
  type ModelRegistry,
} from "./models/index.js";
import {
  ContinueOrchestrationSchema,
  RecoverOrchestrationSchema,
  RecoveryRouteParamsSchema,
  RestoreSafetySchema,
  ResumeRecoverySchema,
  RetryOrchestrationSchema,
  CreateOrchestrationSchema,
  OrchestrationRouteParamsSchema,
  StartOrchestrationSchema,
  UpdateOrchestrationSchema,
} from "./orchestration/schemas.js";
import type {
  CreateOrchestrationInput,
  OrchestrationSession,
  OrchestrationSessionDetail,
  RecoverOrchestrationInput,
  RestoreSafetyInput,
  ResumeRecoveryInput,
} from "./orchestration/types.js";
import { isProjectError } from "./projects/project-errors.js";
import {
  isWorkspaceCheckpointError,
  type WorkspaceCheckpointStatusView,
  type WorkspaceCheckpointView,
  type WorkspaceRecoveryView,
} from "./projects/workspace-checkpoint-types.js";
import type {
  CreateProjectInput,
  ProjectRole,
  ProjectView,
  UpdateProjectInput,
} from "./projects/project-types.js";

/**
 * Narrow HTTP-facing seam for the orchestration module.
 *
 * Keeping this structural lets the app boundary remain usable while the
 * service is assembled elsewhere (and makes route tests independent of its
 * runtime dependencies).
 */
export interface OrchestrationServiceContract {
  createSession(input: CreateOrchestrationInput): Promise<OrchestrationSession>;
  listSessions(): Promise<OrchestrationSession[]>;
  getSession(id: string): Promise<OrchestrationSessionDetail>;
  startSession(id: string, prompt?: string): Promise<OrchestrationSession>;
  stopSession(id: string): Promise<OrchestrationSession>;
  continueSession(id: string, prompt: string): Promise<OrchestrationSession>;
  retryFromStep(id: string, fromStepIndex: number): Promise<OrchestrationSession>;
  /** Prompt-policy edit; optional so route tests can omit it. */
  updateSession?(
    id: string,
    input: { clarifyFirst: boolean },
  ): Promise<OrchestrationSession>;
  deleteSession(id: string): Promise<{ deleted: boolean }>;
  /** Root trace span for this orchestration; optional so route tests can omit it. */
  orchestrationSpan?(id: string): AuditSpan;
  /** Source restore-and-resume; optional so servers without checkpoints omit it. */
  recoverFromCheckpoint?(
    id: string,
    input: RecoverOrchestrationInput,
  ): Promise<{ recovery: WorkspaceRecoveryView; duplicate: boolean }>;
  getRecovery?(id: string, operationId: string): Promise<WorkspaceRecoveryView>;
  resumeRecovery?(
    id: string,
    operationId: string,
    input: ResumeRecoveryInput,
  ): Promise<WorkspaceRecoveryView>;
  restoreSafety?(
    id: string,
    operationId: string,
    input: RestoreSafetyInput,
  ): Promise<WorkspaceRecoveryView>;
}

/** Narrow HTTP-facing seam for the Project control plane. */
export interface ProjectServiceContract {
  create(input: CreateProjectInput): Promise<ProjectView>;
  list(): Promise<ProjectView[]>;
  get(projectId: string): Promise<ProjectView>;
  update(projectId: string, input: UpdateProjectInput): Promise<ProjectView>;
  archive(projectId: string): Promise<{ archivedWorkspace: string | null }>;
  deletePermanently(projectId: string): Promise<{ deleted: boolean }>;
  attachAgent(
    projectId: string,
    agentId: string,
    principal?: Principal,
    role?: ProjectRole,
  ): Promise<ProjectView>;
  updateAgentRole(
    projectId: string,
    agentId: string,
    role: ProjectRole,
  ): Promise<ProjectView>;
  detachAgent(projectId: string, agentId: string): Promise<ProjectView>;
  attachTeam(projectId: string, teamId: string): Promise<ProjectView>;
  detachTeam(projectId: string): Promise<ProjectView>;
  /** Safe checkpoint projections; optional so route tests can omit them. */
  listWorkspaceCheckpoints?(
    projectId: string,
    query: { limit?: number | undefined; beforeOrdinal?: number | undefined },
  ): Promise<{
    checkpoints: WorkspaceCheckpointView[];
    nextBeforeOrdinal: number | null;
    status: WorkspaceCheckpointStatusView;
  }>;
  getWorkspaceCheckpoint?(projectId: string, checkpointId: string): Promise<WorkspaceCheckpointView>;
}

/** Narrow HTTP-facing seam for the trusted preview control plane. */
export interface PreviewServiceContract {
  start(owner: PreviewOwnerRef): Promise<PreviewView>;
  get(owner: PreviewOwnerRef): Promise<PreviewView>;
  restart(owner: PreviewOwnerRef): Promise<PreviewView>;
  stop(owner: PreviewOwnerRef): Promise<PreviewView>;
  logs(owner: PreviewOwnerRef, tail?: number): Promise<PreviewLogsView>;
}

/** Narrow operator-facing seam for the persisted Ark model catalog. */
export interface ModelCatalogServiceContract {
  get(): ArkModelCatalogRecord;
  /** Absent on read-only catalog implementations used by some tests. */
  setSupervisorModelRef?(modelRef: ModelRef | null): Promise<ArkModelCatalogRecord>;
}

const supervisorModelBody = z
  .object({
    /** `null` clears the override and hands routing back to SUPERVISOR_MODEL. */
    modelRef: ModelRefSchema.nullable(),
  })
  .strict();

/** Cosmetic only. Every field is optional; absent means the ID-derived look. */
const appearanceBody = z.object({
  hue: z.number().int().min(0).max(359).optional(),
  hair: z.number().int().min(0).max(5).optional(),
  skin: z.number().int().min(0).max(3).optional(),
  accessory: z.enum(["none", "glasses", "headset", "cap"]).optional(),
  figure: z.enum(["neutral", "feminine", "masculine"]).optional(),
}).strict();

const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  modelRef: ModelRefSchema.optional(),
  /** Ordered fallbacks used only for typed pre-execution model failures. */
  fallbackModelRefs: z.array(ModelRefSchema).max(8).optional(),
  skillIds: z.array(z.string().min(1)).max(32).optional(),
  /** Optional global role; null is an explicit "No role" selection. */
  globalRoleId: z.string().min(1).max(128).nullable().optional(),
  appearance: appearanceBody.optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const modelListingQuery = ModelScopeQuerySchema.extend({
  refresh: z.literal("true").optional(),
});
const modelResourceQuery = z.object({
  refresh: z.literal("true").optional(),
});
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  /** Omitted by legacy clients; the Agent's most recent conversation is used. */
  conversationId: z.string().uuid().optional(),
});

function parseAgentInput<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const hasReasoningIssue = parsed.error.issues.some((issue) =>
    issue.path[0] === "modelRef" &&
    issue.path[1] === "reasoning" &&
    issue.path[2] === "effort",
  );
  if (hasReasoningIssue) {
    throw new ModelCatalogError(
      "MODEL_REASONING_EFFORT_INVALID",
      422,
      "The selected reasoning effort is invalid",
    );
  }
  throw parsed.error;
}

/** Validation details that are safe to expose at the HTTP boundary. */
class OrchestrationValidationError extends HttpError {
  constructor(
    message: string,
    readonly details: readonly unknown[],
  ) {
    super(422, message);
    this.name = "OrchestrationValidationError";
  }
}

function requireOrchestrationService(
  service: OrchestrationServiceContract | undefined,
): OrchestrationServiceContract {
  if (!service) {
    throw new HttpError(503, "Orchestration is not configured");
  }
  return service;
}

function requirePreviewService(
  service: PreviewServiceContract | undefined,
): PreviewServiceContract {
  if (!service) {
    throw new HttpError(503, "Preview is not configured");
  }
  return service;
}

function requireProjectService(
  service: ProjectServiceContract | undefined,
): ProjectServiceContract {
  if (!service) {
    throw new HttpError(503, "Projects are not configured");
  }
  return service;
}

function requireAuditService(
  dependencies: McpRouteDependencies | undefined,
): AuditReader {
  const auditService = dependencies?.auditService;
  if (!auditService) throw new HttpError(503, "Audit activity is not configured");
  return auditService;
}

function requireApplicationAvailability(
  applicationHealth: ApplicationHealthContract | undefined,
): void {
  if (applicationHealth?.isHealthy() === false) {
    throw new HttpError(503, STORAGE_UNAVAILABLE_MESSAGE);
  }
}

function parseOrchestrationInput(value: unknown): CreateOrchestrationInput {
  const parsed = CreateOrchestrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestrationValidationError(
      "Invalid orchestration request",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function parseOrchestrationParams(value: unknown): { id: string } {
  const parsed = OrchestrationRouteParamsSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestrationValidationError(
      "Invalid orchestration route parameters",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function parseContinuationInput(value: unknown): { prompt: string } {
  const parsed = ContinueOrchestrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestrationValidationError(
      "Invalid continuation request",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function parseRetryInput(value: unknown): { fromStepIndex: number } {
  const parsed = RetryOrchestrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestrationValidationError(
      "Invalid retry request",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** A fresh child span under the orchestration's root trace, if one exists. */
function childSpan(root: AuditSpan | undefined): Partial<AuditSpan> | undefined {
  if (!root) return undefined;
  return { traceId: root.traceId, spanId: newSpanId(), parentSpanId: root.spanId };
}

/** Builds the human-intent audit event recorded alongside an orchestration route. */
function orchestrationHumanEvent(
  type: "orchestration_started" | "orchestration_stopped" | "orchestration_continued",
  summary: string,
  id: string,
  session: OrchestrationSession,
  orchestration: OrchestrationServiceContract,
): AuditEventInput {
  const span = childSpan(orchestration.orchestrationSpan?.(id));
  return {
    type,
    status: "success",
    summary,
    principal: humanPrincipal(),
    actorType: "human",
    orchestrationId: id,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(span === undefined ? {} : { span }),
    metadata: { participantCount: session.participants.length, trigger: "http" },
  };
}

function parseRecoverInput(value: unknown): RecoverOrchestrationInput {
  const parsed = RecoverOrchestrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestrationValidationError(
      "Invalid recovery request",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function parseRecoveryParams(value: unknown): { id: string; operationId: string } {
  const parsed = RecoveryRouteParamsSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestrationValidationError(
      "Invalid recovery route parameters",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** The recovery routes exist only when the service implements them. */
function requireRecoveryRoutes(
  service: OrchestrationServiceContract,
): Required<
  Pick<OrchestrationServiceContract, "recoverFromCheckpoint" | "getRecovery" | "resumeRecovery" | "restoreSafety">
> {
  if (
    !service.recoverFromCheckpoint ||
    !service.getRecovery ||
    !service.resumeRecovery ||
    !service.restoreSafety
  ) {
    throw new HttpError(503, "Workspace checkpoints are not configured on this server");
  }
  return {
    recoverFromCheckpoint: service.recoverFromCheckpoint.bind(service),
    getRecovery: service.getRecovery.bind(service),
    resumeRecovery: service.resumeRecovery.bind(service),
    restoreSafety: service.restoreSafety.bind(service),
  };
}

function parseStartInput(value: unknown): { prompt?: string | undefined } {
  const parsed = StartOrchestrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestrationValidationError(
      "Invalid orchestration start request",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  orchestrationService?: OrchestrationServiceContract,
  modelRegistry: ModelRegistry = createModelRegistry(config),
  previewService?: PreviewServiceContract,
  projectService?: ProjectServiceContract,
  mcp?: McpRouteDependencies,
  modelCatalog?: ModelCatalogServiceContract,
  agentMetrics?: AgentMetricsService,
  agentAuthoring?: AgentAuthoringService,
  applicationHealth?: ApplicationHealthContract,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  const publicHealthRoutes = new Set(["/api/health", "/api/readiness", "/api/ready"]);
  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      publicHealthRoutes.has(request.url.split("?", 1)[0] ?? "") ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  const healthResponse = () => {
    if (applicationHealth?.isHealthy() === false) {
      return {
        ok: false as const,
        service: "lqam-server",
        storage: "unavailable" as const,
        errorCode: "STORAGE_UNAVAILABLE" as const,
      };
    }
    return { ok: true as const, service: "lqam-server" };
  };
  for (const route of ["/api/health", "/api/readiness", "/api/ready"] as const) {
    app.get(route, async (_request, reply) => {
      const response = healthResponse();
      return response.ok ? response : reply.code(503).send(response);
    });
  }

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/model-providers", async (request) => {
    const { scope, refresh } = modelListingQuery.parse(request.query);
    if (refresh === "true") {
      if (modelRegistry.refresh) await modelRegistry.refresh(true);
      else modelRegistry.invalidate?.();
    }
    let defaultModelRef = null;
    if (scope === "worker") {
      try {
        const resolved = modelRegistry.resolveWorkerModel();
        defaultModelRef = {
          providerId: resolved.providerId,
          modelId: resolved.modelId,
        };
      } catch (error) {
        if (!(error instanceof ModelCatalogError)) throw error;
      }
    }
    return {
      providers: await modelRegistry.listProviders(scope),
      ...(scope === "worker" ? { defaultModelRef } : {}),
    };
  });

  app.get("/api/model-providers/:providerId/models", async (request) => {
    const { providerId } = ModelProviderParamsSchema.parse(request.params);
    const { scope, refresh } = modelListingQuery.parse(request.query);
    if (refresh === "true") {
      if (modelRegistry.refresh) await modelRegistry.refresh(true);
      else modelRegistry.invalidate?.();
    }
    return {
      models: await modelRegistry.listModels(providerId, scope),
    };
  });

  // Provider credentials and raw management responses stay on the server;
  // this route exposes only the bounded, normalized resource projection.
  app.get("/api/model-resources", async (request) => {
    const { refresh } = modelResourceQuery.parse(request.query);
    if (modelRegistry.modelResources === undefined) {
      throw new ModelCatalogError(
        "MODEL_PROVIDER_UNAVAILABLE",
        503,
        "ModelArk resource telemetry is not configured",
      );
    }
    return modelRegistry.modelResources({ force: refresh === "true" });
  });

  // The supervisor endpoint is server-wide. SUPERVISOR_MODEL seeds it; an
  // operator selection persists in the catalog and wins from then on.
  const environmentSupervisorModelId = () => {
    const value = config.supervisorModel.trim();
    return value.length === 0 || value.includes("replace-") ? null : value;
  };

  const supervisorModelView = () => {
    const override = modelCatalog?.get().supervisorModelRef ?? null;
    const environmentModelId = environmentSupervisorModelId();
    const modelRef: ModelRef | null = override
      ? { providerId: override.providerId, modelId: override.modelId }
      : environmentModelId === null
        ? null
        : { providerId: ARK_WORKER_PROVIDER_ID, modelId: environmentModelId };
    return {
      modelRef,
      source: override ? "override" : modelRef ? "environment" : ("none" as const),
      environmentModelId,
      revision: modelCatalog?.get().revision ?? 0,
    };
  };

  app.get("/api/supervisor-model", async () => {
    if (modelCatalog === undefined) {
      throw new ModelCatalogError(
        "MODEL_CATALOG_UNAVAILABLE",
        503,
        "The Ark model catalog is not initialized",
      );
    }
    return supervisorModelView();
  });

  app.put("/api/supervisor-model", async (request) => {
    const catalog = modelCatalog;
    if (catalog?.setSupervisorModelRef === undefined) {
      throw new ModelCatalogError(
        "MODEL_CATALOG_UNAVAILABLE",
        503,
        "The supervisor model cannot be changed on this server",
      );
    }
    const parsed = supervisorModelBody.safeParse(request.body);
    if (!parsed.success) {
      throw new ModelCatalogError(
        "MODEL_CATALOG_INVALID",
        422,
        "The supervisor model reference is invalid",
      );
    }

    let next: ModelRef | null = null;
    if (parsed.data.modelRef !== null) {
      next = parseSupervisorModelRef(parsed.data.modelRef);
      // Supervisor scope lists every running endpoint, including the one that
      // is currently reserved, so re-selecting the active endpoint is valid.
      const candidates = await modelRegistry.listModels(
        next.providerId,
        "supervisor",
      );
      if (!candidates.some((model) => model.id === next?.modelId)) {
        throw new ModelCatalogError(
          "MODEL_NOT_FOUND",
          422,
          "The selected supervisor model is not a running endpoint",
        );
      }
    }

    await catalog.setSupervisorModelRef(next);

    // Worker resolution now rejects the newly reserved endpoint, so any Agent
    // still pointing at it has to be moved before it can run again.
    const reservedModelId = next?.modelId ?? environmentSupervisorModelId() ?? "";
    const availableModels = reservedModelId.length === 0
      ? []
      : await modelRegistry
          .listModels(ARK_WORKER_PROVIDER_ID, "worker")
          .catch(() => [] as ModelDescriptor[]);
    const reassignments = await releaseAgentsFromReservedModel({
      agentService: service,
      reservedModelId,
      availableModels,
      preferredModelRef: catalog.get().defaultModelRef ?? null,
    });

    return { ...supervisorModelView(), reassignments };
  });

  if (modelCatalog !== undefined) {
    const aggregateModelCatalog = async (
      catalog: ArkModelCatalogRecord = modelCatalog.get(),
    ) => {
      const providers = await modelRegistry.listProviders("worker");
      const modelsByProvider: Record<string, ModelDescriptor[]> = {};
      await Promise.all(
        providers.map(async (provider) => {
          if (!provider.capabilities.worker) return;
          modelsByProvider[provider.id] = await modelRegistry.listModels(
            provider.id,
            "worker",
          );
        }),
      );
      const models = Object.values(modelsByProvider).flat();
      let defaultModelRef = catalog.defaultModelRef;
      if (defaultModelRef === undefined || defaultModelRef === null) {
        try {
          const resolved = modelRegistry.resolveWorkerModel();
          defaultModelRef = {
            providerId: resolved.providerId,
            modelId: resolved.modelId,
          };
        } catch (error) {
          if (!(error instanceof ModelCatalogError)) throw error;
          // No server-side default is configured, so offer the first live
          // worker model. This is what the Agent create form pre-selects.
          const firstModel = models[0];
          defaultModelRef = firstModel
            ? { providerId: firstModel.providerId, modelId: firstModel.id }
            : null;
        }
      }
      return {
        providers,
        models,
        modelsByProvider,
        defaultModelRef: defaultModelRef ?? null,
        revision: catalog.revision ?? 0,
        // Keep the metadata projection available to operator clients while
        // leaving the UI-facing aggregate fields stable.
        catalog,
      };
    };

    // Read-only: the operator allowlist/default editor was removed because
    // live ListEndpoints is the authority for which models exist. This route
    // remains the client's provider/model listing.
    app.get("/api/model-catalog", async () => aggregateModelCatalog());

  }

  app.post("/api/orchestrations", async (request, reply) => {
    const input = parseOrchestrationInput(request.body);
    const session = await requireOrchestrationService(
      orchestrationService,
    ).createSession(input);
    return reply.code(201).send({ session });
  });

  app.get("/api/orchestrations", async () => {
    const sessions = await requireOrchestrationService(
      orchestrationService,
    ).listSessions();
    return { sessions };
  });

  app.get("/api/orchestrations/:id", async (request) => {
    const { id } = parseOrchestrationParams(request.params);
    return requireOrchestrationService(orchestrationService).getSession(id);
  });

  app.post("/api/orchestrations/:id/start", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = parseOrchestrationParams(request.params);
    const { prompt } = parseStartInput(request.body === undefined ? {} : request.body);
    const orchestration = requireOrchestrationService(orchestrationService);
    const session =
      prompt === undefined
        ? await orchestration.startSession(id)
        : await orchestration.startSession(id, prompt);
    await recordHumanAction(
      mcp?.auditService,
      orchestrationHumanEvent("orchestration_started", "Orchestration started", id, session, orchestration),
      request.log,
    );
    return reply.code(202).send({ session });
  });

  app.post("/api/orchestrations/:id/stop", async (request, reply) => {
    const { id } = parseOrchestrationParams(request.params);
    const orchestration = requireOrchestrationService(orchestrationService);
    const session = await orchestration.stopSession(id);
    await recordHumanAction(
      mcp?.auditService,
      orchestrationHumanEvent("orchestration_stopped", "Orchestration stopped", id, session, orchestration),
      request.log,
    );
    return reply.code(202).send({ session });
  });

  app.post("/api/orchestrations/:id/continue", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = parseOrchestrationParams(request.params);
    const { prompt } = parseContinuationInput(request.body);
    const orchestration = requireOrchestrationService(orchestrationService);
    const session = await orchestration.continueSession(id, prompt);
    await recordHumanAction(
      mcp?.auditService,
      orchestrationHumanEvent("orchestration_continued", "Orchestration continued", id, session, orchestration),
      request.log,
    );
    return reply.code(202).send({ session });
  });

  app.post("/api/orchestrations/:id/retry", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = parseOrchestrationParams(request.params);
    const { fromStepIndex } = parseRetryInput(request.body);
    const orchestration = requireOrchestrationService(orchestrationService);
    const session = await orchestration.retryFromStep(id, fromStepIndex);
    await recordHumanAction(
      mcp?.auditService,
      orchestrationHumanEvent(
        "orchestration_continued",
        "Orchestration retried from step " + String(fromStepIndex + 1),
        id,
        session,
        orchestration,
      ),
      request.log,
    );
    return reply.code(202).send({ session });
  });

  // ------------------------------------------------ workspace recovery
  // Restore the shared Workspace's eligible source files to a recorded
  // checkpoint and resume the remaining work. The body names only a
  // checkpoint and the client's own idempotency key; Git revisions, host
  // paths, saved state, and operation owners are rejected by the strict schema.

  app.post("/api/orchestrations/:id/recover", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = parseOrchestrationParams(request.params);
    const input = parseRecoverInput(request.body);
    const orchestration = requireOrchestrationService(orchestrationService);
    const routes = requireRecoveryRoutes(orchestration);
    const result = await routes.recoverFromCheckpoint(id, input);
    if (!result.duplicate) {
      const span = childSpan(orchestration.orchestrationSpan?.(id));
      await recordHumanAction(
        mcp?.auditService,
        {
          type: "workspace_checkpoint_restore_started",
          status: "success",
          summary: "Workspace restore requested",
          principal: humanPrincipal(),
          actorType: "human",
          orchestrationId: id,
          projectId: result.recovery.projectId,
          ...(span === undefined ? {} : { span }),
          metadata: {
            checkpointId: input.checkpointId,
            operationId: result.recovery.operationId,
            requestId: input.requestId,
            trigger: "http",
          },
        },
        request.log,
      );
    }
    const settled =
      result.recovery.stage === "settled" ||
      result.recovery.stage === "failed" ||
      result.recovery.stage === "recovery_required";
    return reply.code(result.duplicate && settled ? 200 : 202).send({ recovery: result.recovery });
  });

  app.get("/api/orchestrations/:id/recoveries/:operationId", async (request) => {
    const { id, operationId } = parseRecoveryParams(request.params);
    const routes = requireRecoveryRoutes(requireOrchestrationService(orchestrationService));
    return { recovery: await routes.getRecovery(id, operationId) };
  });

  app.post("/api/orchestrations/:id/recoveries/:operationId/resume", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id, operationId } = parseRecoveryParams(request.params);
    const parsed = ResumeRecoverySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new OrchestrationValidationError("Invalid resume request", parsed.error.issues);
    }
    const routes = requireRecoveryRoutes(requireOrchestrationService(orchestrationService));
    const recovery = await routes.resumeRecovery(id, operationId, parsed.data);
    await recordHumanAction(
      mcp?.auditService,
      {
        type: "workspace_recovery_resumed",
        status: "success",
        summary: "Workspace recovery resume requested",
        principal: humanPrincipal(),
        actorType: "human",
        orchestrationId: id,
        projectId: recovery.projectId,
        metadata: { operationId, requestId: parsed.data.requestId, trigger: "http" },
      },
      request.log,
    );
    return reply.code(202).send({ recovery });
  });

  app.post("/api/orchestrations/:id/recoveries/:operationId/restore-safety", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id, operationId } = parseRecoveryParams(request.params);
    const parsed = RestoreSafetySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new OrchestrationValidationError("Invalid safety restore request", parsed.error.issues);
    }
    const routes = requireRecoveryRoutes(requireOrchestrationService(orchestrationService));
    const recovery = await routes.restoreSafety(id, operationId, parsed.data);
    await recordHumanAction(
      mcp?.auditService,
      {
        type: "workspace_checkpoint_restore_started",
        status: "success",
        summary: "Workspace safety restore requested",
        principal: humanPrincipal(),
        actorType: "human",
        orchestrationId: id,
        projectId: recovery.projectId,
        metadata: {
          operationId,
          ...(recovery.safetyCheckpointId === null ? {} : { checkpointId: recovery.safetyCheckpointId }),
          requestId: parsed.data.requestId,
          trigger: "http",
        },
      },
      request.log,
    );
    return reply.code(202).send({ recovery });
  });

  /**
   * Prompt-policy settings for one Conversation.
   *
   * Separate from start/continue because it changes nothing about the run in
   * flight: it records how the next cycle should be prompted.
   */
  app.patch("/api/orchestrations/:id", async (request) => {
    const { id } = parseOrchestrationParams(request.params);
    const orchestration = requireOrchestrationService(orchestrationService);
    if (!orchestration.updateSession) {
      throw new HttpError(501, "This server cannot change conversation settings");
    }
    const parsed = UpdateOrchestrationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new OrchestrationValidationError(
        "Invalid conversation settings",
        parsed.error.issues,
      );
    }
    return { session: await orchestration.updateSession(id, parsed.data) };
  });

  app.delete("/api/orchestrations/:id", async (request) => {
    const { id } = parseOrchestrationParams(request.params);
    return requireOrchestrationService(orchestrationService).deleteSession(id);
  });

  const usageQuery = z.object({
    since: z.string().datetime().optional(),
    days: z.coerce.number().int().min(1).max(365).optional(),
  });

  app.get("/api/usage", async (request) => {
    const query = usageQuery.parse(request.query);
    return { usage: service.usageReport(query) };
  });

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = parseAgentInput(createAgentBody, request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  /**
   * Writing help for the create/settings form.
   *
   * Suggestion-only: the response is text the form shows for review, and
   * nothing is persisted here. It confers no capability, so it deliberately
   * lives beside the Agent routes rather than inside the Agent mutation path.
   */
  app.get("/api/agent-drafts", async () => ({
    available: agentAuthoring?.available() === true,
  }));

  app.post("/api/agent-drafts", async (request) => {
    if (!agentAuthoring) {
      throw new HttpError(
        503,
        "Drafting help is not enabled on this server.",
      );
    }
    const parsed = AgentDraftRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        422,
        "Describe the Agent you want in a sentence or two before asking for a draft.",
      );
    }
    return { draft: await agentAuthoring.draft(parsed.data) };
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = parseAgentInput(updateAgentBody, request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  /**
   * Cosmetic-only. Separate from the Agent PATCH because appearance never
   * reaches the runtime prompt or the authorization directory, so it must not
   * share their failure modes.
   */
  app.patch("/api/agents/:id/appearance", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const appearance = appearanceBody.parse(request.body);
    return { agent: await service.updateAgentAppearance(id, appearance) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const agent = await service.startAgent(id);
    await recordHumanAction(mcp?.auditService, {
      type: "agent_started",
      status: "success",
      summary: "Agent started",
      principal: humanPrincipal(),
      actorType: "human",
      agentId: id,
      metadata: { trigger: "http" },
    }, request.log);
    return { agent };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const agent = await service.stopAgent(id);
    await recordHumanAction(mcp?.auditService, {
      type: "agent_stopped",
      status: "success",
      summary: "Agent stopped",
      principal: humanPrincipal(),
      actorType: "human",
      agentId: id,
      metadata: { trigger: "http" },
    }, request.log);
    return { agent };
  });

  app.post("/api/agents/:id/preview/start", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = agentIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).start({ kind: "agent", agentId: id });
    return reply.code(202).send({ preview });
  });

  app.get("/api/agents/:id/preview", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return {
      preview: await requirePreviewService(previewService).get({
        kind: "agent",
        agentId: id,
      }),
    };
  });

  app.post("/api/agents/:id/preview/restart", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = agentIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).restart({ kind: "agent", agentId: id });
    return reply.code(202).send({ preview });
  });

  app.post("/api/agents/:id/preview/stop", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).stop({ kind: "agent", agentId: id });
    return reply.code(202).send({ preview });
  });

  app.get("/api/agents/:id/preview/logs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const query = z.object({
      tail: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    return requirePreviewService(previewService).logs({ kind: "agent", agentId: id }, query.tail);
  });

  // MCP authentication is deliberately separate from the browser's optional
  // APP_AUTH_TOKEN. Every request must carry a short-lived per-run bearer
  // token and is rejected before SDK dispatch when no session is supplied.
  if (mcp) registerMcpRoute(app, mcp);

  registerAgentMiddlewareRoutes(app, {
    service,
    ...(mcp === undefined ? {} : { mcp }),
  });

  // Approval control is an optional HTTP projection. The composition root
  // decides when the bridge and its Project policy authority are available;
  // this app boundary never constructs either dependency. The route module
  // fails closed with 503 while approval mode is not wired.
  const approvalToolService = mcp?.toolService;
  const approvalRoutes: ToolApprovalRouteDependencies = {
    ...(mcp?.approvalService === undefined ? {} : { approvalService: mcp.approvalService }),
    ...(mcp?.authorizationService === undefined
      ? {}
      : { authorizationService: mcp.authorizationService }),
    getRun: (runId) => service.getRun(runId),
    ...(mcp?.sessions === undefined
      ? {}
      : {
          isSessionLive: (sessionId, record) =>
            mcp.sessions.isLive(sessionId, {
              agentId: record.agentId,
              projectId: record.projectId,
              runId: record.runId,
              orchestrationId: record.orchestrationId,
            }),
        }),
    ...(approvalToolService === undefined
      ? {}
      : {
          resolveDecisionAuthority: (toolId: string) => {
            // A few read-only app fixtures provide only a structural tool
            // service. Keep their known built-in projections readable while
            // the production composition always takes the registry branch.
            const registry = typeof (approvalToolService as unknown as { getRegistry?: unknown }).getRegistry === "function"
              ? approvalToolService.getRegistry()
              : undefined;
            if (registry === undefined) return approvalDecisionAuthorityForTool(toolId);
            const definition = registry.get(toolId);
            // A current registered required policy is the authority source.
            // The helper only supplies the immutable built-in compatibility
            // mapping when that policy has no explicit authority metadata.
            if (definition?.approvalPolicy?.mode !== "required") return null;
            return approvalDecisionAuthorityForTool(toolId, definition.approvalPolicy);
          },
          authorizeAgent: async (record) => {
            await approvalToolService.assertCurrentAgentToolAuthorized({
              agentId: record.agentId,
              runId: record.runId,
              toolId: record.toolId,
              ...(record.projectId === null ? {} : { projectId: record.projectId }),
              ...(record.orchestrationId === null
                ? {}
                : { orchestrationId: record.orchestrationId }),
            });
          },
        }),
  };
  registerToolApprovalRoutes(app, approvalRoutes);

  if (agentMetrics) {
    registerAgentMetricsRoutes(app, {
      metrics: agentMetrics,
      getAgent: (agentId) => service.getAgent(agentId),
      projectAgentIds: async (projectId) =>
        (await requireProjectService(projectService).get(projectId)).agentIds,
    });
  }

  // ------------------------------------------------------------- Projects
  // A Project owns the shared workspace a Team collaborates on. Its preview
  // is the canonical artifact and is independent of any single Agent.

  const projectIdParams = z.object({ id: z.string().uuid() });
  const projectAgentParams = z.object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
  });
  const projectTeamParams = z.object({
    id: z.string().uuid(),
    teamId: z.string().uuid(),
  });
  const createProjectBody = z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
  });
  const updateProjectBody = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
  });
  const updateProjectAgentRoleBody = z.object({
    role: z.enum(["owner", "editor", "viewer"]),
  });
  const attachProjectAgentBody = z.object({
    role: z.enum(["owner", "editor", "viewer"]).optional(),
  });

  app.post("/api/projects", async (request, reply) => {
    const body = createProjectBody.parse(request.body);
    const project = await requireProjectService(projectService).create(body);
    return reply.code(201).send({ project });
  });

  app.get("/api/projects", async () => {
    return { projects: await requireProjectService(projectService).list() };
  });

  app.get("/api/projects/:id/activity", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const query = auditQuery.parse(request.query);
    await requireProjectService(projectService).get(id);
    const approvals = mcp?.approvalService === undefined
      ? []
      : await listVisibleToolApprovals(approvalRoutes, {
          projectId: id,
          includeTerminal: true,
        });
    return {
      events: requireAuditService(mcp).query({ ...query, projectId: id }),
      approvals,
    };
  });

  app.get("/api/projects/:id", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    return { project: await requireProjectService(projectService).get(id) };
  });

  app.patch("/api/projects/:id", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const body = updateProjectBody.parse(request.body);
    return { project: await requireProjectService(projectService).update(id, body) };
  });

  // Archive rather than delete: the shared artifact is the point of the wave.
  app.delete("/api/projects/:id", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    return requireProjectService(projectService).archive(id);
  });

  // Permanent deletion is deliberately a separate route from archive. The
  // service still moves active files through its recoverable archive path,
  // while this operation removes the Workspace's database records.
  app.delete("/api/projects/:id/permanent", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    return requireProjectService(projectService).deletePermanently(id);
  });

  app.post("/api/projects/:id/agents/:agentId", async (request) => {
    const { id, agentId } = projectAgentParams.parse(request.params);
    // The membership tier governs which tools the Agent may run, so it is
    // settable at attach time instead of only through a follow-up PATCH.
    const { role } = attachProjectAgentBody.parse(request.body ?? {});
    const project = await requireProjectService(projectService).attachAgent(
      id,
      agentId,
      humanPrincipal(),
      role,
    );
    return { project };
  });

  app.delete("/api/projects/:id/agents/:agentId", async (request) => {
    const { id, agentId } = projectAgentParams.parse(request.params);
    return { project: await requireProjectService(projectService).detachAgent(id, agentId) };
  });

  app.patch("/api/projects/:id/agents/:agentId", async (request) => {
    const { id, agentId } = projectAgentParams.parse(request.params);
    const { role } = updateProjectAgentRoleBody.parse(request.body);
    const projects = requireProjectService(projectService);
    const before = await projects.get(id);
    const fromRole = before.memberships.find((m) => m.agentId === agentId)?.role;
    const project = await projects.updateAgentRole(id, agentId, role);
    await recordHumanAction(mcp?.auditService, {
      type: "project_role_changed",
      status: "success",
      summary: "Project Agent role changed",
      principal: humanPrincipal(),
      actorType: "human",
      projectId: id,
      agentId,
      metadata: {
        ...(fromRole === undefined ? {} : { fromRole }),
        toRole: role,
      },
    }, request.log);
    return { project };
  });

  app.post("/api/projects/:id/team/:teamId", async (request) => {
    const { id, teamId } = projectTeamParams.parse(request.params);
    return { project: await requireProjectService(projectService).attachTeam(id, teamId) };
  });

  app.delete("/api/projects/:id/team", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    return { project: await requireProjectService(projectService).detachTeam(id) };
  });

  // Safe checkpoint projections. No SHA, path, prompt, or saved context
  // crosses this boundary, and there is no restore-by-revision route.
  const checkpointListQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    beforeOrdinal: z.coerce.number().int().positive().optional(),
  });
  const checkpointParams = z.object({
    id: z.string().uuid(),
    checkpointId: z.string().min(1).max(128),
  });

  app.get("/api/projects/:id/checkpoints", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const query = checkpointListQuery.parse(request.query);
    const projects = requireProjectService(projectService);
    if (!projects.listWorkspaceCheckpoints) {
      throw new HttpError(503, "Workspace checkpoints are not configured on this server");
    }
    return projects.listWorkspaceCheckpoints(id, query);
  });

  app.get("/api/projects/:id/checkpoints/:checkpointId", async (request) => {
    const { id, checkpointId } = checkpointParams.parse(request.params);
    const projects = requireProjectService(projectService);
    if (!projects.getWorkspaceCheckpoint) {
      throw new HttpError(503, "Workspace checkpoints are not configured on this server");
    }
    return { checkpoint: await projects.getWorkspaceCheckpoint(id, checkpointId) };
  });

  app.post("/api/projects/:id/preview/start", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = projectIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).start({
      kind: "project",
      projectId: id,
    });
    return reply.code(202).send({ preview });
  });

  app.get("/api/projects/:id/preview", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    return {
      preview: await requirePreviewService(previewService).get({
        kind: "project",
        projectId: id,
      }),
    };
  });

  app.post("/api/projects/:id/preview/restart", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = projectIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).restart({
      kind: "project",
      projectId: id,
    });
    return reply.code(202).send({ preview });
  });

  app.post("/api/projects/:id/preview/stop", async (request, reply) => {
    const { id } = projectIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).stop({
      kind: "project",
      projectId: id,
    });
    return reply.code(202).send({ preview });
  });

  app.get("/api/projects/:id/preview/logs", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const query = z.object({
      tail: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    return requirePreviewService(previewService).logs(
      { kind: "project", projectId: id },
      query.tail,
    );
  });

  // ------------------------------------- private Agent conversations
  // Conversations scope direct history and the Codex session. They all share
  // the one Agent workspace, so deleting a conversation never touches files.

  const conversationParams = z.object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
  });
  const conversationQuery = z.object({ conversationId: z.string().uuid().optional() });
  const conversationTitleBody = z.object({ title: z.string().trim().min(1).max(80) });

  app.get("/api/agents/:id/conversations", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { conversations: service.listConversations(id) };
  });

  app.post("/api/agents/:id/conversations", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = z
      .object({ title: z.string().trim().min(1).max(80).optional() })
      .parse(request.body ?? {});
    const conversation = await service.createConversation(id, body.title);
    return reply.code(201).send({ conversation });
  });

  app.patch("/api/agents/:id/conversations/:conversationId", async (request) => {
    const { id, conversationId } = conversationParams.parse(request.params);
    const body = conversationTitleBody.parse(request.body);
    return {
      conversation: await service.renameConversation(id, conversationId, body.title),
    };
  });

  app.delete("/api/agents/:id/conversations/:conversationId", async (request) => {
    const { id, conversationId } = conversationParams.parse(request.params);
    return service.deleteConversation(id, conversationId);
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { conversationId } = conversationQuery.parse(request.query);
    return {
      messages: service.getMessages(
        id,
        conversationId === undefined ? {} : { conversationId },
      ),
    };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { conversationId } = conversationQuery.parse(request.query);
    return {
      runs: service.getRuns(id, conversationId === undefined ? {} : { conversationId }),
    };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    requireApplicationAvailability(applicationHealth);
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, {
      ...(body.conversationId === undefined
        ? {}
        : { conversationId: body.conversationId }),
    });
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/runs/:id/activity", async (request) => {
    const { id } = runIdParams.parse(request.params);
    service.getRun(id);
    const query = auditQuery.parse(request.query);
    const approvals = mcp?.approvalService === undefined
      ? []
      : await listVisibleToolApprovals(approvalRoutes, {
          runId: id,
          includeTerminal: true,
        });
    return {
      events: requireAuditService(mcp).query({ ...query, runId: id }),
      approvals,
    };
  });

  // The bundled web is served in production. Development/test servers remain
  // API-only and the separate web dev server handles the frontend.
  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    const assetsRoot = join(webRoot, "assets");
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      // Vite fingerprints every file it emits into `assets`, so a given URL
      // there never changes content and can be cached indefinitely. Everything
      // else, index.html above all, must be refetched: a browser that reuses a
      // stale shell asks for asset hashes the new build no longer serves, which
      // is why a redeploy used to need a hard reload or a private window.
      setHeaders(reply, filePath) {
        const cacheControl = filePath.startsWith(assetsRoot + sep)
          ? "public, max-age=31536000, immutable"
          : "no-store";
        reply.header("cache-control", cacheControl);
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const modelError = error instanceof ModelCatalogError ? error : null;
    const authorizationError = isAuthorizationError(error) ? error : null;
    const toolError = error instanceof ToolError ? error : null;
    const previewError = isPreviewError(error) ? error : null;
    const projectError = isProjectError(error) ? error : null;
    const checkpointError = isWorkspaceCheckpointError(error) ? error : null;
    const skillError = isSkillError(error) ? error : null;
    const roleError = isRoleError(error) ? error : null;
    const storageUnavailable = appError.name === "StorageUnavailableError";
    const validationError = error instanceof z.ZodError;
    const details = validationError
      ? error.issues
      : error instanceof OrchestrationValidationError
        ? error.details
        : undefined;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : storageUnavailable
          ? 503
          : validationError
            ? 400
            : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
              ? frameworkStatus
              : 500;
    if (statusCode >= 500) {
      if (previewError) {
        // Runtime errors can carry container CLI stdout/stderr in their cause.
        // Log only the normalized preview projection at the HTTP boundary.
        request.log.error(
          { errorCode: previewError.code, message: previewError.message },
          "Preview operation failed",
        );
      } else {
        request.log.error(appError);
      }
    }
    const responseMessage = previewError === null ? appError.message : previewError.message;
    const errorCode = authorizationError?.errorCode ??
      modelError?.code ??
      toolError?.code ??
      previewError?.code ??
      projectError?.code ??
      checkpointError?.code ??
      skillError?.code ??
      roleError?.code ??
      (storageUnavailable ? STORAGE_UNAVAILABLE_CODE : undefined);
    return reply.code(statusCode).send({
      error: responseMessage,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(details !== undefined ? { details } : {}),
    });
  });

  return app;
}
