import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentMetricsService } from "../usage/agent-metrics.js";
import { agentIdParams } from "./route-schemas.js";

const projectIdParams = z.object({ id: z.string().uuid() });

export interface AgentMetricsRouteDependencies {
  metrics: AgentMetricsService;
  /** Throws (e.g. HttpError 404) when the Agent is unknown, like AgentService#getAgent. */
  getAgent: (agentId: string) => unknown;
  /** Agent IDs attached to a Project; throws/rejects (e.g. 404) when the Project is unknown. */
  projectAgentIds: (projectId: string) => string[] | Promise<string[]>;
}

/** The HTTP seam exposing live per-Agent runtime metrics. */
export function registerAgentMetricsRoutes(
  app: FastifyInstance,
  dependencies: AgentMetricsRouteDependencies,
): void {
  app.get("/api/agents/:id/metrics", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    dependencies.getAgent(id);
    return dependencies.metrics.forAgent(id);
  });

  app.get("/api/projects/:id/agent-metrics", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const agentIds = await dependencies.projectAgentIds(id);
    return { agents: dependencies.metrics.forAgents(agentIds) };
  });
}
