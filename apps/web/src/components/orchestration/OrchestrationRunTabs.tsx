import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { transitions, variants } from "../../motion/motion-tokens";
import type { Agent, OrchestrationSessionDetail } from "../../types";
import type { Agent, OrchestrationSessionDetail, ToolApproval } from "../../types";
import type { Agent, AgentRole, OrchestrationSessionDetail, ToolApproval } from "../../types";
import { OrchestrationConversation } from "./OrchestrationConversation";
import { OrchestrationGraph } from "./OrchestrationGraph";
import { OrchestrationTimeline } from "./OrchestrationTimeline";
import { isOrchestrationActive } from "./orchestration-utils";
import type { OrchestrationAction } from "./use-orchestration";

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
  /** Resolves each speaker's capability role for the transcript byline. */
  roles?: AgentRole[];
  action?: OrchestrationAction;
  onContinue?: (prompt: string, sessionId: string) => void;
  /** Retries the run from one recorded step; omitted when unavailable. */
  onRetry?: (fromStepIndex: number) => void;
  /** Restores source files to a turn's checkpoint and resumes; omitted when unavailable. */
  onRecover?: (checkpointId: string) => void;
  /** Prompt-policy edit, surfaced beside the composer's send button. */
  onClarifyFirstChange?: ((clarifyFirst: boolean) => void) | undefined;
  activeTab: RunTab;
  onTabChange: (tab: RunTab) => void;
  /** Rendered for the Workspace tab; supplied by the owner so this component
   *  stays a tab strip rather than growing the whole room's props. */
  workspace: ReactNode;
  /** Rendered for the Preview tab; present only with a shared Project. */
  preview: ReactNode;
  /** Approval projections are joined into the selected turn detail as well as
   * the room header, so a participant's protected action is actionable in
   * context. */
  approvals?: readonly ToolApproval[];
  approvalPendingId?: string | null;
  approvalPendingAction?: "approve" | "reject" | null;
  approvalErrors?: Readonly<Record<string, string>>;
  onApprovalDecision?: (approvalId: string, approved: boolean) => void;
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
  roles = [],
  action = null,
  onContinue,
  onRetry,
  onRecover,
  onClarifyFirstChange,
  activeTab,
  onTabChange,
  workspace,
  preview,
  approvals = [],
  approvalPendingId = null,
  approvalPendingAction = null,
  approvalErrors = {},
  onApprovalDecision,
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
              {/* One pill for the strip, not one per tab: it travels to the
                  chosen tab, which says where the selection came from. */}
              {activeTab === tab && (
                <motion.span
                  className="orch-run-tab-pill"
                  layoutId="orch-run-tab-pill"
                  transition={transitions.travel}
                  aria-hidden="true"
                />
              )}
              <span className="orch-run-tab-label">{TAB_LABELS[tab]}</span>
            </button>
          ))}
          {/* The note describes the tab, so it changes with it rather than
              cutting: the two readings would otherwise be indistinguishable. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={activeTab}
              className="orch-run-tab-note"
              variants={variants.fade}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={transitions.fast}
            >
              {TAB_NOTES[activeTab]}
            </motion.span>
          </AnimatePresence>
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
            roles={roles}
            action={action}
            onContinue={onContinue}
            onRetry={onRetry}
            onRecover={onRecover}
            onClarifyFirstChange={onClarifyFirstChange}
            approvals={approvals}
            approvalPendingId={approvalPendingId}
            approvalPendingAction={approvalPendingAction}
            approvalErrors={approvalErrors}
            onApprovalDecision={onApprovalDecision}
          />
        ) : activeTab === "activity" ? (
          // The log is the reading order. The raw journal stays one disclosure
          // away, so the tab opens at one row per turn rather than two charts.
          <>
              <OrchestrationGraph
                detail={detail}
                agents={agents}
                approvals={approvals}
                approvalPendingId={approvalPendingId}
                approvalPendingAction={approvalPendingAction}
                approvalErrors={approvalErrors}
                onApprovalDecision={onApprovalDecision}
                onRetry={onRetry}
              retryPending={action === "retry"}
              // A retry starts a fresh cycle, so the run must be settled.
              retryBlocked={
                detail ? isOrchestrationActive(detail.session.status) : false
              }
              retryDisabled={action !== null && action !== "retry"}
              onRecover={onRecover}
              recoverPending={action === "recover"}
              // A restore rewrites the files a running Agent is editing.
              recoverBlocked={
                detail ? isOrchestrationActive(detail.session.status) : false
              }
              recoverDisabled={action !== null && action !== "recover"}
            />
            <details className="orch-journal">
              <summary>
                <span>Raw event journal</span>
                <span className="orch-journal-count">
                  {detail?.events.length ?? 0}{" "}
                  {(detail?.events.length ?? 0) === 1 ? "event" : "events"}
                </span>
              </summary>
              <OrchestrationTimeline detail={detail} agents={agents} embedded />
            </details>
          </>
        ) : (
          preview
        )}
      </div>
    </section>
  );
}
