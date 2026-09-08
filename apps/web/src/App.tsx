import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import { useConfirm } from "./components/ConfirmDialog";
import { OrchestrationWorkspace } from "./components/orchestration/OrchestrationWorkspace";
import { AuthScreen } from "./components/playground/AuthScreen";
import { AppSidebar, type ShellView } from "./components/shell/AppSidebar";
import { InsightsView } from "./components/insights/InsightsView";
import { TraceRunsView } from "./components/trace/TraceRunsView";
import { TraceDetailView } from "./components/trace/TraceDetailView";
import { RolesAndSkillsView } from "./components/access/RolesAndSkillsView";
import { AgentWorkspaceView } from "./components/playground/AgentWorkspaceView";
import { CreateAgentModal } from "./components/playground/CreateAgentModal";
import { TutorialOverlay } from "./components/tutorial/TutorialOverlay";
import { useTutorial } from "./components/tutorial/use-tutorial";
import { useOrchestration } from "./components/orchestration/use-orchestration";
import { emptyAgentForm, formFromAgent, formPayload, type AgentForm } from "./playground/agent-form";
import { useModelCatalog } from "./playground/use-model-catalog";
import { useModelResources } from "./playground/use-model-resources";
import { useSkillCatalog } from "./playground/use-skill-catalog";
import { useAgentWorkspace } from "./playground/use-agent-workspace";
import type {
  Agent,
  AgentRole,
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

/**
 * Refresh the active Workspace list without treating an unavailable API as an
 * empty successful response. State is committed only after the request
 * resolves, so a failed refresh leaves the last known list visible while the
 * existing shell error banner explains what happened.
 */
export async function loadActiveProjects(
  listProjects: () => Promise<{ projects: Project[] }>,
  setProjects: (projects: Project[]) => void,
  setError: (message: string) => void,
): Promise<Project[]> {
  try {
    const { projects: next } = await listProjects();
    // The API is the source of truth and should already omit archived rows;
    // keep this guard so a stale response can never resurrect a deleted one.
    const active = next.filter((project) => project.status === "active");
    setProjects(active);
    return active;
  } catch (reason) {
    setError(errorMessage(reason));
    throw reason;
  }
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const [traceId, setTraceId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  // The Runs the list had in view when one was opened, so the detail page can
  // step to the next in that same order.
  const [runSiblings, setRunSiblings] = useState<readonly string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarPreference);
  // Narrow viewports get the same sidebar as an overlay drawer rather than a
  // squashed rail, so navigation keeps its labels and its Conversation tree.
  const [navOpen, setNavOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerMode, setComposerMode] = useState<"workspace" | "conversation">("workspace");
  const orchestration = useOrchestration();
  const confirm = useConfirm();
  // Only offered once the shell is past auth and actually rendered, so the
  // tour never points at a control that has not mounted.
  const tutorial = useTutorial(authRequired === false);

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

  // Any navigation dismisses the drawer: on a phone the destination should be
  // what fills the screen, not the menu that chose it.
  useEffect(() => {
    setNavOpen(false);
  }, [view, selectedId, orchestration.selectedSessionId, orchestration.selectedWorkspaceId]);

  useEffect(() => {
    if (!navOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [navOpen]);

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
  // Every surface that offers a model choice needs the live snapshot: the
  // pickers annotate each option with its consumption, not just the tables.
  const modelResources = useModelResources(
    authRequired === false &&
      (view === "workspace" ||
        view === "insights" ||
        view === "agent" ||
        showCreate),
  );
  const workspaceController = useAgentWorkspace({
    selectedId,
    refreshAgents,
    setAgents,
    setError,
  });

  const refreshRoles = useCallback(async () => {
    const { roles: next } = await api.listRoles();
    setRoles(next);
  }, []);

  /**
   * Set when the Agent form was opened from the Conversation composer, so the
   * composer can be brought back once there is an Agent to put in it.
   */
  const [resumeComposer, setResumeComposer] = useState<
    "workspace" | "conversation" | null
  >(null);

  const openCreate = useCallback(() => {
    setForm(emptyAgentForm);
    modelCatalog.clearError();
    void refreshRoles().catch((reason) => setError(errorMessage(reason)));
    // Endpoints are created and retired outside this app, so the catalog the
    // form last saw is routinely stale by the time someone opens it. Re-read
    // it here rather than making Refresh a step the person has to know about.
    void modelCatalog.refresh().catch(() => undefined);
    setShowCreate(true);
  }, [modelCatalog.clearError, modelCatalog.refresh, refreshRoles]);

  const newWorkspace = useCallback(() => {
    setView("workspace");
    setComposerMode("workspace");
    setComposerOpen(true);
  }, []);

  const fetchProjects = useCallback(async (): Promise<Project[]> => {
    return loadActiveProjects(api.listProjects, setProjects, setError);
  }, []);

  const refreshProjects = useCallback(async () => {
    await fetchProjects();
  }, [fetchProjects]);

  const applyWorkspaceChange = useCallback(async (
    workspaceId: string,
    operation: "archive" | "delete",
  ) => {
    const wasSelected = orchestration.selectedWorkspaceId === workspaceId;
    setBusy(true);
    setError(null);
    try {
      if (operation === "archive") {
        await api.archiveProject(workspaceId);
      } else {
        await api.deleteProject(workspaceId);
      }
      const next = await fetchProjects();
      if (wasSelected) {
        orchestration.selectWorkspace(next[0]?.id ?? null);
        setView("workspace");
      }
      await orchestration.refreshSessions().catch(() => undefined);
      // Re-assert the workspace selection after the session refresh. An older
      // server may still return archived child sessions, and those must never
      // pull the UI back onto the workspace just removed.
      if (wasSelected) orchestration.selectWorkspace(next[0]?.id ?? null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }, [fetchProjects, orchestration]);

  /** Ask first, then act. The wording says exactly what survives each choice. */
  const changeWorkspace = useCallback((
    workspaceId: string,
    operation: "archive" | "delete",
  ) => {
    const workspace = projects.find((project) => project.id === workspaceId);
    if (!workspace) return;
    confirm(
      operation === "archive"
        ? {
            title: `Archive "${workspace.name}"?`,
            body:
              "It leaves your active Workspaces. Its conversations and shared " +
              "files are kept and stay recoverable.",
            confirmLabel: "Archive Workspace",
            tone: "primary",
            onConfirm: () => void applyWorkspaceChange(workspaceId, "archive"),
          }
        : {
            title: `Permanently delete "${workspace.name}"?`,
            body:
              "Its conversations, memberships, and history are removed from the " +
              "database. The shared files are moved to the recoverable archive. " +
              "This cannot be undone.",
            confirmLabel: "Delete Workspace",
            onConfirm: () => void applyWorkspaceChange(workspaceId, "delete"),
          },
    );
  }, [applyWorkspaceChange, confirm, projects]);

  useEffect(() => {
    if (projects.length === 0) return;
    if (
      orchestration.selectedWorkspaceId === null ||
      !projects.some((project) => project.id === orchestration.selectedWorkspaceId)
    ) {
      orchestration.selectWorkspace(projects[0]!.id);
      setView("workspace");
    }
  }, [orchestration.selectedWorkspaceId, orchestration.selectWorkspace, projects]);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      refreshProjects(),
      refreshRoles(),
      api.system().then(setSystem),
      modelCatalog.refresh(),
      skillCatalog.refresh(),
    ]);
  }, [modelCatalog.refresh, refreshAgents, refreshProjects, refreshRoles, skillCatalog.refresh]);

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
      setShowCreate(false);
      setForm(emptyAgentForm);
      if (resumeComposer) {
        // Came from the composer's empty roster: go back to what they were
        // doing, with the new Agent now available to add.
        setSelectedId(agent.id);
        setComposerMode(resumeComposer);
        setComposerOpen(true);
        setResumeComposer(null);
        setView("workspace");
        return;
      }
      setSelectedId(agent.id);
      setView("agent");
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
      // The role can change here, and the role supplies skills, so the
      // effective skill view has to be re-read rather than left stale.
      await Promise.all([
        refreshAgents(),
        modelResources.refresh(),
        workspaceController.refreshAgentSkills(),
      ]);
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

  const deleteAgent = () => {
    if (!selected) return;
    const agent = selected;
    confirm({
      title: `Delete ${agent.name}?`,
      body:
        "Its private workspace is archived and it leaves every Workspace it " +
        "was in. Past runs are kept so their traces stay readable.",
      confirmLabel: "Delete Agent",
      onConfirm: () => {
        setBusy(true);
        setError(null);
        void api
          .deleteAgent(agent.id)
          .then(refreshAgents)
          .catch((reason) => setError(errorMessage(reason)))
          .finally(() => setBusy(false));
      },
    });
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
    <div
      className={
        "app-shell " +
        (sidebarOpen ? "" : "is-collapsed") +
        (navOpen ? " nav-open" : "")
      }
    >
      <header className="mobile-bar">
        <button
          type="button"
          className="mobile-bar-button"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={() => setNavOpen((value) => !value)}
        >
          <span aria-hidden="true">{navOpen ? "✕" : "☰"}</span>
        </button>
        <span className="mobile-bar-title">LQAM</span>
        <button
          type="button"
          className="mobile-bar-button is-primary"
          aria-label="New workspace"
          onClick={newWorkspace}
        >
          <span aria-hidden="true">＋</span>
        </button>
      </header>

      <button
        type="button"
        className="nav-scrim"
        tabIndex={navOpen ? 0 : -1}
        aria-hidden={!navOpen}
        aria-label="Close navigation"
        onClick={() => setNavOpen(false)}
      />

      <AppSidebar
        collapsed={!sidebarOpen}
        view={view}
        agents={agents}
        projects={projects}
        selectedAgentId={selectedId}
        system={system}
        orchestration={orchestration}
        onToggleCollapsed={() => setSidebarOpen((value) => !value)}
        onNewWorkspace={newWorkspace}
        onNewAgent={openCreate}
        onSelectInsights={() => setView("insights")}
        onSelectTraces={() => {
          setTraceId(null);
          setRunId(null);
          setRunSiblings([]);
          setView("traces");
        }}
        onSelectAccess={() => setView("access")}
        onSelectSession={(sessionId) => {
          orchestration.selectSession(sessionId);
          setView("workspace");
        }}
        onSelectWorkspace={(workspaceId) => {
          orchestration.selectWorkspace(workspaceId);
          setView("workspace");
        }}
        onCreateConversation={() => {
          setView("workspace");
          setComposerMode("conversation");
          setComposerOpen(true);
        }}
        onArchiveWorkspace={(workspaceId) => changeWorkspace(workspaceId, "archive")}
        onDeleteWorkspace={(workspaceId) => changeWorkspace(workspaceId, "delete")}
        onDeleteSession={(sessionId) => {
          void orchestration.deleteSession(sessionId).catch(() => undefined);
        }}
        onSelectAgent={(agentId) => {
          setSelectedId(agentId);
          setView("agent");
        }}
        onReplayTutorial={tutorial.start}
      />

      <main
        className={
          "main " +
          (view === "insights" || view === "traces" || view === "access"
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
                  ? "Configure the server's ModelArk management credentials before running Agents."
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

        {view === "access" ? (
          <RolesAndSkillsView
            agents={agents}
            projects={projects}
            onAgentsChanged={refreshAgents}
          />
        ) : view === "insights" ? (
          <InsightsView
            agents={agents}
            modelResources={modelResources}
            onAgentsChanged={refreshAgents}
            onSelectAgent={(agentId) => {
              setSelectedId(agentId);
              setView("agent");
            }}
            onSelectSession={(sessionId) => {
              orchestration.selectSession(sessionId);
              setView("workspace");
            }}
          />
        ) : view === "traces" ? (
          // One detail implementation serves both entry points: a Run opens by
          // run ID, a multi-Run orchestration trace opens by trace ID.
          runId ? (
            <TraceDetailView
              runId={runId}
              backLabel="Back to runs"
              siblingRunIds={runSiblings}
              onOpenRun={setRunId}
              onBack={() => setRunId(null)}
            />
          ) : traceId ? (
            <TraceDetailView traceId={traceId} onBack={() => setTraceId(null)} />
          ) : (
            <TraceRunsView
              onOpenTrace={setTraceId}
              onOpenRun={(id, siblings) => {
                setRunSiblings(siblings);
                setRunId(id);
              }}
            />
          )
        ) : view === "workspace" ? (
          <OrchestrationWorkspace
            agents={agents}
            modelProviders={modelCatalog.providers}
            modelResources={modelResources.byKey}
            orchestration={orchestration}
            projects={projects}
            roles={roles}
            composerOpen={composerOpen}
            composerMode={composerMode}
            onComposerOpenChange={setComposerOpen}
            onComposerModeChange={setComposerMode}
            onAgentsChanged={async () => {
              await refreshAgents();
              await refreshProjects();
            }}
            onOpenAgent={(agentId) => {
              setSelectedId(agentId);
              setView("agent");
            }}
            onCreateAgent={() => {
              setResumeComposer(composerMode);
              openCreate();
            }}
          />
        ) : selected ? (
          <AgentWorkspaceView
            agent={selected}
            system={system}
            controller={workspaceController}
            modelCatalog={modelCatalog}
            modelResources={modelResources.byKey}
            skillCatalog={skillCatalog.catalog}
            skillLoading={skillCatalog.loading}
            skillError={skillCatalog.error ?? workspaceController.agentSkillsError}
            form={form}
            roles={roles}
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
            <span className="eyebrow">LQAM</span>
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

      <TutorialOverlay tutorial={tutorial} />

      <AnimatePresence>
        {showCreate && (
          <CreateAgentModal
            form={form}
            modelCatalog={modelCatalog}
            modelResources={modelResources.byKey}
            skillCatalog={skillCatalog.catalog}
            skillLoading={skillCatalog.loading}
            skillError={skillCatalog.error}
            roles={roles}
            disabled={busy}
            invalidModel={modelCatalog.modelSelectionInvalid}
            onChange={(changes) => setForm((current) => ({ ...current, ...changes }))}
            onSubmit={createAgent}
            onClose={() => {
              setShowCreate(false);
              setResumeComposer(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
