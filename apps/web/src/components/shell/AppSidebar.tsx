import type {
  Agent,
  AgentConversation,
  Project,
  SystemInfo,
} from "../../types";
import { ConversationRail } from "../ConversationRail";
import { AgentAvatar } from "../orchestration/AgentAvatar";
import {
  formatDateTime,
  isOrchestrationActive,
  statusLabel,
} from "../orchestration/orchestration-utils";
import type { UseOrchestrationResult } from "../orchestration/use-orchestration";

/** What the main pane is showing. The sidebar selection decides it. */
export type ShellView = "workspace" | "agent" | "insights";

interface AppSidebarProps {
  collapsed: boolean;
  view: ShellView;
  agents: Agent[];
  projects: Project[];
  selectedAgentId: string | null;
  conversations: AgentConversation[];
  conversationId: string | null;
  conversationsOpen: boolean;
  system: SystemInfo | null;
  busy: boolean;
  runInFlight: boolean;
  orchestration: UseOrchestrationResult;
  onToggleCollapsed: () => void;
  onNewWorkspace: () => void;
  onNewAgent: () => void;
  onSelectInsights: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onToggleConversations: () => void;
  onSelectConversation: (conversationId: string) => void;
  onCreateConversation: () => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onDeleteConversation: (conversationId: string) => void;
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
 * Two collections, because the domain has two: shared workspaces, where a Team
 * of Agents works on one Project, and the Agents themselves. Clicking either
 * decides what the main pane shows, so there is no separate mode switch to
 * keep in your head.
 */
export function AppSidebar({
  collapsed,
  view,
  agents,
  projects,
  selectedAgentId,
  conversations,
  conversationId,
  conversationsOpen,
  system,
  busy,
  runInFlight,
  orchestration,
  onToggleCollapsed,
  onNewWorkspace,
  onNewAgent,
  onSelectInsights,
  onSelectSession,
  onDeleteSession,
  onSelectAgent,
  onToggleConversations,
  onSelectConversation,
  onCreateConversation,
  onRenameConversation,
  onDeleteConversation,
}: AppSidebarProps) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const runtimeLabel =
    system?.runtimeProvider === "container" ? "Local container" : "Local process";

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
            aria-label={`Workspaces (${orchestration.sessions.length})`}
            onClick={onToggleCollapsed}
          >
            <span aria-hidden="true">◍</span>
            <span className="rail-tip" aria-hidden="true">
              Workspaces · {orchestration.sessions.length}
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
        </nav>

        <div className="sidebar-label">
          <span>Workspaces</span>
          <span className="sidebar-count">{orchestration.sessions.length}</span>
        </div>
        <nav className="thread-list" aria-label="Shared workspaces">
          {orchestration.sessions.map((session) => {
            const projectName = session.projectId
              ? projectNames.get(session.projectId)
              : undefined;
            const selected =
              view === "workspace" && session.id === orchestration.selectedSessionId;
            return (
              <div className="thread-card-row" key={session.id}>
                <button
                  type="button"
                  className={"thread-card " + (selected ? "selected" : "")}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => onSelectSession(session.id)}
                >
                  <span className="thread-card-copy">
                    <strong>{session.name}</strong>
                    <span className="thread-card-meta">
                      {projectName ? (
                        <span className="thread-project">{projectName}</span>
                      ) : (
                        <span className="thread-project is-none">No Project</span>
                      )}
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
                  aria-label={`Delete ${session.name}`}
                  title={
                    isOrchestrationActive(session.status)
                      ? "Stop before deleting"
                      : "Delete workspace"
                  }
                  disabled={
                    isOrchestrationActive(session.status) || orchestration.action !== null
                  }
                  onClick={() => {
                    if (window.confirm(`Delete "${session.name}" and its Team chat history?`)) {
                      onDeleteSession(session.id);
                    }
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          {orchestration.sessions.length === 0 && (
            <div className="empty-sidebar">
              <span aria-hidden="true">◇</span>
              {orchestration.loading
                ? "Loading workspaces…"
                : "Create a shared workspace and put your Agents in it."}
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
                {selected && (
                  <ConversationRail
                    conversations={conversations}
                    selectedId={conversationId}
                    open={conversationsOpen}
                    busy={busy || runInFlight}
                    onToggleOpen={onToggleConversations}
                    onSelect={onSelectConversation}
                    onCreate={onCreateConversation}
                    onRename={onRenameConversation}
                    onDelete={onDeleteConversation}
                  />
                )}
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
