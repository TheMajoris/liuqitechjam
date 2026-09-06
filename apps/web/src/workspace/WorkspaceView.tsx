import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AgentAppearance } from "../types";
import { AgentInspector, type AgentLifecycleAction } from "./AgentInspector";
import { WorkspaceStage } from "./WorkspaceStage";
import { PREVIEW_ACTIVITY_LABEL, type WorkspaceViewModel } from "./workspace-view-model";
import type { PreviewAction } from "./use-project-preview";

interface WorkspaceViewProps {
  viewModel: WorkspaceViewModel;
  replies: number;
  previewBusy: PreviewAction | null;
  lifecyclePending: AgentLifecycleAction | null;
  onSelectAgent: (agentId: string) => void;
  onLifecycle: (agentId: string, action: AgentLifecycleAction) => void;
  onOpenConversation: () => void;
  onOpenPreview: () => void;
  onOpenAgent: (agentId: string) => void;
  onPreviewAction: (action: PreviewAction) => void;
  onAppearanceChange?: (agentId: string, appearance: AgentAppearance) => Promise<void>;
  /** Room membership and Workspace roles; owned by the caller that has the Project. */
  roster?: ReactNode;
}

const INSPECTOR_PREFERENCE_KEY = "launchpad.workspaceInspector";

function readInspectorPreference(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(INSPECTOR_PREFERENCE_KEY) === "open";
}

/**
 * The Workspace tab: the room, the things you can do to it, and the words that
 * say what it means. The canvas is one view of this state, never the only one.
 */
export function WorkspaceView({
  viewModel,
  replies,
  previewBusy,
  lifecyclePending,
  onSelectAgent,
  onLifecycle,
  onOpenConversation,
  onOpenPreview,
  onOpenAgent,
  onPreviewAction,
  onAppearanceChange,
  roster,
}: WorkspaceViewProps) {
  const [inspectorOpen, setInspectorOpen] = useState(readInspectorPreference);
  const selected =
    viewModel.agents.find((agent) => agent.agentId === viewModel.selectedAgentId) ?? null;
  const previewRunning = viewModel.previewStatus === "running";
  const previewTransitioning =
    viewModel.previewStatus === "starting" || viewModel.previewStatus === "stopping";
  const selectAgent = useCallback((agentId: string) => {
    onSelectAgent(agentId);
    setInspectorOpen(true);
  }, [onSelectAgent]);

  useEffect(() => {
    window.localStorage.setItem(
      INSPECTOR_PREFERENCE_KEY,
      inspectorOpen ? "open" : "closed",
    );
  }, [inspectorOpen]);

  return (
    <div className="ws-view">
      <div className="ws-topbar">
        <p className="ws-summary" aria-live="polite">
          {viewModel.orchestrationSummary}
        </p>

        {/* The room's actionable stations, as controls. The scene remains
            clickable too; these are the keyboard and screen-reader equivalents. */}
        <div className="ws-toolbar">
          <div className="ws-stations" role="group" aria-label="Workspace stations">
            {viewModel.projectId && (
              <div className="ws-preview-control" role="group" aria-label="Shared preview">
                <button
                  type="button"
                  className="ws-station ws-preview-status"
                  data-state={viewModel.previewStatus}
                  onClick={onOpenPreview}
                >
                  <span className="ws-station-name">Preview</span>
                  <span className="ws-station-state">
                    {PREVIEW_ACTIVITY_LABEL[viewModel.previewStatus]}
                  </span>
                </button>
                {previewRunning ? (
                  <button
                    type="button"
                    className="ws-preview-action"
                    disabled={previewBusy !== null}
                    onClick={() => onPreviewAction("stop")}
                    aria-label="Stop shared preview"
                  >
                    {previewBusy === "stop" ? "Stopping…" : "Stop"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ws-preview-action"
                    disabled={previewBusy !== null || previewTransitioning}
                    onClick={() => onPreviewAction("start")}
                    aria-label="Start shared preview"
                  >
                    {previewBusy === "start" ? "Starting…" : "Start"}
                  </button>
                )}
              </div>
            )}

          </div>
          <button
            type="button"
            className="ws-inspector-toggle"
            aria-expanded={inspectorOpen}
            aria-controls="workspace-agent-inspector"
            onClick={() => setInspectorOpen((value) => !value)}
          >
            <span aria-hidden="true">◍</span>
            {inspectorOpen ? "Hide Agent details" : "Agent details"}
          </button>
        </div>
      </div>

      <div className={"ws-body " + (inspectorOpen ? "has-inspector" : "") }>
        <WorkspaceStage
          viewModel={viewModel}
          replies={replies}
          onSelectAgent={selectAgent}
          onOpenConversation={onOpenConversation}
          onOpenPreview={onOpenPreview}
        />
        {inspectorOpen && (
          <AgentInspector
            agent={selected}
            projectName={viewModel.projectId ? viewModel.name : null}
            pending={lifecyclePending}
            onLifecycle={onLifecycle}
            onOpenConversation={onOpenConversation}
            onOpenAgent={onOpenAgent}
            onClose={() => setInspectorOpen(false)}
            {...(onAppearanceChange ? { onAppearanceChange } : {})}
          />
        )}
      </div>

      {roster}
    </div>
  );
}
