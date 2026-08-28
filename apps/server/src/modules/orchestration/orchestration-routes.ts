import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrchestrationControl } from "./orchestration-control.js";

const createBody = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(20_000),
  providerId: z.string().trim().min(1).max(200),
});

const listQuery = z.object({
  projectId: z.string().uuid().optional(),
  status: z
    .enum(["queued", "running", "completed", "failed", "cancelled", "blocked"])
    .optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const idParams = z.object({ id: z.string().uuid() });

/** Registers `/api/orchestrations` routes against an `OrchestrationControl`. */
export function registerOrchestrationRoutes(
  app: FastifyInstance,
  control: OrchestrationControl,
): void {
  app.get("/api/orchestrations", async (request) => {
    const query = listQuery.parse(request.query);
    return control.list(query);
  });

  app.post("/api/orchestrations", async (request, reply) => {
    const body = createBody.parse(request.body);
    const header = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    const view = await control.enqueue({ ...body, idempotencyKey });
    return reply.code(202).send(view);
  });

  app.get("/api/orchestrations/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return control.inspect(id);
  });

  app.post("/api/orchestrations/:id/cancellations", async (request) => {
    const { id } = idParams.parse(request.params);
    return control.cancel(id);
  });

  app.get("/api/orchestrations/:id/messages", async (request) => {
    const { id } = idParams.parse(request.params);
    const view = await control.inspect(id);
    return { messages: view.messages };
  });
}
