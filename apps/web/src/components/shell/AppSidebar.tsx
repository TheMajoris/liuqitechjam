import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../ConfirmDialog";
import { Collapse } from "../../motion/Collapse";
import { OFFSET, transitions, variants } from "../../motion/motion-tokens";
import type {
  Agent,
  OrchestrationSession,
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
export type ShellView =
  | "workspace"
  | "agent"
  | "insights"
  | "traces"
  | "access";

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
  onSelectTraces: () => void;
  onSelectAccess: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onCreateConversation: () => void;
  /** Replays the guided tour on demand. */
  onReplayTutorial: () => void;
}

function agentStatusLabel(status: Agent["status"]): string {
  if (status === "ready") return "Ready";
  if (status === "busy") return "Working";
  if (status === "stopped") return "Stopped";
  return "Error";
}

/**
 * One Conversation in the tree.
 *
 * The delete control lives inside the card rather than beside it, so a row is
 * one target with one outline instead of a card and a stray glyph drifting
 * past its right edge. State reads on the meta line next to the timestamp,
 * which leaves the name the full width it needs before it has to truncate.
 */
/**
 * One overview destination.
 *
 * The selected background is a single element shared by the whole nav rather
 * than a class on each button, so choosing a destination moves the highlight
 * from the old one to the new one. That travel is the answer to "where did I
 * just come from", which three independently painted backgrounds cannot give.
 */
function ShellNavItem({
  glyph,
  label,
  selected,
  onClick,
}: {
  glyph: string;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={"shell-nav-item" + (selected ? " selected" : "")}
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
    >
      {selected && (
        // No opacity of its own: a `layoutId` element is crossfaded by the
        // projection between the two positions, and declaring `initial`
        // alongside that leaves the highlight stuck at the entry value.
        <motion.span
          className="shell-nav-highlight"
          layoutId="shell-nav-highlight"
          transition={transitions.travel}
          aria-hidden="true"
        />
      )}
      <span className="shell-nav-label">
        <span aria-hidden="true">{glyph}</span>
        {label}
      </span>
    </button>
  );
}

function ConversationRow({
  session,
  selected,
  busy,
  onSelect,
  onDelete,
}: {
  session: OrchestrationSession;
  selected: boolean;
  busy: boolean;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  const confirm = useConfirm();
  const active = isOrchestrationActive(session.status);
  return (
    <motion.div
      className={"conversation-row" + (selected ? " is-selected" : "")}
      layout="position"
      variants={variants.row}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={transitions.base}
    >
      <button
        type="button"
        className="conversation-card"
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(session.id)}
      >
        <span className={"conversation-dot thread-state-" + session.status} aria-hidden="true" />
        <span className="conversation-copy">
          <strong>{session.name}</strong>
          <span className="conversation-meta">
            <span className={"thread-state thread-state-" + session.status}>
              {statusLabel(session.status)}
            </span>
            <span className="conversation-sep" aria-hidden="true" />
            <time dateTime={session.updatedAt}>{formatDateTime(session.updatedAt)}</time>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="conversation-delete"
        aria-label={`Delete conversation ${session.name}`}
        title={active ? "Stop before deleting" : "Delete conversation"}
        disabled={active || busy}
        onClick={() =>
          confirm({
            title: `Delete "${session.name}"?`,
            body:
              "Its replies, activity log, and retry history go with it. " +
              "The Workspace, its shared files, and the Agents stay.",
            confirmLabel: "Delete conversation",
            onConfirm: () => onDelete(session.id),
          })
        }
      >
        <span aria-hidden="true">×</span>
      </button>
    </motion.div>
  );
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
  onSelectTraces,
  onSelectAccess,
  onSelectSession,
  onSelectWorkspace,
  onArchiveWorkspace,
  onDeleteWorkspace,
  onDeleteSession,
  onSelectAgent,
  onCreateConversation,
  onReplayTutorial,
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

        <button
          type="button"
          className="rail-item rail-secondary"
          aria-label="New Agent"
          onClick={onNewAgent}
        >
          <span aria-hidden="true">◈</span>
          <span className="rail-tip" aria-hidden="true">New Agent</span>
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
            className={"rail-item" + (view === "traces" ? " is-active" : "")}
            aria-label="Traces"
            aria-current={view === "traces" ? "page" : undefined}
            onClick={onSelectTraces}
          >
            <span aria-hidden="true">⋔</span>
            <span className="rail-tip" aria-hidden="true">Traces</span>
          </button>
          <button
            type="button"
            className="rail-item"
            aria-label="Replay the tour"
            onClick={onReplayTutorial}
          >
            <span aria-hidden="true">◆</span>
            <span className="rail-tip" aria-hidden="true">Replay the tour</span>
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
            <strong>LQAM</strong>
            <span>Liu Qi Agent Management · {runtimeLabel} · Codex</span>
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

      {/* Both of the things a new user has to make, stated as buttons.
          Creating an Agent used to be a bare "+" glyph beside a section
          label, which reads as a decoration rather than the second half of
          setup — and a Workspace is not usable until an Agent exists. */}
      <div className="create-actions">
        <button type="button" className="button button-primary create-button" onClick={onNewWorkspace}>
          <span aria-hidden="true">＋</span>
          New workspace
        </button>
        <button
          type="button"
          className="button button-secondary create-button"
          onClick={onNewAgent}
        >
          <span aria-hidden="true">＋</span>
          New Agent
        </button>
      </div>

      {/* `layoutScroll` because this pane scrolls: without it the shared nav
          highlight and the list rows measure against an unscrolled page and
          jump by the scroll offset when they animate. */}
      <motion.div className="sidebar-scroll" layoutScroll>
        <nav className="shell-nav" aria-label="Overview">
          <ShellNavItem
            glyph="◔"
            label="Insights"
            selected={view === "insights"}
            onClick={onSelectInsights}
          />
          <ShellNavItem
            glyph="⋔"
            label="Traces"
            selected={view === "traces"}
            onClick={onSelectTraces}
          />
          <ShellNavItem
            glyph="⚙"
            label="Roles & skills"
            selected={view === "access"}
            onClick={onSelectAccess}
          />
        </nav>

        <div className="sidebar-label">
          <span>Workspaces</span>
          <span className="sidebar-count">{activeProjects.length}</span>
        </div>
        <nav className="thread-list" aria-label="Shared workspaces">
          {/* Archiving or deleting a Workspace closes its row and lets the
              rest travel up, so the list stays the same list. */}
          <AnimatePresence initial={false}>
          {activeProjects.map((project) => {
            const projectSessions = orchestration.sessions
              .filter((session) => session.projectId === project.id)
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
            const selected =
              view === "workspace" && project.id === orchestration.selectedWorkspaceId;
            return (
              <motion.div
                className={"workspace-nav-branch " + (selected ? "is-selected" : "")}
                key={project.id}
                layout="position"
                variants={variants.row}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={transitions.base}
              >
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
                      {/* Drawn rather than typed: a "•••" glyph run carries a
                          trailing letter-space after the last bullet, which
                          drags the ink off the button's centre. */}
                      <svg
                        className="overflow-glyph"
                        viewBox="0 0 16 4"
                        width="16"
                        height="4"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <circle cx="2" cy="2" r="1.6" />
                        <circle cx="8" cy="2" r="1.6" />
                        <circle cx="14" cy="2" r="1.6" />
                      </svg>
                    </button>
                    {/* The menu grows from the button it belongs to, which
                        says where it came from when it lands over the list. */}
                    <AnimatePresence>
                    {openWorkspaceMenuId === project.id && (
                      <motion.div
                        ref={(element) => {
                          workspaceMenuRefs.current[project.id] = element;
                        }}
                        id={`workspace-menu-${project.id}`}
                        className="workspace-nav-menu"
                        role="menu"
                        aria-label={`Actions for ${project.name}`}
                        initial={{ opacity: 0, scale: 0.96, y: -OFFSET.hair }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96 }}
                        transition={transitions.fast}
                        style={{ transformOrigin: "top right" }}
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
                      </motion.div>
                    )}
                    </AnimatePresence>
                  </div>
                </div>
                {/* Selecting a Workspace opens its conversations underneath
                    it, so the branch grows rather than the list jumping. */}
                <Collapse open={selected}>
                  <div
                    className="workspace-conversation-list"
                    aria-label={`Conversations in ${project.name}`}
                  >
                    <AnimatePresence initial={false}>
                      {projectSessions.map((session) => (
                        <ConversationRow
                          key={session.id}
                          session={session}
                          selected={session.id === orchestration.selectedSessionId}
                          busy={orchestration.action !== null}
                          onSelect={onSelectSession}
                          onDelete={onDeleteSession}
                        />
                      ))}
                    </AnimatePresence>
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
                </Collapse>
              </motion.div>
            );
          })}
          </AnimatePresence>
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
                    <ConversationRow
                      key={session.id}
                      session={session}
                      selected={selected}
                      busy={orchestration.action !== null}
                      onSelect={onSelectSession}
                      onDelete={onDeleteSession}
                    />
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
              <span>Agents do the work. Create one to put in a Workspace.</span>
              <button type="button" className="button button-primary" onClick={onNewAgent}>
                Create your first Agent
              </button>
            </div>
          )}
        </nav>
      </motion.div>

      <button type="button" className="sidebar-tour" onClick={onReplayTutorial}>
        <span aria-hidden="true">◆</span>
        Replay the tour
      </button>

      <div className="runtime-card">
        <span className="eyebrow">Runtime</span>
        <strong>{system?.runtime ?? "Checking…"}</strong>
        <span>
          Per-Agent model assignments
          {system?.containerEngine ? " · " + system.containerEngine : ""}
        </span>
      </div>
    </aside>
  );
}
