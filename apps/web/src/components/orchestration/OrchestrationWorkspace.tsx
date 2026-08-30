import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type {
  Agent,
  AgentAppearance,
  ModelProviderDescriptor,
  Project,
} from "../../types";
import { NewConversationDialog } from "./NewConversationDialog";
import { OrchestrationRunView } from "./OrchestrationRunView";
import { OrchestrationRunTabs, type RunTab } from "./OrchestrationRunTabs";
import { ProjectPreviewPanel } from "./ProjectPreviewPanel";
import { isOrchestrationActive, type OrchestrationDraft } from "./orchestration-utils";
import type { UseOrchestrationResult } from "./use-orchestration";
import { buildWorkspaceViewModel } from "../../workspace/workspace-adapter";
import { WorkspaceView } from "../../workspace/WorkspaceView";
import { useProjectPreview } from "../../workspace/use-project-preview";
import { useWorkspaceApprovals } from "../../workspace/use-workspace-approvals";
import { useWorkspaceActivity } from "../../workspace/use-workspace-activity";
import type { AgentLifecycleAction } from "../../workspace/AgentInspector";

interface OrchestrationWorkspaceProps {
  agents: Agent[];
  /** Owned by the app shell so the sidebar can list the same conversations. */
  orchestration: UseOrchestrationResult;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
  modelProviders?: ModelProviderDescriptor[];
  /** Lets the room's controls refresh the shell's Agent list after start/stop. */
  onAgentsChanged: () => Promise<void>;
  /** Jump to an Agent's own workspace from the room. */
  onOpenAgent: (agentId: string) => void;
}

export function OrchestrationWorkspace({
  agents,
  orchestration,
  composerOpen,
  onComposerOpenChange,
  modelProviders = [],
  onAgentsChanged,
  onOpenAgent,
}: OrchestrationWorkspaceProps) {
  const { detail, detailLoading, sessions, loading, error } = orchestration;
  const replyCount = detail?.turns.length ?? 0;
  const projectId = detail?.session.projectId ?? null;
  const [project, setProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<RunTab>("workspace");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [lifecyclePending, setLifecyclePending] = useState<AgentLifecycleAction | null>(null);

  const sessionActive = detail ? isOrchestrationActive(detail.session.status) : false;
  const previewController = useProjectPreview(projectId);
  const approvalsController = useWorkspaceApprovals(projectId, sessionActive);
  const activity = useWorkspaceActivity(projectId, sessionActive);

  // The Team stores only the Project ID; its name and membership live with the
  // Project itself, so they are fetched rather than duplicated into the session.
  useEffect(() => {
    if (!projectId) {
      setProject(null);
      return;
    }
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
  }, [projectId]);

  const viewModel = useMemo(
    () =>
      buildWorkspaceViewModel({
        agents,
        detail,
        project,
        preview: previewController.preview,
        approvals: approvalsController.approvals,
        selectedAgentId,
        modelProviders,
        activity,
      }),
    [
      activity,
      agents,
      approvalsController.approvals,
      detail,
      modelProviders,
      previewController.preview,
      project,
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
    setActiveTab("preview");
  }, [previewController.preview?.url]);

  /**
   * "Start conversation" is one product action over the two existing lifecycle
   * calls. If the start half fails the session stays a draft and the
   * conversation header still offers Start, so nothing is lost.
   */
  const handleCreate = useCallback(
    async (input: OrchestrationDraft) => {
      const session = await orchestration.createSession(input);
      onComposerOpenChange(false);
      await orchestration.startSession(session.id).catch(() => undefined);
      return session;
    },
    [onComposerOpenChange, orchestration],
  );

  const openComposer = useCallback(() => {
    orchestration.clearError();
    onComposerOpenChange(true);
  }, [onComposerOpenChange, orchestration]);

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
              project={project}
            />
            <OrchestrationRunTabs
              detail={detail}
              agents={agents}
              action={orchestration.action}
              onContinue={handleContinue}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              workspace={
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
                  onOpenConversation={() => setActiveTab("conversation")}
                  onOpenPreview={openPreview}
                  onOpenAgent={onOpenAgent}
                  onPreviewAction={(action) => void previewController.act(action)}
                  onApprove={(id, scope) => void approvalsController.approve(id, scope)}
                  onDeny={(id) => void approvalsController.deny(id)}
                  onAppearanceChange={handleAppearanceChange}
                />
              }
              preview={
                project ? (
                  <ProjectPreviewPanel
                    controller={previewController}
                    projectName={project.name}
                  />
                ) : null
              }
            />
          </>
        ) : (
          <div className="orch-intro" role="status">
            <span className="orch-empty-glyph" aria-hidden="true">◎</span>
            <h2>Put your Agents in one workspace.</h2>
            <p>
              Choose who joins and describe the task. You will see them take turns in a shared
              room, and read exactly what each one said.
            </p>
            <button type="button" className="button button-primary" onClick={openComposer}>
              <span aria-hidden="true">＋</span> New conversation
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
        onCreate={handleCreate}
        onClose={() => onComposerOpenChange(false)}
        modelProviders={modelProviders}
      />
    </section>
  );
}
