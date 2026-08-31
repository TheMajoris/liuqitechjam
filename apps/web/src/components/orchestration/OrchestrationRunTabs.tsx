import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Agent, OrchestrationSessionDetail } from "../../types";
import { OrchestrationConversation } from "./OrchestrationConversation";
import { OrchestrationTimeline } from "./OrchestrationTimeline";

export type RunTab = "workspace" | "conversation" | "activity" | "preview";

const TAB_LABELS: Record<RunTab, string> = {
  workspace: "Workspace",
  conversation: "Conversation",
  activity: "Activity",
  preview: "Preview",
};

const TAB_NOTES: Record<RunTab, string> = {
  workspace: "Who is in the room and what they are doing",
  conversation: "What the Agents said, in words",
  activity: "Step-by-step execution record",
  preview: "The shared artifact this Team is building",
};

interface OrchestrationRunTabsProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  action?: "create" | "start" | "stop" | "continue" | "delete" | null;
  onContinue?: (prompt: string, sessionId: string) => void;
  activeTab: RunTab;
  onTabChange: (tab: RunTab) => void;
  /** Rendered for the Workspace tab; supplied by the owner so this component
   *  stays a tab strip rather than growing the whole room's props. */
  workspace: ReactNode;
  /** Rendered for the Preview tab; present only with a shared Project. */
  preview: ReactNode;
}

/**
 * Spatial, textual, and forensic views of the same run.
 *
 * The room never replaces the transcript: Conversation stays the exact record,
 * and Activity stays the evidence. Workspace is an additional way in.
 */
export function OrchestrationRunTabs({
  detail,
  agents,
  action,
  onContinue,
  activeTab,
  onTabChange,
  workspace,
  preview,
}: OrchestrationRunTabsProps) {
  const tabs = useMemo<RunTab[]>(
    () =>
      preview
        ? ["workspace", "conversation", "activity", "preview"]
        : ["workspace", "conversation", "activity"],
    [preview],
  );
  const tabRefs = useRef<Partial<Record<RunTab, HTMLButtonElement | null>>>({});

  // Selecting a Team without a Project must not strand the user on a gone tab.
  useEffect(() => {
    if (!tabs.includes(activeTab)) onTabChange("conversation");
  }, [activeTab, onTabChange, tabs]);

  const moveFocus = (from: RunTab, offset: number) => {
    const index = tabs.indexOf(from);
    const next = tabs[(index + offset + tabs.length) % tabs.length]!;
    onTabChange(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="orch-run-tabs" aria-label="Workspace, conversation and execution detail">
      <div className="orch-run-tablist">
        <div role="tablist" aria-label="Workspace, conversation and execution detail">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`orch-run-tab-${tab}`}
              ref={(node) => {
                tabRefs.current[tab] = node;
              }}
              aria-selected={activeTab === tab}
              aria-controls={`orch-run-panel-${tab}`}
              tabIndex={activeTab === tab ? 0 : -1}
              className={`orch-run-tab ${activeTab === tab ? "is-active" : ""}`}
              onClick={() => onTabChange(tab)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") moveFocus(tab, 1);
                if (event.key === "ArrowLeft") moveFocus(tab, -1);
              }}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
          <span className="orch-run-tab-note">{TAB_NOTES[activeTab]}</span>
        </div>
      </div>

      <div
        className={
          "orch-run-tab-panel " +
          (activeTab === "conversation" ? "is-conversation" : "") +
          (activeTab === "workspace" ? "is-workspace" : "")
        }
        id={`orch-run-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`orch-run-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === "workspace" ? (
          workspace
        ) : activeTab === "conversation" ? (
          <OrchestrationConversation
            detail={detail}
            agents={agents}
            action={action}
            onContinue={onContinue}
          />
        ) : activeTab === "activity" ? (
          <OrchestrationTimeline detail={detail} agents={agents} embedded />
        ) : (
          preview
        )}
      </div>
    </section>
  );
}
