import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import { isPreviewError } from "./preview/preview-service.js";
import type { PreviewLogsView } from "./preview/preview-service.js";
import type { PreviewView } from "./preview/preview-types.js";
import {
  createModelRegistry,
  ModelCatalogError,
  ModelProviderParamsSchema,
  ModelRefSchema,
  ModelScopeQuerySchema,
  type ModelRegistry,
} from "./models/index.js";
import {
  ContinueOrchestrationSchema,
  CreateOrchestrationSchema,
  OrchestrationRouteParamsSchema,
} from "./orchestration/schemas.js";
import type {
  CreateOrchestrationInput,
  OrchestrationSession,
  OrchestrationSessionDetail,
} from "./orchestration/types.js";

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
  startSession(id: string): Promise<OrchestrationSession>;
  stopSession(id: string): Promise<OrchestrationSession>;
  continueSession(id: string, prompt: string): Promise<OrchestrationSession>;
  deleteSession(id: string): Promise<{ deleted: boolean }>;
}

/** Narrow HTTP-facing seam for the trusted preview control plane. */
export interface PreviewServiceContract {
  start(agentId: string): Promise<PreviewView>;
  get(agentId: string): Promise<PreviewView>;
  restart(agentId: string): Promise<PreviewView>;
  stop(agentId: string): Promise<PreviewView>;
  logs(agentId: string, tail?: number): Promise<PreviewLogsView>;
}

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  modelRef: ModelRefSchema.optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
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

export async function createApp(
  config: AppConfig,
  service: AgentService,
  orchestrationService?: OrchestrationServiceContract,
  modelRegistry: ModelRegistry = createModelRegistry(config),
  previewService?: PreviewServiceContract,
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
    const session = await requireOrchestrationService(
      orchestrationService,
    ).startSession(id);
    return reply.code(202).send({ session });
  });

  app.post("/api/orchestrations/:id/stop", async (request, reply) => {
    const { id } = parseOrchestrationParams(request.params);
    const session = await requireOrchestrationService(
      orchestrationService,
    ).stopSession(id);
    return reply.code(202).send({ session });
  });

  app.post("/api/orchestrations/:id/continue", async (request, reply) => {
    const { id } = parseOrchestrationParams(request.params);
    const { prompt } = parseContinuationInput(request.body);
    const session = await requireOrchestrationService(
      orchestrationService,
    ).continueSession(id, prompt);
    return reply.code(202).send({ session });
  });

  app.delete("/api/orchestrations/:id", async (request) => {
    const { id } = parseOrchestrationParams(request.params);
    return requireOrchestrationService(orchestrationService).deleteSession(id);
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

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.post("/api/agents/:id/preview/start", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).start(id);
    return reply.code(202).send({ preview });
  });

  app.get("/api/agents/:id/preview", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { preview: await requirePreviewService(previewService).get(id) };
  });

  app.post("/api/agents/:id/preview/restart", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).restart(id);
    return reply.code(202).send({ preview });
  });

  app.post("/api/agents/:id/preview/stop", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const preview = await requirePreviewService(previewService).stop(id);
    return reply.code(202).send({ preview });
  });

  app.get("/api/agents/:id/preview/logs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const query = z.object({
      tail: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    return requirePreviewService(previewService).logs(id, query.tail);
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  if (config.nodeEnv === "production") {
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
    const previewError = isPreviewError(error) ? error : null;
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
    return reply.code(statusCode).send({
      error: responseMessage,
      ...(modelError === null ? {} : { errorCode: modelError.code }),
      ...(previewError === null ? {} : { errorCode: previewError.code }),
      ...(details !== undefined ? { details } : {}),
    });
  });

  return app;
}
