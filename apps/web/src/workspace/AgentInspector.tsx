import type { AgentAppearance, ApprovalRecord } from "../types";
import { AgentAvatar } from "../components/orchestration/AgentAvatar";
import { AgentSkinEditor } from "./AgentSkinEditor";
import { MarkdownMessage } from "../components/MarkdownMessage";
import {
  WORKSPACE_ACTIVITY,
  type WorkspaceAgentViewModel,
} from "./workspace-view-model";

export type AgentLifecycleAction = "start" | "stop";

interface AgentInspectorProps {
  agent: WorkspaceAgentViewModel | null;
  projectName: string | null;
  pending: AgentLifecycleAction | null;
  approvals: ApprovalRecord[];
  approvalBusyId: string | null;
  onLifecycle: (agentId: string, action: AgentLifecycleAction) => void;
  onOpenConversation: () => void;
  onOpenAgent: (agentId: string) => void;
  onApprove: (id: string, scope: "once" | "project") => void;
  onDeny: (id: string) => void;
  /** Cosmetic-only character edit; absent hides the appearance controls. */
  onAppearanceChange?: (agentId: string, appearance: AgentAppearance) => Promise<void>;
}

/**
 * The Agent control surface.
 *
 * Every button here calls an API the backend already exposes — Agent
 * start/stop, and the Permit approve/deny routes. Nothing in the room can act
 * on its own: the canvas only decides which Agent this panel is describing.
 */
export function AgentInspector({
  agent,
  projectName,
  pending,
  approvals,
  approvalBusyId,
  onLifecycle,
  onOpenConversation,
  onOpenAgent,
  onApprove,
  onDeny,
  onAppearanceChange,
}: AgentInspectorProps) {
  if (!agent) {
    return (
      <aside className="ws-inspector is-empty" aria-label="Agent inspector">
        <div className="ws-inspector-empty">
          <span className="ws-inspector-glyph" aria-hidden="true">◍</span>
          <strong>Select an Agent</strong>
          <p>Pick anyone in the room to see what they are doing and control them.</p>
        </div>
      </aside>
    );
  }

  const descriptor = WORKSPACE_ACTIVITY[agent.activity];
  const stopped = agent.lifecycle === "stopped";
  const action: AgentLifecycleAction = stopped ? "start" : "stop";
  const agentApprovals = approvals.filter(
    (approval) => approval.agentId === agent.agentId && approval.status === "pending",
  );

  return (
    <aside className="ws-inspector" aria-label={`Inspector for ${agent.name}`}>
      <header className="ws-inspector-head">
        <AgentAvatar agentId={agent.agentId} name={agent.name} />
        <div className="ws-inspector-identity">
          <h3>{agent.name}</h3>
          {agent.role && <span className="ws-inspector-role">{agent.role}</span>}
        </div>
      </header>

      <div className="ws-inspector-status" data-tone={descriptor.tone}>
        <span className="ws-inspector-status-glyph" aria-hidden="true">{descriptor.glyph}</span>
        <div>
          <strong>{descriptor.label}</strong>
          <span>{descriptor.detail}</span>
        </div>
      </div>

      {agent.activeTool && (
        <section className="ws-inspector-block">
          <h4>Running now</h4>
          <p className="ws-inspector-tool">
            <code>{agent.activeTool.toolId}</code>
          </p>
        </section>
      )}

      {agent.safeSummary && (
        <section className="ws-inspector-block">
          <h4>Latest safe summary</h4>
          {/* Agent output, so it goes through the one markdown renderer. */}
          <MarkdownMessage className="ws-inspector-summary" content={agent.safeSummary} />
        </section>
      )}

      {onAppearanceChange && agent.available && (
        <AgentSkinEditor
          agentId={agent.agentId}
          agentName={agent.name}
          appearance={agent.appearance}
          disabled={pending !== null}
          onChange={(appearance) => onAppearanceChange(agent.agentId, appearance)}
        />
      )}

      <dl className="ws-inspector-facts">
        <div>
          <dt>Runtime status</dt>
          <dd>{agent.lifecycle === "unknown" ? "Unavailable" : agent.lifecycle}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{agent.modelLabel ?? "Runtime default"}</dd>
        </div>
        {projectName && (
          <div>
            <dt>Access preset</dt>
            <dd>Manage in Roles &amp; skills</dd>
          </div>
        )}
        <div>
          <dt>Current run</dt>
          <dd className="ws-inspector-mono">{agent.currentRunId ?? "None"}</dd>
        </div>
      </dl>

      {agentApprovals.length > 0 && (
        <section className="ws-inspector-block ws-inspector-approvals">
          <h4>Waiting at the boundary</h4>
          {agentApprovals.map((approval) => (
            <div className="ws-approval" key={approval.id}>
              <p className="ws-approval-summary">{approval.safeSummary}</p>
              <p className="ws-approval-tool">
                Tool <code>{approval.toolId}</code>
              </p>
              <div className="ws-approval-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={approvalBusyId !== null}
                  onClick={() => onApprove(approval.id, "once")}
                >
                  Approve once
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={approvalBusyId !== null}
                  onClick={() => onApprove(approval.id, "project")}
                >
                  Approve for Project
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  disabled={approvalBusyId !== null}
                  onClick={() => onDeny(approval.id)}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <footer className="ws-inspector-actions">
        <button
          type="button"
          className="button button-ghost"
          onClick={onOpenConversation}
        >
          Open conversation
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={!agent.available}
          onClick={() => onOpenAgent(agent.agentId)}
        >
          Open Agent workspace
        </button>
        <button
          type="button"
          className={"button " + (stopped ? "button-primary" : "button-danger")}
          disabled={!agent.available || pending !== null}
          onClick={() => onLifecycle(agent.agentId, action)}
        >
          {pending === "start"
            ? "Starting…"
            : pending === "stop"
              ? "Stopping…"
              : stopped
                ? "Start Agent"
                : "Stop Agent"}
        </button>
      </footer>
    </aside>
  );
}
