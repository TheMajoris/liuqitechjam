import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectService } from "./project-service.js";

const rolesBody = z.object({
  plannerAgentId: z.string().uuid(),
  builderAgentId: z.string().uuid(),
  reviewerAgentId: z.string().uuid(),
});

const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  roles: rolesBody,
});

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500),
    roles: rolesBody,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

const idParams = z.object({ id: z.string().uuid() });

/** Registers `/api/projects` routes against an existing `ProjectService`. */
export function registerProjectRoutes(
  app: FastifyInstance,
  projects: ProjectService,
): void {
  app.get("/api/projects", async () => ({ projects: projects.list() }));

  app.post("/api/projects", async (request, reply) => {
    const body = createBody.parse(request.body);
    const project = await projects.create(body);
    return reply.code(201).send({ project });
  });

  app.get("/api/projects/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return { project: projects.get(id) };
  });

  app.patch("/api/projects/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateBody.parse(request.body);
    return { project: await projects.update(id, body) };
  });

  app.post("/api/projects/:id/archive", async (request) => {
    const { id } = idParams.parse(request.params);
    return projects.archive(id);
  });
}
