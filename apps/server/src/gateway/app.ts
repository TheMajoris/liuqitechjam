import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import {
  LeaseRegistry,
  type LeaseDenialCode,
} from "./lease-registry.js";
import {
  ProviderCatalog,
  ProviderNotFoundError,
  type ProviderCatalogPort,
} from "./provider-catalog.js";
import {
  ProviderHttpError,
  type ProviderErrorCode,
} from "./providers/responses-http-provider.js";
import { normalizeResponsesRequest } from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface GatewayDeps {
  /** Test seam: inject a spy/stub catalog. */
  catalog?: ProviderCatalogPort;
  /** Test seam: inject a lease registry (e.g. with a controlled clock). */
  leases?: LeaseRegistry;
  /** Clock used only when `leases` is not supplied. */
  now?: () => number;
  /** Data-plane upstream timeout. Default 60s. */
  requestTimeoutMs?: number;
  /** Test seam: capture structured log output. */
  logStream?: { write(chunk: string): void };
}

const leaseBodySchema = z.object({
  runId: z.string().trim().min(1).max(200),
  agentId: z.string().trim().min(1).max(200),
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  scope: z.literal("responses:create"),
  projectId: z.string().trim().min(1).max(200).optional(),
  orchestrationId: z.string().trim().min(1).max(200).optional(),
  ttlSeconds: z.coerce.number().int().min(1).max(3600).optional(),
});

const leaseParamsSchema = z.object({ id: z.string().trim().min(1).max(200) });

const providerParamsSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
});

// Unknown keys (temperature, tools, …) are ignored; only these drive routing.
const responsesBodySchema = z.object({
  model: z.string().trim().min(1).max(200),
  input: z.union([z.string(), z.array(z.unknown())]),
  instructions: z.string().optional(),
});

const leaseDenialStatus: Record<LeaseDenialCode, number> = {
  LEASE_INVALID: 401,
  LEASE_EXPIRED: 401,
  LEASE_REVOKED: 401,
  LEASE_SCOPE_MISMATCH: 403,
};

const leaseDenialMessage: Record<LeaseDenialCode, string> = {
  LEASE_INVALID: "Lease is missing, malformed, or unknown",
  LEASE_EXPIRED: "Lease has expired",
  LEASE_REVOKED: "Lease has been revoked",
  LEASE_SCOPE_MISMATCH: "Lease does not authorize this provider, model, or scope",
};

const providerErrorStatus: Record<ProviderErrorCode, number> = {
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_ERROR: 502,
};

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function timingSafeStringEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function buildGatewayApp(
  config: GatewayConfig,
  deps: GatewayDeps = {},
): Promise<FastifyInstance> {
  const catalog: ProviderCatalogPort =
    deps.catalog ?? new ProviderCatalog(config.providers);
  const leases = deps.leases ?? new LeaseRegistry(deps.now);
  const requestTimeoutMs =
    deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.token",
        "*.apiKey",
      ],
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    bodyLimit: 1_048_576,
  });

  const requireAdmin = (request: FastifyRequest): boolean =>
    timingSafeStringEquals(bearerToken(request), config.adminToken);

  app.get("/internal/health", async () => ({
    ok: true,
    providers: catalog.list(),
    leases: { active: leases.activeCount() },
  }));

  app.post("/internal/leases", async (request, reply) => {
    if (!requireAdmin(request)) {
      return reply
        .code(401)
        .send({ error: "Gateway admin authentication required", code: "ADMIN_UNAUTHORIZED" });
    }
    const body = leaseBodySchema.parse(request.body);
    if (!catalog.has(body.providerId)) {
      return reply
        .code(400)
        .send({ error: `Unknown provider: ${body.providerId}`, code: "PROVIDER_NOT_FOUND" });
    }
    if (!catalog.allowsModel(body.providerId, body.model)) {
      return reply.code(400).send({
        error: `Model ${body.model} is not allowed for provider ${body.providerId}`,
        code: "MODEL_NOT_ALLOWED",
      });
    }
    const issued = leases.issue({
      runId: body.runId,
      agentId: body.agentId,
      providerId: body.providerId,
      model: body.model,
      scope: body.scope,
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.orchestrationId !== undefined
        ? { orchestrationId: body.orchestrationId }
        : {}),
      ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
    });
    return reply.code(201).send(issued);
  });

  app.post("/internal/leases/:id/revocations", async (request, reply) => {
    if (!requireAdmin(request)) {
      return reply
        .code(401)
        .send({ error: "Gateway admin authentication required", code: "ADMIN_UNAUTHORIZED" });
    }
    const { id } = leaseParamsSchema.parse(request.params);
    leases.revoke(id);
    return reply.send({ revoked: true });
  });

  app.post("/p/:providerId/v1/responses", async (request, reply) => {
    const { providerId } = providerParamsSchema.parse(request.params);
    const token = bearerToken(request);

    // Body is parsed first because the lease check is scoped to the requested
    // model. A malformed body is rejected here, before any provider work.
    const parsedBody = responsesBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: "Invalid Responses request",
        code: "INVALID_INPUT",
        details: parsedBody.error.issues,
      });
    }

    // Step 1 & 2: lease validation. No provider work happens on any failure.
    const check = leases.validate(token, { providerId, model: parsedBody.data.model });
    if (!check.ok) {
      return reply
        .code(leaseDenialStatus[check.code])
        .send({ error: leaseDenialMessage[check.code], code: check.code });
    }

    // Step 3: provider resolution. Unknown id fails closed with zero calls.
    let provider;
    try {
      provider = catalog.resolve(providerId);
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return reply
          .code(404)
          .send({ error: error.message, code: "PROVIDER_NOT_FOUND" });
      }
      throw error;
    }

    // Step 4: bounded provider call.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const normalized = normalizeResponsesRequest(parsedBody.data);
      const result = await provider.respond(normalized, controller.signal);
      // Step 5: normalized reply only, never a raw upstream envelope.
      return reply.send({
        output: result.output,
        usage: result.usage,
        model: result.model,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return reply
          .code(504)
          .send({ error: "Provider request timed out", code: "RUNTIME_TIMEOUT" });
      }
      if (error instanceof ProviderHttpError) {
        return reply
          .code(providerErrorStatus[error.code])
          .send({ error: "Provider request failed", code: error.code });
      }
      request.log.error({ code: "PROVIDER_ERROR" }, "provider adapter failed");
      return reply
        .code(502)
        .send({ error: "Provider request failed", code: "PROVIDER_ERROR" });
    } finally {
      clearTimeout(timer);
    }
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "Not found", code: "NOT_FOUND" });
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode = validationError
      ? 400
      : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
        ? frameworkStatus
        : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal gateway error" : appError.message,
      ...(validationError
        ? { code: "INVALID_INPUT", details: error.issues }
        : {}),
    });
  });

  return app;
}
