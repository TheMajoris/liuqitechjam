import type {
  Agent,
  AgentRun,
  CreateOrchestrationInput,
  ModelProvidersResponse,
  ModelRef,
  Message,
  OrchestrationSession,
  OrchestrationSessionDetail,
  Preview,
  ProviderModelsResponse,
  SystemInfo,
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
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    errorCode?: string;
    details?: unknown;
  };
  if (!response.ok) {
    throw new ApiError(
      data.error ?? "Request failed",
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
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
    modelRef?: ModelRef;
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
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
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
