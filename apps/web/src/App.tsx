import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import { OrchestrationWorkspace } from "./components/orchestration/OrchestrationWorkspace";
import { PreviewSidecar, type PreviewActionError } from "./components/PreviewSidecar";
import { StickyComposer } from "./components/StickyComposer";
import {
  WorkerModelFields,
  formatReasoningEffort,
  formatWorkerModelRef,
  workerProviders,
} from "./components/WorkerModelFields";
import { useOrchestration } from "./components/orchestration/use-orchestration";
import {
  formatDateTime,
  isOrchestrationActive,
  statusLabel,
} from "./components/orchestration/orchestration-utils";
import type {
  Agent,
  AgentRun,
  Message,
  ModelDescriptor,
  ModelProviderDescriptor,
  ModelRef,
  Preview,
  ReasoningEffort,
  SystemInfo,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const SIDEBAR_KEY = "launchpad.sidebar";
const PREVIEW_PANEL_KEY = "launchpad.previewPanel";

function readSidebarPreference(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SIDEBAR_KEY) !== "collapsed";
}

/**
 * Panel visibility is pure layout state. It is remembered per browser so the
 * workspace reopens the way it was left, and it never touches Preview
 * lifecycle: a collapsed panel leaves the server running.
 */
function readPreviewPanelPreference(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PREVIEW_PANEL_KEY) === "open";
}

type AgentForm = {
  name: string;
  description: string;
  instructions: string;
  modelRef?: ModelRef;
};

const emptyForm: AgentForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function toPreviewActionError(reason: unknown): PreviewActionError {
  if (reason instanceof ApiError) {
    return {
      message: reason.message,
      errorCode: reason.errorCode,
    };
  }

  return {
    message: "Unable to complete the preview request. Please try again.",
    errorCode: null,
  };
}

function chooseDefaultEffort(model: ModelDescriptor | undefined): ReasoningEffort | undefined {
  const efforts = model?.capabilities.reasoningEfforts ?? [];
  if (model?.capabilities.reasoning !== true || efforts.length === 0) return undefined;
  return efforts.includes("medium") ? "medium" : efforts[0];
}

function formPayload(form: AgentForm): {
  name: string;
  description: string;
  instructions: string;
  modelRef?: ModelRef;
} {
  return {
    name: form.name,
    description: form.description,
    instructions: form.instructions,
    ...(form.modelRef ? { modelRef: form.modelRef } : {}),
  };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderDescriptor[]>([]);
  const [modelDefaultRef, setModelDefaultRef] = useState<ModelRef | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelDescriptor[]>>({});
  const [modelProvidersLoading, setModelProvidersLoading] = useState(false);
  const [modelLoadingByProvider, setModelLoadingByProvider] = useState<Record<string, boolean>>({});
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLogs, setPreviewLogs] = useState<string[]>([]);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [previewActionError, setPreviewActionError] = useState<PreviewActionError | null>(null);
  const [previewPanelOpen, setPreviewPanelOpen] = useState(readPreviewPanelPreference);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [workspace, setWorkspace] = useState<"playground" | "orchestration">("playground");
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarPreference);
  const [composerOpen, setComposerOpen] = useState(false);
  const orchestration = useOrchestration();
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const modelRequests = useRef(new Set<string>());
  const loadedModelProviders = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  /** A Run is in flight while it is queued or executing; the composer locks. */
  const runInFlight =
    activeRun !== null && ["queued", "running"].includes(activeRun.status);

  const supportedModelProviders = useMemo(
    () => workerProviders(modelProviders),
    [modelProviders],
  );

  const defaultWorkerModel = useMemo<ModelRef | null>(() => {
    const providerIds = new Set(supportedModelProviders.map((provider) => provider.id));
    return modelDefaultRef && providerIds.has(modelDefaultRef.providerId)
      ? modelDefaultRef
      : null;
  }, [modelDefaultRef, supportedModelProviders]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "open" : "collapsed");
  }, [sidebarOpen]);

  useEffect(() => {
    window.localStorage.setItem(PREVIEW_PANEL_KEY, previewPanelOpen ? "open" : "collapsed");
  }, [previewPanelOpen]);

  const openCreate = useCallback(() => {
    setForm(emptyForm);
    setModelCatalogError(null);
    setShowCreate(true);
  }, []);

  const startNew = useCallback(() => {
    if (workspace === "orchestration") {
      setComposerOpen(true);
      return;
    }
    openCreate();
  }, [openCreate, workspace]);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshModelProviders = useCallback(async () => {
    setModelProvidersLoading(true);
    setModelCatalogError(null);
    try {
      const response = await api.listModelProviders();
      setModelProviders(response.providers);
      setModelDefaultRef(response.defaultModelRef);
    } catch (reason) {
      setModelCatalogError(errorMessage(reason));
    } finally {
      setModelProvidersLoading(false);
    }
  }, []);

  const loadProviderModels = useCallback(async (providerId: string, force = false) => {
    const normalizedProviderId = providerId.trim();
    if (
      !normalizedProviderId ||
      modelRequests.current.has(normalizedProviderId) ||
      (!force && loadedModelProviders.current.has(normalizedProviderId))
    ) return;
    modelRequests.current.add(normalizedProviderId);
    setModelLoadingByProvider((current) => ({ ...current, [normalizedProviderId]: true }));
    setModelCatalogError(null);
    try {
      const response = await api.listProviderModels(normalizedProviderId);
      const models = response.models.filter(
        (model) =>
          model.providerId === normalizedProviderId &&
          model.capabilities.scopes.includes("worker"),
      );
      setModelsByProvider((current) => ({ ...current, [normalizedProviderId]: models }));
      loadedModelProviders.current.add(normalizedProviderId);
    } catch (reason) {
      setModelCatalogError(errorMessage(reason));
    } finally {
      modelRequests.current.delete(normalizedProviderId);
      setModelLoadingByProvider((current) => ({ ...current, [normalizedProviderId]: false }));
    }
  }, []);

  const selectedFormModels = form.modelRef?.providerId
    ? modelsByProvider[form.modelRef.providerId] ?? []
    : [];
  const selectedFormModelsLoading = form.modelRef?.providerId
    ? modelLoadingByProvider[form.modelRef.providerId] === true
    : false;
  const selectedAgentModel = selected?.modelRef?.providerId
    ? (modelsByProvider[selected.modelRef.providerId] ?? []).find(
        (model) => model.id === selected.modelRef?.modelId,
      )
    : undefined;
  const selectedAgentReasoning = selected?.modelRef?.reasoning?.effort;
  const selectedAgentReasoningSupported =
    selectedAgentReasoning !== undefined &&
    selectedAgentModel?.capabilities.reasoning === true &&
    selectedAgentModel.capabilities.reasoningEfforts?.includes(selectedAgentReasoning) === true;
  const selectedFormModel = form.modelRef?.modelId
    ? selectedFormModels.find((model) => model.id === form.modelRef?.modelId)
    : undefined;
  const selectedFormReasoning = form.modelRef?.reasoning?.effort;
  const selectedFormEfforts = selectedFormModel?.capabilities.reasoningEfforts ?? [];
  const modelSelectionInvalid = Boolean(
    form.modelRef &&
      (!form.modelRef.providerId ||
        !form.modelRef.modelId ||
        selectedFormModelsLoading ||
        Boolean(modelCatalogError) ||
        !selectedFormModel ||
        (selectedFormModel.capabilities.reasoning &&
          selectedFormEfforts.length > 0 &&
          (!selectedFormReasoning || !selectedFormEfforts.includes(selectedFormReasoning))) ||
        (selectedFormReasoning !== undefined &&
          (!selectedFormModel.capabilities.reasoning ||
            !selectedFormEfforts.includes(selectedFormReasoning)))),
  );

  const changeFormProvider = (providerId: string) => {
    const normalizedProviderId = providerId.trim();
    setModelCatalogError(null);
    if (!normalizedProviderId) {
      setForm((current) => ({ ...current, modelRef: undefined }));
      return;
    }
    setForm((current) => ({
      ...current,
      modelRef: { providerId: normalizedProviderId, modelId: "" },
    }));
    void loadProviderModels(normalizedProviderId);
  };

  const changeFormModel = (modelId: string) => {
    const providerId = form.modelRef?.providerId;
    if (!providerId || !modelId) return;
    setModelCatalogError(null);
    const model = (modelsByProvider[providerId] ?? []).find((candidate) => candidate.id === modelId);
    const effort = chooseDefaultEffort(model);
    setForm((current) => ({
      ...current,
      modelRef: {
        providerId,
        modelId,
        ...(effort ? { reasoning: { effort } } : {}),
      },
    }));
  };

  const changeFormReasoning = (effort: ReasoningEffort | undefined) => {
    setForm((current) => {
      if (!current.modelRef) return current;
      const { reasoning: _reasoning, ...withoutReasoning } = current.modelRef;
      return {
        ...current,
        modelRef: {
          ...withoutReasoning,
          ...(effort ? { reasoning: { effort } } : {}),
        },
      };
    });
  };

  const retryModelCatalog = () => {
    void refreshModelProviders();
    if (form.modelRef?.providerId) {
      void loadProviderModels(form.modelRef.providerId, true);
    }
  };

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshPreview = useCallback(async (
    agentId: string,
    options: { clearActionErrorOnSuccess?: boolean } = {},
  ) => {
    try {
      const result = await api.getPreview(agentId);
      if (mountedRef.current && selectedIdRef.current === agentId) {
        setPreview(result.preview);
        if (options.clearActionErrorOnSuccess) setPreviewActionError(null);
      }
      if (["starting", "running", "failed"].includes(result.preview.status)) {
        try {
          const logs = await api.getPreviewLogs(agentId, 100);
          if (mountedRef.current && selectedIdRef.current === agentId) {
            setPreviewLogs(logs.logs);
          }
        } catch {
          // Logs are supplemental; keep the status panel useful if the
          // runtime exits between status and log requests.
        }
      } else if (mountedRef.current && selectedIdRef.current === agentId) {
        setPreviewLogs([]);
      }
      return result.preview;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) {
        if (mountedRef.current && selectedIdRef.current === agentId) {
          setPreview(null);
          setPreviewLogs([]);
          if (options.clearActionErrorOnSuccess) setPreviewActionError(null);
        }
        return null;
      }
      throw reason;
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      api.system().then(setSystem),
      refreshModelProviders(),
    ]);
  }, [refreshAgents, refreshModelProviders]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setPreview(null);
    setPreviewLogs([]);
    setPreviewActionError(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    void refreshPreview(selectedId, { clearActionErrorOnSuccess: true }).catch((reason) => {
      if (mountedRef.current && selectedIdRef.current === selectedId) {
        setPreviewActionError(toPreviewActionError(reason));
      }
    });
  }, [refreshMessages, refreshPreview, selectedId]);

  useEffect(() => {
    if (!selectedId || !preview || !["starting", "running"].includes(preview.status)) return;
    const interval = window.setInterval(() => {
      void refreshPreview(selectedId, { clearActionErrorOnSuccess: true }).catch((reason) => {
        if (mountedRef.current && selectedIdRef.current === selectedId) {
          setPreviewActionError(toPreviewActionError(reason));
        }
      });
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [preview?.status, refreshPreview, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
        ...(selected.modelRef ? { modelRef: selected.modelRef } : {}),
      });
    }
  }, [selected]);

  useEffect(() => {
    if (!showCreate || form.modelRef || modelProvidersLoading || !defaultWorkerModel) return;
    setForm((current) =>
      current.modelRef ? current : { ...current, modelRef: defaultWorkerModel },
    );
    void loadProviderModels(defaultWorkerModel.providerId);
  }, [
    defaultWorkerModel,
    form.modelRef,
    loadProviderModels,
    modelProvidersLoading,
    showCreate,
  ]);

  useEffect(() => {
    const providerId = selected?.modelRef?.providerId;
    if (providerId) void loadProviderModels(providerId);
  }, [loadProviderModels, selected?.id, selected?.modelRef?.providerId]);

  useEffect(() => {
    const providerId = showSettings ? form.modelRef?.providerId : undefined;
    if (providerId) void loadProviderModels(providerId);
  }, [form.modelRef?.providerId, loadProviderModels, showSettings]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (modelSelectionInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(formPayload(form));
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || modelSelectionInvalid) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, formPayload(form));
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const runPreviewAction = async (action: "start" | "restart" | "stop") => {
    if (!selected) return;
    setPreviewBusy(action);
    setPreviewActionError(null);
    try {
      const result = action === "start"
        ? await api.startPreview(selected.id)
        : action === "restart"
          ? await api.restartPreview(selected.id)
          : await api.stopPreview(selected.id);
      if (selectedIdRef.current === selected.id) {
        setPreview(result.preview);
        if (result.preview.status === "running") {
          const logs = await api.getPreviewLogs(selected.id, 100).catch(() => null);
          if (logs) setPreviewLogs(logs.logs);
        } else {
          setPreviewLogs([]);
        }
      }
      if (mountedRef.current && selectedIdRef.current === selected.id) {
        setPreviewActionError(null);
      }
    } catch (reason) {
      if (mountedRef.current && selectedIdRef.current === selected.id) {
        setPreviewActionError(toPreviewActionError(reason));
      }
      await refreshPreview(selected.id).catch(() => undefined);
    } finally {
      setPreviewBusy(null);
    }
  };

  const openPreview = () => {
    if (!preview?.url) return;
    window.open(preview.url, "_blank", "noopener,noreferrer");
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className={"app-shell " + (sidebarOpen ? "" : "is-collapsed")}>
      {sidebarOpen && (
        <aside className="sidebar" id="app-sidebar">
          <div className="sidebar-top">
            <div className="brand">
              <div className="brand-mark">A</div>
              <div>
                <strong>Agent Launchpad</strong>
                <span>
                  {system?.runtimeProvider === "container"
                    ? "Local container · Codex CLI"
                    : "ECS / Docker · Codex CLI"}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="rail-button"
              aria-label="Hide sidebar"
              aria-expanded
              aria-controls="app-sidebar"
              onClick={() => setSidebarOpen(false)}
            >
              <span aria-hidden="true">⟨</span>
            </button>
          </div>

          <button className="button button-primary create-button" onClick={startNew}>
            <span aria-hidden="true">＋</span>
            {workspace === "orchestration" ? "New conversation" : "Create Agent"}
          </button>

          <nav className="sidebar-nav" aria-label="Workspace">
            <button
              type="button"
              className={workspace === "playground" ? "is-active" : ""}
              aria-current={workspace === "playground" ? "page" : undefined}
              onClick={() => setWorkspace("playground")}
            >
              <span aria-hidden="true">◑</span> Playground
            </button>
            <button
              type="button"
              className={workspace === "orchestration" ? "is-active" : ""}
              aria-current={workspace === "orchestration" ? "page" : undefined}
              onClick={() => setWorkspace("orchestration")}
            >
              <span aria-hidden="true">◎</span> Team
            </button>
          </nav>

          <div className="sidebar-scroll">
            {workspace === "orchestration" && (
              <>
                <div className="sidebar-label">
                  <span>Conversations</span>
                  <span>{orchestration.sessions.length}</span>
                </div>
                <nav className="thread-list" aria-label="Conversations">
                  {orchestration.sessions.map((session) => (
                    <div className="thread-card-row" key={session.id}>
                      <button
                        className={
                          "thread-card " +
                          (session.id === orchestration.selectedSessionId ? "selected" : "")
                        }
                        aria-current={
                          session.id === orchestration.selectedSessionId ? "true" : undefined
                        }
                        onClick={() => orchestration.selectSession(session.id)}
                      >
                        <span className="thread-card-copy">
                          <strong>{session.name}</strong>
                          <span>{formatDateTime(session.updatedAt)}</span>
                        </span>
                        <span className={"thread-state thread-state-" + session.status}>
                          {statusLabel(session.status)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="thread-delete"
                        aria-label={`Delete ${session.name}`}
                        title={isOrchestrationActive(session.status) ? "Stop before deleting" : "Delete conversation"}
                        disabled={isOrchestrationActive(session.status) || orchestration.action !== null}
                        onClick={() => {
                          if (window.confirm(`Delete "${session.name}" and its Team chat history?`)) {
                            void orchestration.deleteSession(session.id).catch(() => undefined);
                          }
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {orchestration.sessions.length === 0 && (
                    <div className="empty-sidebar">
                      <span aria-hidden="true">◇</span>
                      {orchestration.loading
                        ? "Loading conversations…"
                        : "Start your first multi-Agent conversation."}
                    </div>
                  )}
                </nav>
              </>
            )}

            <div className="sidebar-label">
              <span>Your Agents</span>
              <span>{agents.length}</span>
            </div>
            <nav className="agent-list" aria-label="Agents">
              {agents.map((agent) => (
                <button
                  className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
                  key={agent.id}
                  aria-current={
                    workspace === "playground" && agent.id === selectedId ? "true" : undefined
                  }
                  onClick={() => {
                    setSelectedId(agent.id);
                    setWorkspace("playground");
                  }}
                >
                  <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
                  <div className="agent-card-copy">
                    <strong>{agent.name}</strong>
                    <span>{agent.description || "Coding Agent"}</span>
                  </div>
                  <span className={"mini-dot mini-" + agent.status} />
                </button>
              ))}
              {agents.length === 0 && (
                <div className="empty-sidebar">
                  <span aria-hidden="true">◇</span>
                  Create your first coding Agent.
                </div>
              )}
            </nav>
          </div>

          <div className="runtime-card">
            <span className="eyebrow">Runtime</span>
            <strong>{system?.runtime ?? "Checking…"}</strong>
            <span>
              {system?.arkModel ?? "Ark model not configured"}
              {system?.containerEngine ? " · " + system.containerEngine : ""}
            </span>
          </div>
        </aside>
      )}

      <main
        className={
          "main " +
          (workspace === "orchestration"
            ? "main-chat"
            : selected
              ? "main-workspace"
              : "")
        }
      >
        {!sidebarOpen && (
          <button
            type="button"
            className="rail-button sidebar-reveal"
            aria-label="Show sidebar"
            aria-expanded={false}
            aria-controls="app-sidebar"
            onClick={() => setSidebarOpen(true)}
          >
            <span aria-hidden="true">⟩</span>
          </button>
        )}

        {workspace === "orchestration" ? (
          <OrchestrationWorkspace
            agents={agents}
            modelProviders={modelProviders}
            orchestration={orchestration}
            composerOpen={composerOpen}
            onComposerOpenChange={setComposerOpen}
          />
        ) : (
          <>
            {!system?.arkConfigured || !system?.codexAvailable ? (
              <div className="config-banner">
                <span>!</span>
                <div>
                  <strong>Runtime configuration needed</strong>
                  <p>
                    {!system?.arkConfigured
                      ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                      : system.runtimeProvider === "container"
                        ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                        : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
                  </p>
                </div>
              </div>
            ) : null}

            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button onClick={() => setError(null)}>×</button>
              </div>
            )}

            {selected ? (
          <div className="agent-workspace">
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
                <div className="agent-header-model">
                  <span className="eyebrow">Worker model</span>
                  <strong>
                    {formatWorkerModelRef(
                      selected.modelRef,
                      modelProviders,
                      selected.modelRef?.providerId
                        ? modelsByProvider[selected.modelRef.providerId] ?? []
                        : [],
                    )}
                  </strong>
                  {selectedAgentReasoningSupported && (
                    <span>
                      Reasoning: {formatReasoningEffort(selectedAgentReasoning)}
                    </span>
                  )}
                </div>
              </div>
              <div className="header-actions">
                <button
                  type="button"
                  className={"button button-ghost preview-toggle " + (previewPanelOpen ? "is-active" : "")}
                  onClick={() => setPreviewPanelOpen((value) => !value)}
                  aria-pressed={previewPanelOpen}
                >
                  <span
                    className={"preview-toggle-dot preview-dot-" + (preview?.status ?? "not_started")}
                    aria-hidden="true"
                  />
                  Preview
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <WorkerModelFields
                  providers={modelProviders}
                  models={selectedFormModels}
                  value={form.modelRef}
                  loadingProviders={modelProvidersLoading}
                  loadingModels={selectedFormModelsLoading}
                  catalogError={modelCatalogError}
                  disabled={busy}
                  onProviderChange={changeFormProvider}
                  onModelChange={changeFormModel}
                  onReasoningChange={changeFormReasoning}
                  onRetry={retryModelCatalog}
                />
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button
                    className="button button-primary"
                    disabled={busy || modelSelectionInvalid}
                  >
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <div className="workspace-body">
              <section className="conversation-pane" aria-label="Conversation">
                <div className="playground-topbar">
                  <div>
                    <span className="eyebrow">Playground</span>
                    <h2>Build something with your Agent</h2>
                  </div>
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>

                <div className="messages">
                  {messages.length === 0 && !activeRun ? (
                    <div className="welcome">
                      <div className="welcome-orbit">
                        <div>⌁</div>
                      </div>
                      <h3>What should {selected.name} build?</h3>
                      <p>
                        The Agent can inspect files, write code, run commands, and continue the
                        same Codex session across messages.
                      </p>
                      <div className="prompt-grid">
                        {starterPrompts.map((item) => (
                          <button key={item} onClick={() => setPrompt(item)}>
                            <span>↗</span>
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <article className={"message message-" + message.role} key={message.id}>
                        <div className="message-meta">
                          <strong>{message.role === "user" ? "You" : selected.name}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <div className="message-body">{message.content}</div>
                      </article>
                    ))
                  )}
                  {activeRun && ["queued", "running"].includes(activeRun.status) && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta">
                        <strong>{selected.name}</strong>
                        <span>working in the Agent workspace</span>
                      </div>
                      <div className="thinking-row">
                        <Spinner />
                        Codex is reading, editing, or running commands…
                      </div>
                    </article>
                  )}
                  {activeRun?.status === "failed" && (
                    <article className="run-error">
                      <strong>Run failed</strong>
                      <span>{activeRun.error}</span>
                    </article>
                  )}
                  <div ref={messageEnd} />
                </div>

                <StickyComposer
                  value={prompt}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  hint={
                    "Enter to send · Shift + Enter for newline · " +
                    (system?.codexSandboxMode ?? "checking sandbox")
                  }
                  disabled={selected.status === "stopped" || selected.status === "busy"}
                  sending={runInFlight}
                  onChange={setPrompt}
                  onSubmit={sendMessage}
                />
              </section>

              <PreviewSidecar
                open={previewPanelOpen}
                preview={preview}
                logs={previewLogs}
                busy={previewBusy}
                actionError={previewActionError}
                onClose={() => setPreviewPanelOpen(false)}
                onStart={() => void runPreviewAction("start")}
                onRestart={() => void runPreviewAction("restart")}
                onStop={() => void runPreviewAction("stop")}
                onOpenExternal={openPreview}
              />

              {!previewPanelOpen && (
                <button
                  type="button"
                  className="preview-rail"
                  onClick={() => setPreviewPanelOpen(true)}
                  aria-label="Show preview panel"
                  aria-expanded={false}
                >
                  <span
                    className={"preview-toggle-dot preview-dot-" + (preview?.status ?? "not_started")}
                    aria-hidden="true"
                  />
                  <span className="preview-rail-label">Preview</span>
                </button>
              )}
            </div>
          </div>
            ) : (
              <div className="no-agent">
                <div className="no-agent-art">A</div>
                <span className="eyebrow">Agent Launchpad</span>
                <h1>Your runtime is ready for an Agent.</h1>
                <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
                <button
                  className="button button-primary"
                  onClick={openCreate}
                >
                  Create your first Agent
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <WorkerModelFields
              providers={modelProviders}
              models={selectedFormModels}
              value={form.modelRef}
              loadingProviders={modelProvidersLoading}
              loadingModels={selectedFormModelsLoading}
              catalogError={modelCatalogError}
              disabled={busy}
              isNew
              onProviderChange={changeFormProvider}
              onModelChange={changeFormModel}
              onReasoningChange={changeFormReasoning}
              onRetry={retryModelCatalog}
            />
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || modelSelectionInvalid}
              >
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
