import { useEffect, useRef, useState } from "react";
import type {
  Agent,
  Project,
  SystemInfo,
} from "../../types";
import { AgentAvatar } from "../orchestration/AgentAvatar";
import {
  formatDateTime,
  isOrchestrationActive,
  statusLabel,
} from "../orchestration/orchestration-utils";
import type { UseOrchestrationResult } from "../orchestration/use-orchestration";

/** What the main pane is showing. The sidebar selection decides it. */
export type ShellView = "workspace" | "agent" | "insights" | "access";

interface AppSidebarProps {
  collapsed: boolean;
  view: ShellView;
  agents: Agent[];
  projects: Project[];
  selectedAgentId: string | null;
  system: SystemInfo | null;
  orchestration: UseOrchestrationResult;
  onToggleCollapsed: () => void;
  onNewWorkspace: () => void;
  onNewAgent: () => void;
  onSelectInsights: () => void;
  onSelectAccess: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onCreateConversation: () => void;
}

function agentStatusLabel(status: Agent["status"]): string {
  if (status === "ready") return "Ready";
  if (status === "busy") return "Working";
  if (status === "stopped") return "Stopped";
  return "Error";
}

/**
 * Product navigation.
 *
 * Workspaces are the navigation parents. Their child rows are Conversations,
 * so opening another task never creates a second copy of the shared artifact.
 * Agents remain a separate collection because they are reusable members.
 */
export function AppSidebar({
  collapsed,
  view,
  agents,
  projects,
  selectedAgentId,
  system,
  orchestration,
  onToggleCollapsed,
  onNewWorkspace,
  onNewAgent,
  onSelectInsights,
  onSelectAccess,
  onSelectSession,
  onSelectWorkspace,
  onArchiveWorkspace,
  onDeleteWorkspace,
  onDeleteSession,
  onSelectAgent,
  onCreateConversation,
}: AppSidebarProps) {
  const activeProjects = projects.filter((project) => project.status === "active");
  const [openWorkspaceMenuId, setOpenWorkspaceMenuId] = useState<string | null>(null);
  const workspaceMenuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const workspaceMenuRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const runtimeLabel =
    system?.runtimeProvider === "container" ? "Local container" : "Local process";

  useEffect(() => {
    if (openWorkspaceMenuId === null) return;
    const menu = workspaceMenuRefs.current[openWorkspaceMenuId];
    const trigger = workspaceMenuButtonRefs.current[openWorkspaceMenuId];
    const firstItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus();

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (menu?.contains(target) || trigger?.contains(target))
      ) return;
      setOpenWorkspaceMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      workspaceMenuButtonRefs.current[openWorkspaceMenuId]?.focus();
      setOpenWorkspaceMenuId(null);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openWorkspaceMenuId]);

  const closeWorkspaceMenu = (workspaceId: string) => {
    workspaceMenuButtonRefs.current[workspaceId]?.focus();
    setOpenWorkspaceMenuId(null);
  };

  if (collapsed) {
    return (
      <aside className="sidebar is-rail" id="app-sidebar" aria-label="Navigation">
        <button
          type="button"
          className="rail-item rail-brand"
          aria-label="Expand sidebar"
          aria-expanded={false}
          aria-controls="app-sidebar"
          onClick={onToggleCollapsed}
        >
          <span className="brand-mark" aria-hidden="true">A</span>
          <span className="rail-tip" aria-hidden="true">Expand sidebar</span>
        </button>

        <button
          type="button"
          className="rail-item rail-primary"
          aria-label="New workspace"
          onClick={onNewWorkspace}
        >
          <span aria-hidden="true">＋</span>
          <span className="rail-tip" aria-hidden="true">New workspace</span>
        </button>

        <div className="rail-divider" role="presentation" />

        <nav className="rail-list" aria-label="Agents">
          {agents.slice(0, 9).map((agent) => (
            <button
              key={agent.id}
              type="button"
              className={
                "rail-item rail-agent" +
                (view === "agent" && agent.id === selectedAgentId ? " is-active" : "")
              }
              aria-label={`${agent.name} — ${agentStatusLabel(agent.status)}`}
              aria-current={view === "agent" && agent.id === selectedAgentId ? "page" : undefined}
              onClick={() => onSelectAgent(agent.id)}
            >
              <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
              <span className={"rail-dot mini-" + agent.status} aria-hidden="true" />
              <span className="rail-tip" aria-hidden="true">
                {agent.name} · {agentStatusLabel(agent.status)}
              </span>
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <button
            type="button"
            className={"rail-item" + (view === "access" ? " is-active" : "")}
            aria-label="Roles and skills"
            aria-current={view === "access" ? "page" : undefined}
            onClick={onSelectAccess}
          >
            <span aria-hidden="true">⚙</span>
            <span className="rail-tip" aria-hidden="true">Roles &amp; skills</span>
          </button>
          <button
            type="button"
            className={"rail-item" + (view === "insights" ? " is-active" : "")}
            aria-label="Insights"
            aria-current={view === "insights" ? "page" : undefined}
            onClick={onSelectInsights}
          >
            <span aria-hidden="true">◔</span>
            <span className="rail-tip" aria-hidden="true">Insights</span>
          </button>
          <button
            type="button"
            className={"rail-item" + (view === "workspace" ? " is-active" : "")}
            aria-label={`Workspaces (${activeProjects.length})`}
            onClick={onToggleCollapsed}
          >
            <span aria-hidden="true">◍</span>
            <span className="rail-tip" aria-hidden="true">
              Workspaces · {activeProjects.length}
            </span>
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar" id="app-sidebar" aria-label="Navigation">
      <div className="sidebar-top">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">A</div>
          <div className="brand-copy">
            <strong>Agent Launchpad</strong>
            <span>{runtimeLabel} · Codex</span>
          </div>
        </div>
        <button
          type="button"
          className="rail-button"
          aria-label="Collapse sidebar"
          aria-expanded
          aria-controls="app-sidebar"
          onClick={onToggleCollapsed}
        >
          <span aria-hidden="true">⟨</span>
        </button>
      </div>

      <button type="button" className="button button-primary create-button" onClick={onNewWorkspace}>
        <span aria-hidden="true">＋</span>
        New workspace
      </button>

      <div className="sidebar-scroll">
        <nav className="shell-nav" aria-label="Overview">
          <button
            type="button"
            className={"shell-nav-item" + (view === "insights" ? " selected" : "")}
            aria-current={view === "insights" ? "page" : undefined}
            onClick={onSelectInsights}
          >
            <span aria-hidden="true">◔</span>
            Insights
          </button>
          <button
            type="button"
            className={"shell-nav-item" + (view === "access" ? " selected" : "")}
            aria-current={view === "access" ? "page" : undefined}
            onClick={onSelectAccess}
          >
            <span aria-hidden="true">⚙</span>
            Roles &amp; skills
          </button>
        </nav>

        <div className="sidebar-label">
          <span>Workspaces</span>
          <span className="sidebar-count">{activeProjects.length}</span>
        </div>
        <nav className="thread-list" aria-label="Shared workspaces">
          {activeProjects.map((project) => {
            const projectSessions = orchestration.sessions
              .filter((session) => session.projectId === project.id)
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
            const selected =
              view === "workspace" && project.id === orchestration.selectedWorkspaceId;
            return (
              <div className={"workspace-nav-branch " + (selected ? "is-selected" : "")} key={project.id}>
                <div className="workspace-nav-row">
                  <button
                    type="button"
                    className={"workspace-nav-card " + (selected ? "selected" : "")}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onSelectWorkspace(project.id)}
                  >
                    <span className="workspace-nav-glyph" aria-hidden="true">◍</span>
                    <span className="thread-card-copy">
                      <strong>{project.name}</strong>
                      <span className="thread-card-meta">
                        <span>{projectSessions.length} {projectSessions.length === 1 ? "conversation" : "conversations"}</span>
                        <span>{formatDateTime(project.updatedAt)}</span>
                      </span>
                    </span>
                  </button>
                  <div className="workspace-nav-overflow">
                    <button
                      type="button"
                      ref={(element) => {
                        workspaceMenuButtonRefs.current[project.id] = element;
                      }}
                      className="workspace-nav-overflow-button"
                      aria-label={`Workspace actions for ${project.name}`}
                      aria-haspopup="menu"
                      aria-expanded={openWorkspaceMenuId === project.id}
                      aria-controls={`workspace-menu-${project.id}`}
                      title="Workspace actions"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenWorkspaceMenuId((current) =>
                          current === project.id ? null : project.id,
                        );
                      }}
                    >
                      <span aria-hidden="true">•••</span>
                    </button>
                    {openWorkspaceMenuId === project.id && (
                      <div
                        ref={(element) => {
                          workspaceMenuRefs.current[project.id] = element;
                        }}
                        id={`workspace-menu-${project.id}`}
                        className="workspace-nav-menu"
                        role="menu"
                        aria-label={`Actions for ${project.name}`}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="workspace-nav-menu-item"
                          onClick={() => {
                            closeWorkspaceMenu(project.id);
                            onSelectWorkspace(project.id);
                            onCreateConversation();
                          }}
                        >
                          New conversation
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="workspace-nav-menu-item"
                          onClick={() => {
                            closeWorkspaceMenu(project.id);
                            onArchiveWorkspace(project.id);
                          }}
                        >
                          Archive Workspace
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="workspace-nav-menu-item is-danger"
                          onClick={() => {
                            closeWorkspaceMenu(project.id);
                            onDeleteWorkspace(project.id);
                          }}
                        >
                          Delete Workspace
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {selected && (
                  <div className="workspace-conversation-list" aria-label={`Conversations in ${project.name}`}>
                    {projectSessions.map((session) => {
                      const conversationSelected = session.id === orchestration.selectedSessionId;
                      return (
                        <div className="thread-card-row" key={session.id}>
                          <button
                            type="button"
                            className={"thread-card workspace-conversation-card " + (conversationSelected ? "selected" : "")}
                            aria-current={conversationSelected ? "page" : undefined}
                            onClick={() => onSelectSession(session.id)}
                          >
                            <span className="thread-card-copy">
                              <strong>{session.name}</strong>
                              <span className="thread-card-meta">
                                <span>{formatDateTime(session.updatedAt)}</span>
                              </span>
                            </span>
                            <span className={"thread-state thread-state-" + session.status}>
                              {statusLabel(session.status)}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="thread-delete"
                            aria-label={`Delete conversation ${session.name}`}
                            title={isOrchestrationActive(session.status) ? "Stop before deleting" : "Delete conversation"}
                            disabled={isOrchestrationActive(session.status) || orchestration.action !== null}
                            onClick={() => {
                              if (window.confirm(`Delete conversation "${session.name}"?`)) {
                                onDeleteSession(session.id);
                              }
                            }}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                    {projectSessions.length === 0 && (
                      <div className="workspace-conversation-empty">No conversations yet.</div>
                    )}
                    <button
                      type="button"
                      className="workspace-conversation-new"
                      onClick={onCreateConversation}
                    >
                      <span aria-hidden="true">＋</span> New conversation
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {activeProjects.length === 0 && orchestration.sessions.filter((session) => !session.projectId).length === 0 && (
            <div className="empty-sidebar">
              <span aria-hidden="true">◇</span>
              {orchestration.loading
                ? "Loading workspaces…"
                : "Create a Workspace and put your Agents in it."}
            </div>
          )}
          {orchestration.sessions.some((session) => !session.projectId) && (
            <div className="workspace-legacy-branch">
              <div className="workspace-legacy-label">Other conversations</div>
              {orchestration.sessions
                .filter((session) => !session.projectId)
                .map((session) => {
                  const selected = view === "workspace" && session.id === orchestration.selectedSessionId;
                  return (
                    <div className="thread-card-row" key={session.id}>
                      <button
                        type="button"
                        className={"thread-card workspace-conversation-card " + (selected ? "selected" : "")}
                        aria-current={selected ? "page" : undefined}
                        onClick={() => onSelectSession(session.id)}
                      >
                        <span className="thread-card-copy">
                          <strong>{session.name}</strong>
                          <span className="thread-card-meta"><span>{formatDateTime(session.updatedAt)}</span></span>
                        </span>
                        <span className={"thread-state thread-state-" + session.status}>{statusLabel(session.status)}</span>
                      </button>
                      <button
                        type="button"
                        className="thread-delete"
                        aria-label={`Delete conversation ${session.name}`}
                        disabled={isOrchestrationActive(session.status) || orchestration.action !== null}
                        onClick={() => {
                          if (window.confirm(`Delete conversation "${session.name}"?`)) onDeleteSession(session.id);
                        }}
                      >×</button>
                    </div>
                  );
                })}
            </div>
          )}
        </nav>

        <div className="sidebar-label">
          <span>Agents</span>
          <span className="sidebar-label-actions">
            <span className="sidebar-count">{agents.length}</span>
            <button
              type="button"
              className="sidebar-add"
              aria-label="Create Agent"
              title="Create Agent"
              onClick={onNewAgent}
            >
              ＋
            </button>
          </span>
        </div>
        <nav className="agent-list" aria-label="Agents">
          {agents.map((agent) => {
            const selected = view === "agent" && agent.id === selectedAgentId;
            return (
              <div className="agent-branch" key={agent.id}>
                <button
                  type="button"
                  className={"agent-card " + (selected ? "selected" : "")}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => onSelectAgent(agent.id)}
                >
                  <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
                  <div className="agent-card-copy">
                    <strong>{agent.name}</strong>
                    <span>{agent.description || agentStatusLabel(agent.status)}</span>
                  </div>
                  <span className={"mini-dot mini-" + agent.status} aria-hidden="true" />
                  <span className="orch-sr-only">{agentStatusLabel(agent.status)}</span>
                </button>
              </div>
            );
          })}
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
  );
}
