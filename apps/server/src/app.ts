import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AuditEventInput, AuditReader, AuditSpan } from "./audit/audit-types.js";
import { newSpanId } from "./audit/audit-span.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import {
  isAuthorizationError,
} from "./access/authorization-service.js";
import { humanPrincipal } from "./access/access-types.js";
import type { AgentService } from "./agent-service.js";
import { registerAgentMiddlewareRoutes } from "./http/agent-middleware-routes.js";
import { recordHumanAction } from "./http/human-action-audit.js";
import { agentIdParams, auditQuery, runIdParams } from "./http/route-schemas.js";
import { registerMcpRoute, type McpRouteDependencies } from "./mcp-server.js";
import { ToolApprovalRequiredError, ToolError } from "./tools/tool-errors.js";
import { PermitApprovalError } from "./access/permit-approval-service.js";
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
  type ArkModelCatalogRecord,
  type ModelDescriptor,
  type ModelRegistry,
} from "./models/index.js";
import {
  ContinueOrchestrationSchema,
  CreateOrchestrationSchema,
  OrchestrationRouteParamsSchema,
  StartOrchestrationSchema,
} from "./orchestration/schemas.js";
import type {
  CreateOrchestrationInput,
  OrchestrationSession,
  OrchestrationSessionDetail,
} from "./orchestration/types.js";
import { isProjectError } from "./projects/project-errors.js";
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
  deleteSession(id: string): Promise<{ deleted: boolean }>;
  /** Root trace span for this orchestration; optional so route tests can omit it. */
  orchestrationSpan?(id: string): AuditSpan;
}

/** Narrow HTTP-facing seam for the Project control plane. */
export interface ProjectServiceContract {
  create(input: CreateProjectInput): Promise<ProjectView>;
  list(): Promise<ProjectView[]>;
  get(projectId: string): Promise<ProjectView>;
  update(projectId: string, input: UpdateProjectInput): Promise<ProjectView>;
  archive(projectId: string): Promise<{ archivedWorkspace: string | null }>;
  deletePermanently(projectId: string): Promise<{ deleted: boolean }>;
  attachAgent(projectId: string, agentId: string): Promise<ProjectView>;
  updateAgentRole(
    projectId: string,
    agentId: string,
    role: ProjectRole,
  ): Promise<ProjectView>;
  detachAgent(projectId: string, agentId: string): Promise<ProjectView>;
  attachTeam(projectId: string, teamId: string): Promise<ProjectView>;
  detachTeam(projectId: string): Promise<ProjectView>;
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
  updateSelection?(input: unknown): Promise<ArkModelCatalogRecord>;
}

/** Cosmetic only. Every field is optional; absent means the ID-derived look. */
const appearanceBody = z.object({
  hue: z.number().int().min(0).max(359).optional(),
  hair: z.number().int().min(0).max(5).optional(),
  skin: z.number().int().min(0).max(3).optional(),
  accessory: z.enum(["none", "glasses", "headset", "cap"]).optional(),
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

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
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

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/model-providers", async (request) => {
    const { scope } = ModelScopeQuerySchema.parse(request.query);
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
    const { scope } = ModelScopeQuerySchema.parse(request.query);
    return {
      models: await modelRegistry.listModels(providerId, scope),
    };
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
      if (defaultModelRef === undefined) {
        try {
          const resolved = modelRegistry.resolveWorkerModel();
          defaultModelRef = {
            providerId: resolved.providerId,
            modelId: resolved.modelId,
          };
        } catch (error) {
          if (!(error instanceof ModelCatalogError)) throw error;
          defaultModelRef = null;
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

    app.get("/api/model-catalog", async () => aggregateModelCatalog());

    app.put("/api/model-catalog", async (request) => {
      if (typeof modelCatalog.updateSelection !== "function") {
        throw new HttpError(503, "Model catalog updates are not configured");
      }
      const catalog = await modelCatalog.updateSelection(request.body);
      modelRegistry.invalidate?.();
      return aggregateModelCatalog(catalog);
    });

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
    if (body.modelRef !== undefined) {
      modelRegistry.validateWorkerModelRef(body.modelRef);
    }
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = parseAgentInput(updateAgentBody, request.body);
    if (body.modelRef !== undefined) {
      modelRegistry.validateWorkerModelRef(body.modelRef);
    }
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
    return {
      events: requireAuditService(mcp).query({ ...query, projectId: id }),
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
    return { project: await requireProjectService(projectService).attachAgent(id, agentId) };
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

  app.post("/api/projects/:id/preview/start", async (request, reply) => {
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
    return {
      events: requireAuditService(mcp).query({ ...query, runId: id }),
    };
  });

  // The local POC launcher keeps NODE_ENV=production so the bundled web is
  // served exactly like the deployable build, while authorization mode still
  // controls whether Permit is assembled. Direct local-mode starts should
  // serve it too; Permit development/test servers retain their API-only mode.
  if (config.nodeEnv === "production" || config.authorizationMode === "local") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
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
    const skillError = isSkillError(error) ? error : null;
    const roleError = isRoleError(error) ? error : null;
    const permitApprovalError = error instanceof PermitApprovalError ? error : null;
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
      skillError?.code ??
      roleError?.code ??
      permitApprovalError?.code;
    return reply.code(statusCode).send({
      error: responseMessage,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(toolError instanceof ToolApprovalRequiredError
        ? { approvalRequestId: toolError.approvalRequestId }
        : {}),
      ...(details !== undefined ? { details } : {}),
    });
  });

  return app;
}
