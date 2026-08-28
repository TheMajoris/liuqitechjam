import { useRef, useState } from "react";
import type { Agent, OrchestrationSessionDetail } from "../../types";
import { OrchestrationConversation } from "./OrchestrationConversation";
import { OrchestrationTimeline } from "./OrchestrationTimeline";

const TABS = [
  { id: "conversation", label: "Conversation" },
  { id: "timeline", label: "Timeline" },
] as const;

type RunTab = (typeof TABS)[number]["id"];

interface OrchestrationRunTabsProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  action?: "create" | "start" | "stop" | "continue" | "delete" | null;
  onContinue?: (prompt: string, sessionId: string) => void;
}

export function OrchestrationRunTabs({ detail, agents, action, onContinue }: OrchestrationRunTabsProps) {
  const [activeTab, setActiveTab] = useState<RunTab>("conversation");
  const tabRefs = useRef<Partial<Record<RunTab, HTMLButtonElement | null>>>({});

  const moveFocus = (from: RunTab, offset: number) => {
    const index = TABS.findIndex((tab) => tab.id === from);
    const next = TABS[(index + offset + TABS.length) % TABS.length]!;
    setActiveTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <section className="orch-run-tabs" aria-label="Conversation and execution detail">
      {/* The bar spans the pane; its contents share the thread's column. */}
      <div className="orch-run-tablist">
        <div role="tablist" aria-label="Conversation and execution detail">
          {TABS.map((tab) => (
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
          <span className="orch-run-tab-note">
            {activeTab === "conversation"
              ? "What the Agents said"
              : "Step-by-step execution record"}
          </span>
        </div>
      </div>

      <div
        className="orch-run-tab-panel"
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
        ) : (
          <OrchestrationTimeline detail={detail} agents={agents} embedded />
        )}
      </div>
    </section>
  );
}
