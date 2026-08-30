import type { Agent, AgentConversation, SystemInfo } from "../../types";
import { ConversationRail } from "../ConversationRail";
import { formatDateTime, isOrchestrationActive, statusLabel } from "../orchestration/orchestration-utils";
import type { UseOrchestrationResult } from "../orchestration/use-orchestration";

export type Workspace = "playground" | "orchestration";

interface AgentSidebarProps {
  agents: Agent[];
  selectedId: string | null;
  conversations: AgentConversation[];
  conversationId: string | null;
  conversationsOpen: boolean;
  workspace: Workspace;
  system: SystemInfo | null;
  busy: boolean;
  runInFlight: boolean;
  orchestration: UseOrchestrationResult;
  onHide: () => void;
  onStartNew: () => void;
  onWorkspaceChange: (workspace: Workspace) => void;
  onSelectAgent: (agentId: string) => void;
  onToggleConversations: () => void;
  onSelectConversation: (conversationId: string) => void;
  onCreateConversation: () => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}

/** Sidebar module: workspace navigation, Team sessions, and Agent threads. */
export function AgentSidebar({
  agents,
  selectedId,
  conversations,
  conversationId,
  conversationsOpen,
  workspace,
  system,
  busy,
  runInFlight,
  orchestration,
  onHide,
  onStartNew,
  onWorkspaceChange,
  onSelectAgent,
  onToggleConversations,
  onSelectConversation,
  onCreateConversation,
  onRenameConversation,
  onDeleteConversation,
}: AgentSidebarProps) {
  return (
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
          onClick={onHide}
        >
          <span aria-hidden="true">⟨</span>
        </button>
      </div>

      <button className="button button-primary create-button" onClick={onStartNew}>
        <span aria-hidden="true">＋</span>
        {workspace === "orchestration" ? "New conversation" : "Create Agent"}
      </button>

      <nav className="sidebar-nav" aria-label="Workspace">
        <button
          type="button"
          className={workspace === "playground" ? "is-active" : ""}
          aria-current={workspace === "playground" ? "page" : undefined}
          onClick={() => onWorkspaceChange("playground")}
        >
          <span aria-hidden="true">◑</span> Playground
        </button>
        <button
          type="button"
          className={workspace === "orchestration" ? "is-active" : ""}
          aria-current={workspace === "orchestration" ? "page" : undefined}
          onClick={() => onWorkspaceChange("orchestration")}
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
                    title={
                      isOrchestrationActive(session.status)
                        ? "Stop before deleting"
                        : "Delete conversation"
                    }
                    disabled={
                      isOrchestrationActive(session.status) || orchestration.action !== null
                    }
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
            <div className="agent-branch" key={agent.id}>
              <button
                className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
                aria-current={
                  workspace === "playground" && agent.id === selectedId ? "true" : undefined
                }
                onClick={() => onSelectAgent(agent.id)}
              >
                <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
                <div className="agent-card-copy">
                  <strong>{agent.name}</strong>
                  <span>{agent.description || "Coding Agent"}</span>
                </div>
                <span className={"mini-dot mini-" + agent.status} />
              </button>
              {workspace === "playground" && agent.id === selectedId && (
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
  );
}
