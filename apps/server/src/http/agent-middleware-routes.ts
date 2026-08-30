import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuditReader } from "../audit/audit-types.js";
import type { AgentService } from "../agent-service.js";
import { HttpError } from "../errors.js";
import type { McpRouteDependencies } from "../mcp-server.js";
import { agentIdParams, auditQuery } from "./route-schemas.js";
import { RoleError, type RoleService } from "../roles/role-service.js";

/**
 * The HTTP seam for Agent Middleware control-plane routes.
 *
 * The module owns validation and response shaping for tools, skills,
 * Permit-backed approvals, and audit projections. It deliberately receives
 * only the Agent operations needed by those routes; execution and policy
 * remain inside their respective server-owned modules.
 */
export interface AgentMiddlewareRouteDependencies {
  service: Pick<AgentService, "getAgent" | "updateAgentSkills">;
  mcp?: McpRouteDependencies;
}

function requireToolService(
  dependencies: McpRouteDependencies | undefined,
): McpRouteDependencies["toolService"] {
  if (!dependencies) throw new HttpError(503, "Tools are not configured");
  return dependencies.toolService;
}

function requireSkillService(
  dependencies: McpRouteDependencies | undefined,
): NonNullable<McpRouteDependencies["skillService"]> {
  const skillService = dependencies?.skillService;
  if (!skillService) throw new HttpError(503, "Skills are not configured");
  return skillService;
}

function requireRoleService(
  dependencies: McpRouteDependencies | undefined,
): RoleService {
  const roleService = dependencies?.roleService;
  if (!roleService) throw new HttpError(503, "Roles are not configured");
  return roleService;
}

function requireSearchProvider(
  dependencies: McpRouteDependencies | undefined,
): NonNullable<McpRouteDependencies["searchProvider"]> {
  const searchProvider = dependencies?.searchProvider;
  if (!searchProvider) throw new HttpError(503, "Web search is not configured");
  return searchProvider;
}

function requireApprovalService(
  dependencies: McpRouteDependencies | undefined,
): NonNullable<McpRouteDependencies["approvalService"]> {
  const approvalService = dependencies?.approvalService;
  if (!approvalService) throw new HttpError(503, "Permit approvals are not configured");
  return approvalService;
}

function requireAuditService(
  dependencies: McpRouteDependencies | undefined,
): AuditReader {
  const auditService = dependencies?.auditService;
  if (!auditService) throw new HttpError(503, "Audit activity is not configured");
  return auditService;
}

/** Register the Agent Middleware control-plane projections. */
export function registerAgentMiddlewareRoutes(
  app: FastifyInstance,
  { service, mcp }: AgentMiddlewareRouteDependencies,
): void {
  // ------------------------------------------------------- Capabilities
  // These are human-facing projections. They never mint Agent identity and
  // the test action always supplies the deterministic human principal while
  // naming an explicit Agent/Project target.
  const capabilityProjectQuery = z.object({ projectId: z.string().uuid().optional() });
  const capabilityGrantBody = z.object({
    projectId: z.string().uuid(),
    toolId: z.string().min(1),
    scope: z.enum(["once", "project"]),
  });
  const toolTestParams = z.object({ toolId: z.string().min(1) });
  const toolTestBody = z.object({
    agentId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    input: z.unknown().optional(),
  });
  const approvalIdParams = z.object({ id: z.string().min(1).max(256).regex(/^[^\\/\0\r\n]+$/) });
  const approvalQuery = z.object({
    agentId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    status: z.enum(["pending", "approved", "denied", "expired", "consumed", "revoked", "unknown"]).optional(),
    kind: z.enum(["operation_approval", "access_request"]).optional(),
  });
  const approvalDecisionBody = z.object({
    scope: z.enum(["once", "project"]).optional(),
  });

  app.get("/api/tools", async () => ({
    tools: requireToolService(mcp).listMetadata(),
  }));

  // Provider health is deliberately a separate, safe projection. It never
  // returns API keys or provider response bodies, and may be unavailable when
  // this route is used by isolated tests without the runtime composition root.
  app.get("/api/research/providers", async () => ({
    search: await requireSearchProvider(mcp).health(),
    fetch: {
      provider: "direct-http",
      status: "available",
      configured: true,
      message: "Direct public HTTP(S) fetching is enabled",
    },
  }));

  // Skills are declarative, code-owned guidance. The only mutable operation
  // below replaces an Agent's assignment; it cannot register or modify a
  // skill definition and it never touches capability grants.
  const skillIdParams = z.object({ id: z.string().min(1) });
  const agentSkillsQuery = z.object({ projectId: z.string().uuid().optional() });
  const updateAgentSkillsBody = z.object({
    skillIds: z.array(z.string().min(1)).max(32),
  });
  const skillSearchQuery = z.object({
    q: z.string().trim().max(200).default(""),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    installed: z.coerce.boolean().optional(),
  });
  const installSkillBody = z.object({ skillId: z.string().min(1).max(128) });
  const createSkillBody = z.object({
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    instructions: z.string().trim().min(1).max(10_000),
    requiredToolIds: z.array(z.string().min(1)).max(32).optional(),
    capabilityTags: z.array(z.string().min(1)).max(32).optional(),
    version: z.string().trim().max(64).optional(),
  });
  const updateSkillBody = createSkillBody.omit({ id: true }).partial().refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );

  app.get("/api/skills", async (request) => {
    const query = skillSearchQuery.parse(request.query);
    if (query.q.length > 0 || query.installed !== undefined || query.limit !== undefined) {
      return {
        skills: await requireSkillService(mcp).search(query.q, query),
      };
    }
    return { skills: await requireSkillService(mcp).list() };
  });

  app.get("/api/skills/search", async (request) => {
    const query = skillSearchQuery.parse(request.query);
    return {
      query: query.q,
      skills: await requireSkillService(mcp).search(query.q, query),
    };
  });

  app.get("/api/skills/:id", async (request) => {
    const { id } = skillIdParams.parse(request.params);
    return { skill: await requireSkillService(mcp).get(id) };
  });

  app.post("/api/skills/install", async (request, reply) => {
    const { skillId } = installSkillBody.parse(request.body);
    const skill = await requireSkillService(mcp).install(skillId);
    return reply.code(201).send({ skill });
  });

  app.delete("/api/skills/:id/install", async (request) => {
    const { id } = skillIdParams.parse(request.params);
    return requireSkillService(mcp).remove(id);
  });

  app.post("/api/skills", async (request, reply) => {
    const skill = await requireSkillService(mcp).create(createSkillBody.parse(request.body));
    return reply.code(201).send({ skill });
  });

  app.patch("/api/skills/:id", async (request) => {
    const { id } = skillIdParams.parse(request.params);
    const skill = await requireSkillService(mcp).update(id, updateSkillBody.parse(request.body));
    return { skill };
  });

  app.delete("/api/skills/:id", async (request) => {
    const { id } = skillIdParams.parse(request.params);
    return requireSkillService(mcp).remove(id);
  });

  app.get("/api/agents/:id/skills", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { projectId } = agentSkillsQuery.parse(request.query);
    const skillService = requireSkillService(mcp);
    return {
      skills: await skillService.readAgentSkills(service.getAgent(id), projectId),
    };
  });

  app.patch("/api/agents/:id/skills", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { skillIds } = updateAgentSkillsBody.parse(request.body);
    const agent = await service.updateAgentSkills(id, skillIds);
    return {
      agent,
      skills: await requireSkillService(mcp).forAgent(agent),
    };
  });

  app.put("/api/agents/:id/skills", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { skillIds } = updateAgentSkillsBody.parse(request.body);
    const agent = await service.updateAgentSkills(id, skillIds);
    return {
      agent,
      skills: await requireSkillService(mcp).forAgent(agent),
    };
  });

  // ------------------------------------------------------------- Role templates
  // Role templates are reusable global presets. Assignment is deliberately a
  // separate Project-scoped route so every Agent has at most one role per
  // Project attachment.
  const roleIdParams = z.object({ id: z.string().min(1).max(128) });
  const roleProjectAgentParams = z.object({
    projectId: z.string().uuid(),
    agentId: z.string().uuid(),
  });
  const createRoleBody = z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    skillIds: z.array(z.string().min(1)).max(32).optional(),
    toolIds: z.array(z.string().min(1)).max(64).optional(),
    permissionIds: z.array(z.string().min(1)).max(64).optional(),
  });
  const updateRoleBody = createRoleBody.partial().refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );
  const confirmedUpdateRoleBody = updateRoleBody.and(z.object({
    confirmPropagation: z.boolean().optional(),
  }));
  const assignRoleBody = z.object({ roleId: z.string().min(1).max(128) });

  app.get("/api/roles", async () => ({
    roles: await requireRoleService(mcp).list(),
  }));

  app.post("/api/roles", async (request, reply) => {
    const role = await requireRoleService(mcp).create(createRoleBody.parse(request.body));
    return reply.code(201).send({ role });
  });

  app.get("/api/roles/:id", async (request) => {
    const { id } = roleIdParams.parse(request.params);
    return { role: await requireRoleService(mcp).get(id) };
  });

  app.patch("/api/roles/:id", async (request) => {
    const { id } = roleIdParams.parse(request.params);
    return {
      role: await requireRoleService(mcp).update(id, confirmedUpdateRoleBody.parse(request.body)),
    };
  });

  app.delete("/api/roles/:id", async (request) => {
    const { id } = roleIdParams.parse(request.params);
    return requireRoleService(mcp).remove(id);
  });

  app.get("/api/projects/:projectId/agents/:agentId/role", async (request) => {
    const { projectId, agentId } = roleProjectAgentParams.parse(request.params);
    const role = requireRoleService(mcp).getAssignedRole(projectId, agentId);
    if (!role) throw new RoleError("ROLE_NOT_FOUND", "No role is assigned to this Project Agent");
    return { role };
  });

  app.put("/api/projects/:projectId/agents/:agentId/role", async (request) => {
    const { projectId, agentId } = roleProjectAgentParams.parse(request.params);
    const { roleId } = assignRoleBody.parse(request.body);
    return {
      assignment: await requireRoleService(mcp).assign(projectId, agentId, roleId),
    };
  });

  app.patch("/api/projects/:projectId/agents/:agentId/role", async (request) => {
    const { projectId, agentId } = roleProjectAgentParams.parse(request.params);
    const { roleId } = assignRoleBody.parse(request.body);
    return {
      assignment: await requireRoleService(mcp).assign(projectId, agentId, roleId),
    };
  });

  app.get("/api/agents/:id/capabilities", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { projectId } = capabilityProjectQuery.parse(request.query);
    service.getAgent(id);
    return {
      capabilities: await requireToolService(mcp).listCapabilities(id, projectId),
    };
  });

  // Permit owns approval state. These routes expose only the local safe
  // correlation projection and call Permit for every read/write; no request
  // body can select a principal (the service uses human:demo-owner).
  app.get("/api/approvals", async (request) => {
    const query = approvalQuery.parse(request.query);
    return {
      approvals: await requireApprovalService(mcp).listApprovals(query),
    };
  });

  app.get("/api/approvals/:id", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    return { approval: await requireApprovalService(mcp).getApproval(id) };
  });

  app.post("/api/approvals/:id/approve", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    const body = approvalDecisionBody.parse(request.body ?? {});
    return {
      approval: await requireApprovalService(mcp).approve(id, body.scope ?? "once"),
    };
  });

  app.post("/api/approvals/:id/grant", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    return {
      approval: await requireApprovalService(mcp).approve(id, "project"),
    };
  });

  app.post("/api/approvals/:id/deny", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    return { approval: await requireApprovalService(mcp).deny(id) };
  });

  app.post("/api/approvals/:id/revoke", async (request) => {
    const { id } = approvalIdParams.parse(request.params);
    return { grant: await requireToolService(mcp).revokeGrant(id) };
  });

  app.get("/api/agents/:id/capabilities/grants", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { projectId } = capabilityProjectQuery.parse(request.query);
    service.getAgent(id);
    return {
      grants: await requireToolService(mcp).listGrants(id, projectId),
    };
  });

  app.post("/api/agents/:id/capabilities/grants", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = capabilityGrantBody.parse(request.body);
    service.getAgent(id);
    const grant = await requireToolService(mcp).createGrant({
      agentId: id,
      ...body,
    });
    return reply.code(201).send({ grant });
  });

  app.delete("/api/capability-grants/:id", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { grant: await requireToolService(mcp).revokeGrant(id) };
  });

  app.post("/api/tools/:toolId/test", async (request) => {
    const { toolId } = toolTestParams.parse(request.params);
    const body = toolTestBody.parse(request.body);
    const output = await requireToolService(mcp).execute(
      {
        principal: { kind: "human", id: "demo-owner" },
        agentId: body.agentId,
        runId: "human-tool-test",
        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
      },
      toolId,
      body.input ?? {},
    );
    return { result: output };
  });

  app.get("/api/audit/timeline", async (request) => {
    const audit = requireAuditService(mcp);
    const query = auditQuery.parse(request.query);
    return {
      timeline: audit.queryTimeline?.(query) ?? {
        events: audit.query(query),
        summary: {
          usageAvailability: "unavailable",
          llmCount: 0,
          toolCount: 0,
          authorizationCount: 0,
          errorCount: 0,
        },
      },
    };
  });

  app.get("/api/audit", async (request) => ({
    events: requireAuditService(mcp).query(auditQuery.parse(request.query)),
  }));
}
