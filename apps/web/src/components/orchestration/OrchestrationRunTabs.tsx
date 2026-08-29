import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, OrchestrationSessionDetail, Project } from "../../types";
import { OrchestrationConversation } from "./OrchestrationConversation";
import { OrchestrationTimeline } from "./OrchestrationTimeline";
import { ProjectPreviewPanel } from "./ProjectPreviewPanel";

const BASE_TABS = [
  { id: "conversation", label: "Conversation" },
  { id: "timeline", label: "Timeline" },
] as const;

const PREVIEW_TAB = { id: "preview", label: "Preview" } as const;

type RunTab = (typeof BASE_TABS)[number]["id"] | typeof PREVIEW_TAB.id;

const TAB_NOTES: Record<RunTab, string> = {
  conversation: "What the Agents said",
  timeline: "Step-by-step execution record",
  preview: "The shared artifact this Team is building",
};

interface OrchestrationRunTabsProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  action?: "create" | "start" | "stop" | "continue" | "delete" | null;
  onContinue?: (prompt: string, sessionId: string) => void;
  /** Supplied only when the Team is attached to a shared Project. */
  project?: Project | null;
}

export function OrchestrationRunTabs({
  detail,
  agents,
  action,
  onContinue,
  project,
}: OrchestrationRunTabsProps) {
  // The Preview tab exists only for a Team with a canonical shared artifact.
  const tabs = useMemo(
    () => (project ? [...BASE_TABS, PREVIEW_TAB] : [...BASE_TABS]),
    [project],
  );
  const [activeTab, setActiveTab] = useState<RunTab>("conversation");
  const tabRefs = useRef<Partial<Record<RunTab, HTMLButtonElement | null>>>({});

  // Selecting a Team without a Project must not strand the user on a gone tab.
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab("conversation");
  }, [tabs, activeTab]);

  const moveFocus = (from: RunTab, offset: number) => {
    const index = tabs.findIndex((tab) => tab.id === from);
    const next = tabs[(index + offset + tabs.length) % tabs.length]!;
    setActiveTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <section className="orch-run-tabs" aria-label="Conversation and execution detail">
      {/* The bar spans the pane; its contents share the thread's column. */}
      <div className="orch-run-tablist">
        <div role="tablist" aria-label="Conversation and execution detail">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`orch-run-tab-${tab.id}`}
              ref={(node) => {
                tabRefs.current[tab.id] = node;
              }}
              aria-selected={activeTab === tab.id}
              aria-controls={`orch-run-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={`orch-run-tab ${activeTab === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") moveFocus(tab.id, 1);
                if (event.key === "ArrowLeft") moveFocus(tab.id, -1);
              }}
            >
              {tab.label}
            </button>
          ))}
          <span className="orch-run-tab-note">{TAB_NOTES[activeTab]}</span>
        </div>
      </div>

      <div
        className={
          "orch-run-tab-panel " +
          (activeTab === "conversation" ? "is-conversation" : "")
        }
        id={`orch-run-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`orch-run-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === "conversation" ? (
          <OrchestrationConversation
            detail={detail}
            agents={agents}
            action={action}
            onContinue={onContinue}
          />
        ) : activeTab === "timeline" ? (
          <OrchestrationTimeline detail={detail} agents={agents} embedded />
        ) : project ? (
          <ProjectPreviewPanel projectId={project.id} projectName={project.name} />
        ) : null}
      </div>
    </section>
  );
}
