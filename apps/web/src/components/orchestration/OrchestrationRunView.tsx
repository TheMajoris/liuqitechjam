import { useConfirm } from "../ConfirmDialog";
import type {
  Agent,
  ModelProviderDescriptor,
  OrchestrationSession,
  OrchestrationSessionDetail,
  Project,
  ToolApproval,
} from "../../types";
import { diagnoseFailure } from "./failure-diagnosis";
import { ParticipantBar } from "./ParticipantBar";
import { ToolApprovalList } from "../approvals/ToolApprovalCard";
import type { OrchestrationAction } from "./use-orchestration";
import {
  agentName,
  humanizeFailure,
  isOrchestrationActive,
  isOrderedMode,
  statusLabel,
} from "./orchestration-utils";

interface OrchestrationRunViewProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  /** Present when this Team collaborates on a shared Project. */
  project?: Project | null;
  replyCount: number;
  action?: OrchestrationAction;
  onStart: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  modelProviders?: ModelProviderDescriptor[];
  /** Opens the room on the Agent whose turn failed; omitted hides the button. */
  onInspectFailure?: ((agentId: string | null) => void) | undefined;
  /** Optional server-owned approval projections for this Team Run. */
  approvals?: readonly ToolApproval[];
  approvalPendingId?: string | null;
  approvalPendingAction?: "approve" | "reject" | null;
  approvalErrors?: Readonly<Record<string, string>>;
  onApprovalDecision?: (approvalId: string, approved: boolean) => void;
}

function StatusMark({ status }: { status: OrchestrationSession["status"] }) {
  return (
    <span className={`orch-status orch-status-${status}`}>
      <span className="orch-status-dot" aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}

function summaryLine(session: OrchestrationSession, currentAgent: string | null): string {
  switch (session.status) {
    case "draft":
      return "Ready when you are.";
    case "queued":
      return "Getting the first Agent started…";
    case "running":
      return currentAgent ? `${currentAgent} is working on its turn.` : "An Agent is working.";
    case "stopping":
      return "Finishing up and cancelling in-flight work…";
    case "completed":
      return "Conversation completed.";
    case "stopped":
      return "You stopped this conversation.";
    case "interrupted":
      return "The service restarted while this was running. Start a new conversation to try again.";
    case "failed":
      return humanizeFailure(session.errorCode, session.errorMessage);
    default:
      return statusLabel(session.status);
  }
}

/**
 * The conversation's own header: what was asked, who is in it, where it got
 * to. Deliberately not a card of its own — it sits directly above the thread.
 */
export function OrchestrationRunView({
  detail,
  agents,
  project = null,
  replyCount,
  action = null,
  onStart,
  onStop,
  onDelete,
  modelProviders = [],
  onInspectFailure,
  approvals = [],
  approvalPendingId = null,
  approvalPendingAction = null,
  approvalErrors = {},
  onApprovalDecision,
}: OrchestrationRunViewProps) {
  const confirm = useConfirm();
  const failure = diagnoseFailure(detail, agents);
  if (!detail) return null;

  const { session } = detail;
  const current = session.currentParticipantId
    ? session.participants.find((participant) => participant.id === session.currentParticipantId)
    : null;
  const currentAgent = current ? agentName(agents, current.agentId) : null;
  const active = isOrchestrationActive(session.status);
  const canStart =
    Boolean(session.originalPrompt.trim()) && session.participants.length > 0;
  const failed = session.status === "failed";
  const showTechnicalErrorCode =
    session.errorCode !== null && !session.errorCode.startsWith("SUPERVISOR_");

  return (
    <header className="orch-run-view">
      <div className="orch-run-heading">
        <div className="orch-run-identity">
          {/* The shared artifact, not the prompt, is what this Team is about.
              Per-Agent Project roles are edited in the workspace inspector. */}
          {project && (
            <span className="orch-project-badge">
              <span className="orch-eyebrow">Workspace</span>
              <strong>{project.name}</strong>
            </span>
          )}
          <h2 id="orch-run-heading" title={session.originalPrompt}>
            {session.name}
          </h2>
        </div>
        <div className="orch-run-heading-side">
          <StatusMark status={session.status} />
          {session.status === "draft" && (
            <button
              type="button"
              className="orch-button orch-button-primary"
              disabled={action !== null || !canStart}
              title={
                canStart
                  ? "Start conversation"
                  : "Add a task and at least one Agent before starting"
              }
              onClick={() => onStart(session.id)}
            >
              {action === "start"
                ? "Starting…"
                : canStart
                  ? "Start"
                  : "Add task, Agent, and Supervisor"}
            </button>
          )}
          {active && (
            <button
              type="button"
              className="orch-button orch-button-danger"
              disabled={action !== null}
              onClick={() => onStop(session.id)}
            >
              {action === "stop" ? "Stopping…" : "Stop"}
            </button>
          )}
          <button
            type="button"
            className="orch-button orch-button-quiet"
            disabled={action !== null || active}
            title={active ? "Stop this conversation before deleting it" : "Delete conversation"}
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
            {action === "delete" ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      <ParticipantBar
        participants={session.participants}
        agents={agents}
        currentParticipantId={session.currentParticipantId}
        showOrder={isOrderedMode(session.mode)}
        modelProviders={modelProviders}
      />

      <p className="orch-run-summary" aria-live="polite">
        <span className="orch-run-replies">
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </span>
        {/* A failure is stated once, in the alert below, which is the only
            one of the two that can carry the Agent name and the detail. */}
        {!failed && (
          <>
            <span aria-hidden="true"> · </span>
            <span className="orch-run-summary-line">{summaryLine(session, currentAgent)}</span>
          </>
        )}
      </p>

      {approvals.length > 0 && (
        <ToolApprovalList
          approvals={approvals}
          getAgentName={(agentId) => agentName(agents, agentId)}
          projectName={project?.name}
          runLabel={session.name}
          pendingDecisionId={approvalPendingId}
          pendingDecision={approvalPendingAction}
          decisionErrors={approvalErrors}
          onDecision={onApprovalDecision}
          className="tool-approval-list-orchestration"
        />
      )}

      {failed && (
        <div className="orch-alert orch-alert-danger orch-failure-alert" role="alert">
          <div className="orch-failure-copy">
            {/* Who failed, not just that something did. The code alone made
                finding the Agent a manual read of the Activity log. */}
            {failure?.agentName && (
              <strong className="orch-failure-agent">
                {failure.agentName} could not finish
                {failure.stepIndex === null ? "" : ` (step ${failure.stepIndex + 1})`}
              </strong>
            )}
            <span>{failure?.summary ?? humanizeFailure(session.errorCode, session.errorMessage)}</span>
            {failure?.agentError && (
              <span className="orch-failure-detail">{failure.agentError}</span>
            )}
          </div>
          <div className="orch-failure-actions">
            {/* Only offered when there is somewhere specific to go. A failure
                with no recorded turn — the supervisor never picked anyone —
                has no Agent to show, and a button that just switches tabs is
                worse than no button. */}
            {onInspectFailure && failure?.agentId && (
              <button
                type="button"
                className="orch-button orch-button-quiet"
                onClick={() => onInspectFailure(failure.agentId)}
              >
                Show {failure.agentName}
              </button>
            )}
            {showTechnicalErrorCode && session.errorCode && (
              <code className="orch-error-code" title="Shown for technical review">
                {session.errorCode}
              </code>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
