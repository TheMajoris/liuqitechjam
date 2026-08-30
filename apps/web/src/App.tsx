import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import { OrchestrationWorkspace } from "./components/orchestration/OrchestrationWorkspace";
import { AuthScreen } from "./components/playground/AuthScreen";
import { AppSidebar, type ShellView } from "./components/shell/AppSidebar";
import { InsightsView } from "./components/insights/InsightsView";
import { AgentWorkspaceView } from "./components/playground/AgentWorkspaceView";
import { CreateAgentModal } from "./components/playground/CreateAgentModal";
import { useOrchestration } from "./components/orchestration/use-orchestration";
import { emptyAgentForm, formFromAgent, formPayload, type AgentForm } from "./playground/agent-form";
import { useModelCatalog } from "./playground/use-model-catalog";
import { useSkillCatalog } from "./playground/use-skill-catalog";
import { useAgentWorkspace } from "./playground/use-agent-workspace";
import type {
  Agent,
  Project,
  SystemInfo,
} from "./types";

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
  // Default closed: the conversation is the workspace, and the preview is a
  // tool you reach for. The choice is remembered once made.
  return window.localStorage.getItem(PREVIEW_PANEL_KEY) === "open";
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState<AgentForm>(emptyAgentForm);
  const [previewPanelOpen, setPreviewPanelOpen] = useState(readPreviewPanelPreference);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [view, setView] = useState<ShellView>("workspace");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarPreference);
  const [composerOpen, setComposerOpen] = useState(false);
  const orchestration = useOrchestration();

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "open" : "collapsed");
  }, [sidebarOpen]);

  useEffect(() => {
    window.localStorage.setItem(PREVIEW_PANEL_KEY, previewPanelOpen ? "open" : "collapsed");
  }, [previewPanelOpen]);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const skillCatalog = useSkillCatalog();
  const modelCatalog = useModelCatalog(form, selected, setForm);
  const workspaceController = useAgentWorkspace({
    selectedId,
    refreshAgents,
    setAgents,
    setError,
  });

  const openCreate = useCallback(() => {
    setForm(emptyAgentForm);
    modelCatalog.clearError();
    setShowCreate(true);
  }, [modelCatalog.clearError]);

  const newWorkspace = useCallback(() => {
    setView("workspace");
    setComposerOpen(true);
  }, []);

  const refreshProjects = useCallback(async () => {
    const { projects: next } = await api.listProjects().catch(() => ({ projects: [] }));
    setProjects(next);
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      refreshProjects(),
      api.system().then(setSystem),
      modelCatalog.refresh(),
      skillCatalog.refresh(),
    ]);
  }, [modelCatalog.refresh, refreshAgents, refreshProjects, skillCatalog.refresh]);

  useEffect(() => {
    void api
      .auth()
      .then(async ({ required }) => {
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(errorMessage(reason)));
  }, [bootstrap]);

  useEffect(() => {
    setShowSettings(false);
    if (selected) setForm(formFromAgent(selected));
  }, [selected]);

  useEffect(() => {
    const { defaultWorkerModel, providersLoading, loadProviderModels } = modelCatalog;
    if (!showCreate || form.modelRef || providersLoading || !defaultWorkerModel) return;
    setForm((current) =>
      current.modelRef ? current : { ...current, modelRef: defaultWorkerModel },
    );
    void loadProviderModels(defaultWorkerModel.providerId);
  }, [
    form.modelRef,
    modelCatalog.defaultWorkerModel,
    modelCatalog.loadProviderModels,
    modelCatalog.providersLoading,
    showCreate,
  ]);

  useEffect(() => {
    const providerId = selected?.modelRef?.providerId;
    if (providerId) void modelCatalog.loadProviderModels(providerId);
  }, [modelCatalog.loadProviderModels, selected?.id, selected?.modelRef?.providerId]);

  useEffect(() => {
    const providerId = showSettings ? form.modelRef?.providerId : undefined;
    if (providerId) void modelCatalog.loadProviderModels(providerId);
  }, [form.modelRef?.providerId, modelCatalog.loadProviderModels, showSettings]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (modelCatalog.modelSelectionInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(formPayload(form));
      await refreshAgents();
      setSelectedId(agent.id);
      setView("agent");
      setShowCreate(false);
      setForm(emptyAgentForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || modelCatalog.modelSelectionInvalid) return;
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
      <AuthScreen
        required={authRequired}
        error={error}
        busy={busy}
        token={authInput}
        onTokenChange={setAuthInput}
        onUnlock={unlock}
      />
    );
  }

  if (authRequired) {
    return (
      <AuthScreen
        required={authRequired}
        error={error}
        busy={busy}
        token={authInput}
        onTokenChange={setAuthInput}
        onUnlock={unlock}
      />
    );
  }

  return (
    <div className={"app-shell " + (sidebarOpen ? "" : "is-collapsed")}>
      <AppSidebar
        collapsed={!sidebarOpen}
        view={view}
        agents={agents}
        projects={projects}
        selectedAgentId={selectedId}
        conversations={workspaceController.conversations}
        conversationId={workspaceController.conversationId}
        conversationsOpen={conversationsOpen}
        system={system}
        busy={busy}
        runInFlight={workspaceController.runInFlight}
        orchestration={orchestration}
        onToggleCollapsed={() => setSidebarOpen((value) => !value)}
        onNewWorkspace={newWorkspace}
        onNewAgent={openCreate}
        onSelectInsights={() => setView("insights")}
        onSelectSession={(sessionId) => {
          orchestration.selectSession(sessionId);
          setView("workspace");
        }}
        onDeleteSession={(sessionId) => {
          void orchestration.deleteSession(sessionId).catch(() => undefined);
        }}
        onSelectAgent={(agentId) => {
          setSelectedId(agentId);
          setView("agent");
        }}
        onToggleConversations={() => setConversationsOpen((value) => !value)}
        onSelectConversation={(id) => void workspaceController.openConversation(id)}
        onCreateConversation={() => void workspaceController.createConversation()}
        onRenameConversation={(id, title) => void workspaceController.renameConversation(id, title)}
        onDeleteConversation={(id) => void workspaceController.deleteConversation(id)}
      />

      <main
        className={
          "main " +
          (view === "insights"
            ? "main-insights"
            : view === "workspace"
              ? "main-chat"
              : selected
                ? "main-workspace"
                : "")
        }
      >
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner" role="status">
            <span aria-hidden="true">!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before running Agents."
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
            <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        {view === "insights" ? (
          <InsightsView
            onSelectAgent={(agentId) => {
              setSelectedId(agentId);
              setView("agent");
            }}
            onSelectSession={(sessionId) => {
              orchestration.selectSession(sessionId);
              setView("workspace");
            }}
          />
        ) : view === "workspace" ? (
          <OrchestrationWorkspace
            agents={agents}
            modelProviders={modelCatalog.providers}
            orchestration={orchestration}
            composerOpen={composerOpen}
            onComposerOpenChange={setComposerOpen}
            onAgentsChanged={async () => {
              await refreshAgents();
              await refreshProjects();
            }}
            onOpenAgent={(agentId) => {
              setSelectedId(agentId);
              setView("agent");
            }}
          />
        ) : selected ? (
          <AgentWorkspaceView
            agent={selected}
            system={system}
            controller={workspaceController}
            modelCatalog={modelCatalog}
            skillCatalog={skillCatalog.catalog}
            skillLoading={skillCatalog.loading}
            skillError={skillCatalog.error ?? workspaceController.agentSkillsError}
            form={form}
            showSettings={showSettings}
            previewPanelOpen={previewPanelOpen}
            busy={busy}
            onFormChange={(changes) => setForm((current) => ({ ...current, ...changes }))}
            onSave={saveAgent}
            onCloseSettings={() => setShowSettings(false)}
            onToggleSettings={() => setShowSettings((value) => !value)}
            onTogglePreviewPanel={() => setPreviewPanelOpen((value) => !value)}
            onToggleAgent={toggleAgent}
            onDeleteAgent={deleteAgent}
          />
        ) : (
          <div className="no-agent">
            <div className="no-agent-art" aria-hidden="true">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>No Agent selected.</h1>
            <p>Create an Agent, or open a shared workspace to watch a Team work together.</p>
            <div className="no-agent-actions">
              <button type="button" className="button button-primary" onClick={openCreate}>
                Create an Agent
              </button>
              <button type="button" className="button button-ghost" onClick={newWorkspace}>
                New workspace
              </button>
            </div>
          </div>
        )}
      </main>

      {showCreate && (
        <CreateAgentModal
          form={form}
          modelCatalog={modelCatalog}
          skillCatalog={skillCatalog.catalog}
          skillLoading={skillCatalog.loading}
          skillError={skillCatalog.error}
          disabled={busy}
          invalidModel={modelCatalog.modelSelectionInvalid}
          onChange={(changes) => setForm((current) => ({ ...current, ...changes }))}
          onSubmit={createAgent}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
