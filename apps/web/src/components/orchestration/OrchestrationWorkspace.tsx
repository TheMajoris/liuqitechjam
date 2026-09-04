import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type {
  Agent,
  AgentAppearance,
  AgentRole,
  ModelProviderDescriptor,
  Project,
  ProjectMembership,
  ProjectRole,
} from "../../types";
import { NewConversationDialog } from "./NewConversationDialog";
import { OrchestrationRunView } from "./OrchestrationRunView";
import { OrchestrationRunTabs, type RunTab } from "./OrchestrationRunTabs";
import { ProjectPreviewPanel } from "./ProjectPreviewPanel";
import {
  isOrchestrationActive,
  normalizeParticipants,
  type OrchestrationDraft,
  type WorkspaceDraft,
} from "./orchestration-utils";
import type { UseOrchestrationResult } from "./use-orchestration";
import { buildWorkspaceViewModel } from "../../workspace/workspace-adapter";
import { WorkspaceView } from "../../workspace/WorkspaceView";
import { useProjectPreview } from "../../workspace/use-project-preview";
import { useWorkspaceApprovals } from "../../workspace/use-workspace-approvals";
import { useWorkspaceActivity } from "../../workspace/use-workspace-activity";
import { useAgentMetrics } from "../../workspace/use-agent-metrics";
import type { AgentLifecycleAction } from "../../workspace/AgentInspector";
import { WorkspaceRoster, type WorkspaceRosterMember } from "../../workspace/WorkspaceRoster";

/** Memberships written before named roles existed still resolve to a preset. */
const LEGACY_ROLE_IDS: Record<ProjectRole, string> = {
  owner: "legacy-owner",
  editor: "legacy-editor",
  viewer: "legacy-viewer",
};

const AGENT_STATUS_LABEL: Record<string, string> = {
  busy: "Working",
  stopped: "Stopped",
  error: "Needs attention",
};

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

interface OrchestrationWorkspaceProps {
  agents: Agent[];
  projects: Project[];
  /** Access presets available to this Workspace's members. */
  roles: AgentRole[];
  /** Owned by the app shell so the sidebar can list the same conversations. */
  orchestration: UseOrchestrationResult;
  composerOpen: boolean;
  composerMode: "workspace" | "conversation";
  onComposerOpenChange: (open: boolean) => void;
  onComposerModeChange: (mode: "workspace" | "conversation") => void;
  modelProviders?: ModelProviderDescriptor[];
  /** Lets the room's controls refresh the shell's Agent list after start/stop. */
  onAgentsChanged: () => Promise<void>;
  /** Jump to an Agent's own workspace from the room. */
  onOpenAgent: (agentId: string) => void;
}

export function OrchestrationWorkspace({
  agents,
  projects,
  roles,
  orchestration,
  composerOpen,
  composerMode,
  onComposerOpenChange,
  onComposerModeChange,
  modelProviders = [],
  onAgentsChanged,
  onOpenAgent,
}: OrchestrationWorkspaceProps) {
  const {
    detail,
    detailLoading,
    sessions,
    loading,
    error,
    selectedWorkspaceId,
  } = orchestration;
  const replyCount = detail?.turns.length ?? 0;
  const projectId = detail?.session.projectId ?? selectedWorkspaceId;
  const [project, setProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<RunTab>("workspace");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [lifecyclePending, setLifecyclePending] = useState<AgentLifecycleAction | null>(null);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);
  // Use the list projection immediately when switching parents; the detail
  // request fills in memberships without briefly seeding the composer from
  // the previously selected Workspace.
  const listedProject = projects.find((item) => item.id === projectId) ?? null;
  const workspaceProject = project?.id === projectId ? project : listedProject;

  const sessionActive = detail ? isOrchestrationActive(detail.session.status) : false;
  const previewController = useProjectPreview(projectId);
  const approvalsController = useWorkspaceApprovals(projectId, sessionActive);
  const activity = useWorkspaceActivity(projectId, sessionActive);

  const roomAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const participant of detail?.session.participants ?? []) ids.add(participant.agentId);
    for (const agentId of workspaceProject?.agentIds ?? []) ids.add(agentId);
    return Array.from(ids);
  }, [detail?.session.participants, workspaceProject?.agentIds]);
  const anyAgentBusy = agents.some((agent) => agent.status === "busy");
  // The hover state that would otherwise gate this lives inside
  // WorkspaceStage; rather than lift it across a prop, polling stays live
  // while something is actually running or an Agent is selected for the
  // inspector, and falls back to a single fetch once the room goes quiet.
  const metricsActive = anyAgentBusy || selectedAgentId !== null;
  const metrics = useAgentMetrics({
    projectId,
    agentIds: roomAgentIds,
    active: metricsActive,
  });

  // The Team stores only the Project ID; its name and membership live with the
  // Project itself, so they are fetched rather than duplicated into the session.
  useEffect(() => {
    if (!projectId) {
      setProject(null);
      return;
    }
    const listed = projects.find((item) => item.id === projectId);
    if (listed) setProject(listed);
    let active = true;
    void api
      .getProject(projectId)
      .then(({ project: next }) => {
        if (active) setProject(next);
      })
      .catch(() => {
        if (active) setProject(null);
      });
    return () => {
      active = false;
    };
  }, [projectId, projects]);

  const viewModel = useMemo(
    () =>
      buildWorkspaceViewModel({
        agents,
        detail,
        project: workspaceProject,
        preview: previewController.preview,
        approvals: approvalsController.approvals,
        selectedAgentId,
        modelProviders,
        activity,
        metrics,
      }),
    [
      activity,
      agents,
      approvalsController.approvals,
      detail,
      metrics,
      modelProviders,
      previewController.preview,
      workspaceProject,
      selectedAgentId,
    ],
  );

  // Keep a selection that still exists, and default to whoever is speaking.
  useEffect(() => {
    setSelectedAgentId((current) => {
      if (current && viewModel.agents.some((agent) => agent.agentId === current)) return current;
      return viewModel.activeAgentId ?? viewModel.agents[0]?.agentId ?? null;
    });
  }, [viewModel.activeAgentId, viewModel.agents]);

  const handleStart = useCallback(
    (sessionId: string) => {
      void orchestration.startSession(sessionId).catch(() => undefined);
    },
    [orchestration],
  );

  const handleStop = useCallback(
    (sessionId: string) => {
      void orchestration.stopSession(sessionId).catch(() => undefined);
    },
    [orchestration],
  );

  const handleDelete = useCallback(
    (sessionId: string) => {
      void orchestration.deleteSession(sessionId).catch(() => undefined);
    },
    [orchestration],
  );

  const handleContinue = useCallback(
    (prompt: string, sessionId: string) => {
      void orchestration.continueSession(prompt, sessionId).catch(() => undefined);
    },
    [orchestration],
  );

  /** Cosmetic-only edit. Refreshes the Agent list so the room repaints. */
  const handleAppearanceChange = useCallback(
    async (agentId: string, appearance: AgentAppearance) => {
      await api.updateAgentAppearance(agentId, appearance);
      await onAgentsChanged();
    },
    [onAgentsChanged],
  );

  /**
   * Room membership edits go through the same routes the Assignments tab uses.
   * The Project is refetched afterwards so the roster, the canvas, and the
   * shell agree without waiting for a poll.
   */
  const runRosterTask = useCallback(
    async (task: () => Promise<unknown>) => {
      if (!projectId) return;
      setRosterBusy(true);
      setRosterError(null);
      try {
        await task();
        const { project: next } = await api.getProject(projectId);
        setProject(next);
        await onAgentsChanged();
      } catch (reason) {
        setRosterError(errorMessage(reason));
      } finally {
        setRosterBusy(false);
      }
    },
    [onAgentsChanged, projectId],
  );

  const rosterMembers = useMemo<WorkspaceRosterMember[]>(() => {
    if (!workspaceProject) return [];
    // Older Projects stored membership as bare Agent IDs; both shapes read the same.
    const source: ProjectMembership[] = workspaceProject.memberships?.length
      ? workspaceProject.memberships
      : workspaceProject.agentIds.map((agentId) => ({ agentId, role: "editor" as ProjectRole }));
    return source.map((membership) => {
      const agent = agents.find((item) => item.id === membership.agentId);
      const roleId = membership.roleId ?? LEGACY_ROLE_IDS[membership.role];
      return {
        agentId: membership.agentId,
        name: agent?.name ?? "Unavailable Agent",
        roleId,
        statusLabel: agent ? AGENT_STATUS_LABEL[agent.status] ?? "Available" : "No longer exists",
        available: Boolean(agent),
      };
    });
  }, [agents, workspaceProject]);

  const addableAgents = useMemo(() => {
    const assigned = new Set(rosterMembers.map((member) => member.agentId));
    return agents
      .filter((agent) => !assigned.has(agent.id))
      .map((agent) => ({ id: agent.id, name: agent.name }));
  }, [agents, rosterMembers]);

  /** Agent lifecycle from the room reuses the platform's own endpoints. */
  const handleLifecycle = useCallback(
    async (agentId: string, action: AgentLifecycleAction) => {
      setLifecyclePending(action);
      try {
        if (action === "start") await api.startAgent(agentId);
        else await api.stopAgent(agentId);
        await onAgentsChanged();
      } catch {
        // The shell's Agent list is the source of truth; refresh either way.
        await onAgentsChanged().catch(() => undefined);
      } finally {
        setLifecyclePending(null);
      }
    },
    [onAgentsChanged],
  );

  const openPreview = useCallback(() => {
    if (previewController.preview?.url) {
      window.open(previewController.preview.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (detail) {
      setActiveTab("preview");
    } else {
      void previewController.act("start");
    }
  }, [detail, previewController.act, previewController.preview?.url]);

  /** Create a Conversation inside the selected Workspace, starting only when
   * the composer supplied the complete runnable input. Blank/partial drafts
   * stay persisted as drafts; the server remains the final lifecycle guard. */
  const handleCreateConversation = useCallback(
    async (input: OrchestrationDraft) => {
      if (!selectedWorkspaceId) {
        throw new Error("Select a Workspace before creating a Conversation.");
      }
      const session = await orchestration.createConversation(selectedWorkspaceId, input);
      onComposerOpenChange(false);
      if (input.originalPrompt.trim() && input.participants.length > 0) {
        await orchestration.startSession(session.id).catch(() => undefined);
      }
      return session;
    },
    [onComposerOpenChange, orchestration, selectedWorkspaceId],
  );

  const handleCreateWorkspace = useCallback(async (input: WorkspaceDraft) => {
    await orchestration.createWorkspace(input);
    onComposerOpenChange(false);
    onComposerModeChange("workspace");
    await onAgentsChanged();
  }, [onAgentsChanged, onComposerModeChange, onComposerOpenChange, orchestration]);

  const openComposer = useCallback((nextMode: "workspace" | "conversation") => {
    orchestration.clearError();
    onComposerModeChange(nextMode);
    onComposerOpenChange(true);
  }, [onComposerModeChange, onComposerOpenChange, orchestration]);

  const initialParticipants = useMemo(
    () => normalizeParticipants(
      ((workspaceProject?.memberships && workspaceProject.memberships.length > 0)
        ? workspaceProject.memberships
        : workspaceProject?.agentIds.map((agentId) => ({ agentId, role: "" })) ?? [])
        .map((membership, index) => ({
          id: `workspace-member-${membership.agentId}-${index}`,
          agentId: membership.agentId,
          role: "role" in membership ? membership.role : "",
          position: index,
        })),
    ),
    [workspaceProject],
  );

  useEffect(() => {
    setActiveTab("workspace");
  }, [detail?.session.id, projectId]);

  const roster = workspaceProject ? (
    <WorkspaceRoster
      projectName={workspaceProject.name}
      members={rosterMembers}
      roles={roles}
      addableAgents={addableAgents}
      busy={rosterBusy}
      error={rosterError}
      onAssignRole={(agentId, roleId) => void runRosterTask(() => api.assignProjectRole(workspaceProject.id, agentId, roleId))}
      onRemove={(agentId) => void runRosterTask(() => api.detachProjectAgent(workspaceProject.id, agentId))}
      onAdd={(agentId) => void runRosterTask(() => api.attachProjectAgent(workspaceProject.id, agentId))}
      onSelectAgent={setSelectedAgentId}
    />
  ) : null;

  const workspaceView = (
    <WorkspaceView
      viewModel={viewModel}
      replies={replyCount}
      approvals={approvalsController.approvals ?? []}
      approvalBusyId={approvalsController.busyId}
      approvalError={approvalsController.error}
      previewBusy={previewController.busy}
      lifecyclePending={lifecyclePending}
      onSelectAgent={setSelectedAgentId}
      onLifecycle={(agentId, action) => void handleLifecycle(agentId, action)}
      onOpenConversation={() => {
        if (detail) setActiveTab("conversation");
        else openComposer("conversation");
      }}
      onOpenPreview={openPreview}
      onOpenAgent={onOpenAgent}
      onPreviewAction={(action) => void previewController.act(action)}
      onApprove={(id, scope) => void approvalsController.approve(id, scope)}
      onDeny={(id) => void approvalsController.deny(id)}
      onAppearanceChange={handleAppearanceChange}
      roster={roster}
    />
  );

  return (
    <section className="orch-workspace" aria-label="Multi-Agent conversation">
      {error && (
        <div className="orch-alert orch-alert-danger orch-workspace-alert" role="alert">
          <span>{error}</span>
          <button type="button" onClick={orchestration.clearError} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      <div className="orch-conversation-surface">
        {detailLoading && !detail ? (
          <div className="orch-run-loading" aria-busy="true" aria-label="Loading conversation">
            <div className="orch-skeleton orch-skeleton-title" />
            <div className="orch-skeleton orch-skeleton-line" />
            <div className="orch-skeleton orch-skeleton-line orch-skeleton-short" />
          </div>
        ) : detail ? (
          <>
            <OrchestrationRunView
              detail={detail}
              agents={agents}
              replyCount={replyCount}
              action={orchestration.action}
              onStart={handleStart}
              onStop={handleStop}
              onDelete={handleDelete}
              modelProviders={modelProviders}
              project={workspaceProject}
            />
            <OrchestrationRunTabs
              detail={detail}
              agents={agents}
              action={orchestration.action}
              onContinue={handleContinue}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              workspace={workspaceView}
              preview={
                workspaceProject ? (
                  <ProjectPreviewPanel
                    controller={previewController}
                    projectName={workspaceProject.name}
                  />
                ) : null
              }
            />
          </>
        ) : workspaceProject ? (
          <div className="orch-idle-workspace">
            <header className="orch-idle-heading">
              <div>
                <span className="orch-eyebrow">Workspace</span>
                <h2>{workspaceProject.name}</h2>
                <p>{workspaceProject.description || "No Conversations yet. This Workspace is ready when you are."}</p>
              </div>
              <button
                type="button"
                className="orch-button orch-button-primary"
                onClick={() => openComposer("conversation")}
              >
                <span aria-hidden="true">＋</span> New conversation
              </button>
            </header>
            {workspaceView}
          </div>
        ) : (
          <div className="orch-intro" role="status">
            <span className="orch-empty-glyph" aria-hidden="true">◎</span>
            <h2>Put your Agents in one workspace.</h2>
            <p>
              Choose who joins and describe the task. You will see them take turns in a shared
              room, and read exactly what each one said.
            </p>
            <button type="button" className="button button-primary" onClick={() => openComposer("workspace")}>
              <span aria-hidden="true">＋</span> New workspace
            </button>
            <span className="orch-intro-note">
              {agents.length === 0
                ? "No Agents available yet — create one first."
                : sessions.length > 0
                  ? "Or open one from the sidebar."
                  : `${agents.length} ${agents.length === 1 ? "Agent" : "Agents"} ready to join.`}
              {loading && " Loading your conversations…"}
            </span>
          </div>
        )}
      </div>

      <NewConversationDialog
        open={composerOpen}
        agents={agents}
        disabled={orchestration.action !== null}
        mode={composerMode}
        workspace={workspaceProject}
        initialParticipants={composerMode === "conversation" ? initialParticipants : []}
        onCreate={composerMode === "conversation" ? handleCreateConversation : undefined}
        onCreateWorkspace={composerMode === "workspace" ? handleCreateWorkspace : undefined}
        onClose={() => onComposerOpenChange(false)}
        modelProviders={modelProviders}
      />
    </section>
  );
}
