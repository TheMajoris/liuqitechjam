import type {
  Agent,
  AgentRun,
  CreateOrchestrationInput,
  ModelProvidersResponse,
  ModelCatalogResponse,
  ModelCatalogUpdate,
  ModelRef,
  ModelScope,
  Message,
  OrchestrationSession,
  OrchestrationSessionDetail,
  AgentConversation,
  Preview,
  Project,
  ProjectRole,
  ProviderModelsResponse,
  SystemInfo,
  AgentCapabilities,
  CapabilityGrantView,
  AgentSkills,
  ApprovalRecord,
  ApprovalStatus,
  SkillMetadata,
  SkillCatalogEntry,
  SkillDiscoveryResult,
  AgentRole,
  AgentMetrics,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode: string | null = null,
    public readonly details: unknown = undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = ((await response.json().catch(() => ({}))) ?? {}) as T & {
    message?: string;
    error?: string;
    errorCode?: string;
    details?: unknown;
  };
  if (!response.ok) {
    const message = [data.message, data.error, response.statusText, "Request failed"].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
    ) as string;
    throw new ApiError(
      message,
      response.status,
      data.errorCode ?? null,
      data.details,
    );
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  usage: (query: { since?: string; days?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.since) params.set("since", query.since);
    if (query.days !== undefined) params.set("days", String(query.days));
    const suffix = params.toString();
    return request<{ usage: import("./types").UsageReport }>(
      "/api/usage" + (suffix ? "?" + suffix : ""),
    );
  },
  listModelProviders: (scope: ModelScope = "worker") =>
    request<ModelProvidersResponse>("/api/model-providers?scope=" + encodeURIComponent(scope)),
  listProviderModels: (providerId: string, scope: ModelScope = "worker") =>
    request<ProviderModelsResponse>(
      "/api/model-providers/" + encodeURIComponent(providerId) + "/models?scope=" + encodeURIComponent(scope),
    ),
  /**
   * Operator-only catalog projection/update. The current runtime exposes the
   * provider listings above; these endpoints are intentionally kept behind a
   * narrow client seam so the settings view can use the atomic control-plane
   * contract when enabled.
   */
  getModelCatalog: () => request<ModelCatalogResponse>("/api/model-catalog"),
  updateModelCatalog: (body: ModelCatalogUpdate) =>
    request<ModelCatalogResponse>("/api/model-catalog", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  projectActivity: (projectId: string, limit = 200) =>
    request<{ events: import("./types").AuditEventRecord[] }>(
      "/api/projects/" + encodeURIComponent(projectId) + "/activity?limit=" + limit,
    ),
  runActivity: (runId: string, limit = 100) =>
    request<{ events: import("./types").AuditEventRecord[] }>(
      "/api/runs/" + encodeURIComponent(runId) + "/activity?limit=" + limit,
    ),
  listTools: () => request<{ tools: import("./types").ToolMetadata[] }>("/api/tools"),
  agentMetrics: (agentId: string) =>
    request<AgentMetrics>("/api/agents/" + encodeURIComponent(agentId) + "/metrics"),
  projectAgentMetrics: (projectId: string) =>
    request<{ agents: AgentMetrics[] }>(
      "/api/projects/" + encodeURIComponent(projectId) + "/agent-metrics",
    ),
  listSkills: () => request<{ skills: SkillMetadata[] }>("/api/skills"),
  searchSkills: (query = "", installed?: boolean) => {
    const params = new URLSearchParams({ q: query });
    if (installed !== undefined) params.set("installed", String(installed));
    return request<{ query: string; skills: SkillCatalogEntry[] }>(
      "/api/skills/search?" + params.toString(),
    );
  },
  installSkill: (skillId: string) =>
    request<{ skill: SkillMetadata }>("/api/skills/install", {
      method: "POST",
      body: JSON.stringify({ skillId }),
    }),
  importSkillFromMarkdown: (markdown: string, fileName: string) =>
    request<{ skill: SkillMetadata }>("/api/skills/import", {
      method: "POST",
      body: JSON.stringify({ markdown, fileName }),
    }),
  importSkillFromUrl: (url: string) =>
    request<{ skill: SkillMetadata }>("/api/skills/import", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  discoverSkills: (query: string) =>
    request<{ query: string; results: SkillDiscoveryResult[] }>(
      "/api/skills/discover?q=" + encodeURIComponent(query),
    ),
  uninstallSkill: (skillId: string) =>
    request<{ removed: true }>("/api/skills/" + encodeURIComponent(skillId) + "/install", {
      method: "DELETE",
    }),
  listRoles: () => request<{ roles: AgentRole[] }>("/api/roles"),
  createRole: (body: {
    name: string;
    description?: string;
    skillIds: string[];
    toolIds: string[];
    permissionIds: string[];
  }) => request<{ role: AgentRole }>("/api/roles", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateRole: (id: string, body: Partial<Pick<AgentRole, "name" | "description" | "skillIds" | "toolIds" | "permissionIds">> & { confirmPropagation?: boolean }) =>
    request<{ role: AgentRole }>("/api/roles/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteRole: (id: string) =>
    request<{ removed: true }>("/api/roles/" + encodeURIComponent(id), { method: "DELETE" }),
  assignProjectRole: (projectId: string, agentId: string, roleId: string) =>
    request<{ assignment: { projectId: string; agentId: string; roleId: string; role: AgentRole } }>(
      "/api/projects/" + encodeURIComponent(projectId) + "/agents/" + encodeURIComponent(agentId) + "/role",
      { method: "PUT", body: JSON.stringify({ roleId }) },
    ),
  getSkill: (id: string) =>
    request<{ skill: SkillMetadata }>("/api/skills/" + encodeURIComponent(id)),
  agentSkills: (id: string, projectId?: string) =>
    request<{ skills: AgentSkills }>(
      "/api/agents/" + id + "/skills" +
        (projectId ? "?projectId=" + encodeURIComponent(projectId) : ""),
    ),
  updateAgentSkills: (id: string, skillIds: string[]) =>
    request<{ agent: Agent; skills: AgentSkills }>("/api/agents/" + id + "/skills", {
      method: "PATCH",
      body: JSON.stringify({ skillIds }),
    }),
  agentCapabilities: (id: string, projectId?: string) =>
    request<{ capabilities: AgentCapabilities }>(
      "/api/agents/" + id + "/capabilities" +
        (projectId ? "?projectId=" + encodeURIComponent(projectId) : ""),
    ),
  capabilityGrants: (id: string, projectId?: string) =>
    request<{ grants: CapabilityGrantView[] }>(
      "/api/agents/" + id + "/capabilities/grants" +
        (projectId ? "?projectId=" + encodeURIComponent(projectId) : ""),
    ),
  createCapabilityGrant: (
    id: string,
    body: { projectId: string; toolId: string; scope: "once" | "project" },
  ) =>
    request<{ grant: CapabilityGrantView }>("/api/agents/" + id + "/capabilities/grants", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeCapabilityGrant: (id: string) =>
    request<{ grant: CapabilityGrantView }>("/api/capability-grants/" + id, {
      method: "DELETE",
    }),
  testTool: (toolId: string, body: { agentId: string; projectId?: string; input?: unknown }) =>
    request<{ result: unknown }>("/api/tools/" + encodeURIComponent(toolId) + "/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
    modelRef?: ModelRef;
    fallbackModelRefs?: ModelRef[];
    skillIds?: string[];
    globalRoleId?: string | null;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: {
      name?: string;
      description?: string;
      instructions?: string;
      modelRef?: ModelRef;
      fallbackModelRefs?: ModelRef[];
      skillIds?: string[];
      globalRoleId?: string | null;
    },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Cosmetic-only; never touches the runtime prompt or the access directory. */
  updateAgentAppearance: (
    id: string,
    appearance: import("./types").AgentAppearance,
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/appearance", {
      method: "PATCH",
      body: JSON.stringify(appearance),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string | null }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  getPreview: (id: string) =>
    request<{ preview: Preview }>("/api/agents/" + id + "/preview"),
  startPreview: (id: string) =>
    request<{ preview: Preview }>("/api/agents/" + id + "/preview/start", {
      method: "POST",
    }),
  restartPreview: (id: string) =>
    request<{ preview: Preview }>("/api/agents/" + id + "/preview/restart", {
      method: "POST",
    }),
  stopPreview: (id: string) =>
    request<{ preview: Preview }>("/api/agents/" + id + "/preview/stop", {
      method: "POST",
    }),
  getPreviewLogs: (id: string, tail = 100) =>
    request<{ preview: Preview; logs: string[]; truncated: boolean }>(
      "/api/agents/" + id + "/preview/logs?tail=" + encodeURIComponent(String(tail)),
    ),
  /**
   * Approvals are Permit-backed. The server answers 503 when approvals are not
   * configured, which callers treat as "feature dormant", never as "allowed".
   */
  listApprovals: (query: {
    agentId?: string;
    projectId?: string;
    status?: ApprovalStatus;
    kind?: "operation_approval" | "access_request";
  } = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string" && value.length > 0) search.set(key, value);
    }
    const suffix = search.size > 0 ? "?" + search.toString() : "";
    return request<{ approvals: ApprovalRecord[] }>("/api/approvals" + suffix);
  },
  approveApproval: (id: string, scope: "once" | "project" = "once") =>
    request<{ approval: ApprovalRecord }>(
      "/api/approvals/" + encodeURIComponent(id) + "/approve",
      { method: "POST", body: JSON.stringify({ scope }) },
    ),
  denyApproval: (id: string) =>
    request<{ approval: ApprovalRecord }>(
      "/api/approvals/" + encodeURIComponent(id) + "/deny",
      { method: "POST" },
    ),
  createProject: (body: { name: string; description?: string }) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listProjects: () => request<{ projects: Project[] }>("/api/projects"),
  /** Archive preserves the Project workspace; it never deletes the files. */
  archiveProject: (id: string) =>
    request<{ archivedWorkspace: string | null }>("/api/projects/" + id, {
      method: "DELETE",
    }),
  /** Permanently removes the Project record and child database records. */
  deleteProject: (id: string) =>
    request<{ deleted: boolean }>(
      "/api/projects/" + encodeURIComponent(id) + "/permanent",
      { method: "DELETE" },
    ),
  attachProjectAgent: (projectId: string, agentId: string) =>
    request<{ project: Project }>(
      "/api/projects/" + encodeURIComponent(projectId) + "/agents/" + encodeURIComponent(agentId),
      { method: "POST" },
    ),
  detachProjectAgent: (projectId: string, agentId: string) =>
    request<{ project: Project }>(
      "/api/projects/" + encodeURIComponent(projectId) + "/agents/" + encodeURIComponent(agentId),
      { method: "DELETE" },
    ),
  getProject: (id: string) => request<{ project: Project }>("/api/projects/" + id),
  updateProjectAgentRole: (projectId: string, agentId: string, role: ProjectRole) =>
    request<{ project: Project }>(
      "/api/projects/" + projectId + "/agents/" + agentId,
      { method: "PATCH", body: JSON.stringify({ role }) },
    ),
  getProjectPreview: (id: string) =>
    request<{ preview: Preview }>("/api/projects/" + id + "/preview"),
  startProjectPreview: (id: string) =>
    request<{ preview: Preview }>("/api/projects/" + id + "/preview/start", {
      method: "POST",
    }),
  restartProjectPreview: (id: string) =>
    request<{ preview: Preview }>("/api/projects/" + id + "/preview/restart", {
      method: "POST",
    }),
  stopProjectPreview: (id: string) =>
    request<{ preview: Preview }>("/api/projects/" + id + "/preview/stop", {
      method: "POST",
    }),
  getProjectPreviewLogs: (id: string, tail = 100) =>
    request<{ preview: Preview; logs: string[]; truncated: boolean }>(
      "/api/projects/" + id + "/preview/logs?tail=" + encodeURIComponent(String(tail)),
    ),
  conversations: (id: string) =>
    request<{ conversations: AgentConversation[] }>(
      "/api/agents/" + id + "/conversations",
    ),
  createConversation: (id: string) =>
    request<{ conversation: AgentConversation }>("/api/agents/" + id + "/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  renameConversation: (id: string, conversationId: string, title: string) =>
    request<{ conversation: AgentConversation }>(
      "/api/agents/" + id + "/conversations/" + conversationId,
      { method: "PATCH", body: JSON.stringify({ title }) },
    ),
  deleteConversation: (id: string, conversationId: string) =>
    request<{ deleted: boolean }>(
      "/api/agents/" + id + "/conversations/" + conversationId,
      { method: "DELETE" },
    ),
  messages: (id: string, conversationId?: string) =>
    request<{ messages: Message[] }>(
      "/api/agents/" + id + "/messages" +
        (conversationId ? "?conversationId=" + encodeURIComponent(conversationId) : ""),
    ),
  runs: (id: string, conversationId?: string) =>
    request<{ runs: AgentRun[] }>(
      "/api/agents/" + id + "/runs" +
        (conversationId ? "?conversationId=" + encodeURIComponent(conversationId) : ""),
    ),
  sendMessage: (id: string, content: string, conversationId?: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify(
          conversationId === undefined ? { content } : { content, conversationId },
        ),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  listOrchestrations: () =>
    request<{ sessions: OrchestrationSession[] }>("/api/orchestrations"),
  createOrchestration: (body: CreateOrchestrationInput) =>
    request<{ session: OrchestrationSession }>("/api/orchestrations", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  continueOrchestration: (id: string, body: { prompt: string }) =>
    request<{ session: OrchestrationSession }>(
      "/api/orchestrations/" + id + "/continue",
      { method: "POST", body: JSON.stringify(body) },
    ),
  deleteOrchestration: (id: string) =>
    request<{ deleted: boolean }>("/api/orchestrations/" + id, {
      method: "DELETE",
    }),
  getOrchestration: (id: string) =>
    request<OrchestrationSessionDetail>("/api/orchestrations/" + id),
  startOrchestration: (id: string, prompt?: string) =>
    request<{ session: OrchestrationSession }>(
      "/api/orchestrations/" + id + "/start",
      prompt === undefined
        ? { method: "POST" }
        : { method: "POST", body: JSON.stringify({ prompt }) },
    ),
  stopOrchestration: (id: string) =>
    request<{ session: OrchestrationSession }>(
      "/api/orchestrations/" + id + "/stop",
      { method: "POST" },
    ),
};
