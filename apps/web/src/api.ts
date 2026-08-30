import type {
  Agent,
  AgentRun,
  CreateOrchestrationInput,
  ModelProvidersResponse,
  ModelRef,
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
  SkillMetadata,
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
  listModelProviders: () =>
    request<ModelProvidersResponse>("/api/model-providers"),
  listProviderModels: (providerId: string) =>
    request<ProviderModelsResponse>(
      "/api/model-providers/" + encodeURIComponent(providerId) + "/models",
    ),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  listTools: () => request<{ tools: import("./types").ToolMetadata[] }>("/api/tools"),
  listSkills: () => request<{ skills: SkillMetadata[] }>("/api/skills"),
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
    skillIds?: string[];
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: {
      name: string;
      description: string;
      instructions: string;
      modelRef?: ModelRef;
      skillIds?: string[];
    },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
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
  createProject: (body: { name: string; description?: string }) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listProjects: () => request<{ projects: Project[] }>("/api/projects"),
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
  startOrchestration: (id: string) =>
    request<{ session: OrchestrationSession }>(
      "/api/orchestrations/" + id + "/start",
      { method: "POST" },
    ),
  stopOrchestration: (id: string) =>
    request<{ session: OrchestrationSession }>(
      "/api/orchestrations/" + id + "/stop",
      { method: "POST" },
    ),
};
