import type {
  Agent,
  Handoff,
  Message,
  Orchestration,
  OrchestrationPage,
  OrchestrationView,
  Project,
  Provider,
  Run,
  RunObservability,
  RunsPage,
  SecurityPosture,
  SystemInfo,
} from "./contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

type Query = Record<string, string | number | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(options?.headers as Record<string, string> | undefined),
  };
  const response = await fetch(url, { ...options, headers });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      data.error ?? "Request failed",
      response.status,
      data.code,
    );
  }
  return data;
}

export const api = {
  // baseline
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),

  // agents
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  getAgent: (id: string) => request<{ agent: Agent }>(`/api/agents/${id}`),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>(`/api/agents/${id}`, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>(`/api/agents/${id}/start`, { method: "POST" }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>(`/api/agents/${id}/stop`, { method: "POST" }),
  agentMessages: (id: string) =>
    request<{ messages: Message[] }>(`/api/agents/${id}/messages`),
  agentRuns: (id: string) =>
    request<{ runs: Run[] }>(`/api/agents/${id}/runs`),
  sendMessage: (id: string, content: string) =>
    request<{ run: Run; message: Message }>(`/api/agents/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  // projects
  listProjects: () => request<{ projects: Project[] }>("/api/projects"),
  getProject: (id: string) =>
    request<{ project: Project }>(`/api/projects/${id}`),
  createProject: (body: {
    name: string;
    description?: string;
    roles: {
      plannerAgentId: string;
      builderAgentId: string;
      reviewerAgentId: string;
    };
  }) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProject: (
    id: string,
    body: {
      name?: string;
      description?: string;
      roles?: {
        plannerAgentId: string;
        builderAgentId: string;
        reviewerAgentId: string;
      };
    },
  ) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  archiveProject: (id: string) =>
    request<{ project: Project; archivedWorkspace: string }>(
      `/api/projects/${id}/archive`,
      { method: "POST" },
    ),

  // providers
  listProviders: () => request<{ providers: Provider[] }>("/api/providers"),

  // orchestrations
  listOrchestrations: (query?: {
    projectId?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  }) =>
    request<OrchestrationPage>(withQuery("/api/orchestrations", query)),
  createOrchestration: (
    body: { projectId: string; prompt: string; providerId: string },
    idempotencyKey?: string,
  ) =>
    request<
      OrchestrationView & { queuePosition: number | null }
    >("/api/orchestrations", {
      method: "POST",
      body: JSON.stringify(body),
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    }),
  getOrchestration: (id: string) =>
    request<OrchestrationView>(`/api/orchestrations/${id}`),
  cancelOrchestration: (id: string) =>
    request<OrchestrationView>(`/api/orchestrations/${id}/cancellations`, {
      method: "POST",
    }),
  orchestrationMessages: (id: string) =>
    request<{ messages: Handoff[] }>(`/api/orchestrations/${id}/messages`),

  // runs
  listRuns: (query?: {
    agentId?: string;
    projectId?: string;
    orchestrationId?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  }) => request<RunsPage>(withQuery("/api/runs", query)),
  getRun: (id: string) => request<{ run: Run }>(`/api/runs/${id}`),
  runObservability: (id: string) =>
    request<RunObservability>(`/api/runs/${id}/observability`),

  // security
  securityPosture: () => request<SecurityPosture>("/api/security/posture"),
};

export type { Orchestration };
