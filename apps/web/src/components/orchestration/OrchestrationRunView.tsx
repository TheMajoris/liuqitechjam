import { useState } from "react";
import type {
  Agent,
  ModelProviderDescriptor,
  OrchestrationSession,
  OrchestrationSessionDetail,
  Project,
  ProjectRole,
} from "../../types";
import { ParticipantBar } from "./ParticipantBar";
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
  action?: "create" | "start" | "stop" | "continue" | "delete" | null;
  onStart: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  modelProviders?: ModelProviderDescriptor[];
  onProjectRoleChange?: (agentId: string, role: ProjectRole) => Promise<void>;
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
  onProjectRoleChange,
}: OrchestrationRunViewProps) {
  const [projectRoleError, setProjectRoleError] = useState<string | null>(null);
  if (!detail) return null;

  const { session } = detail;
  const current = session.currentParticipantId
    ? session.participants.find((participant) => participant.id === session.currentParticipantId)
    : null;
  const currentAgent = current ? agentName(agents, current.agentId) : null;
  const active = isOrchestrationActive(session.status);
  const failed = session.status === "failed";
  const showTechnicalErrorCode =
    session.errorCode !== null && !session.errorCode.startsWith("SUPERVISOR_");

  return (
    <header className="orch-run-view">
      <div className="orch-run-heading">
        <div className="orch-run-identity">
          {/* The shared artifact, not the prompt, is what this Team is about. */}
          {project && (
            <div className="orch-project-badge">
              <span className="orch-eyebrow">Shared Project</span>
              <strong>{project.name}</strong>
              {(project.memberships ?? []).length > 0 && (
                <div className="orch-project-members" aria-label="Project Agent roles">
                  {(project.memberships ?? []).map((membership) => (
                    <label key={membership.agentId} className="orch-project-member">
                      <span>{agentName(agents, membership.agentId)}</span>
                      <select
                        aria-label={`Role for ${agentName(agents, membership.agentId)}`}
                        value={membership.role}
                        disabled={onProjectRoleChange === undefined}
                        onChange={(event) => {
                          if (!onProjectRoleChange) return;
                          setProjectRoleError(null);
                          void onProjectRoleChange(
                            membership.agentId,
                            event.target.value as ProjectRole,
                          ).catch((reason) => {
                            setProjectRoleError(
                              reason instanceof Error
                                ? reason.message
                                : "Unable to update the Project role",
                            );
                          });
                        }}
                      >
                        <option value="owner">Owner</option>
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </label>
                  ))}
                </div>
              )}
              {projectRoleError && (
                <span className="orch-project-role-error" role="alert">
                  {projectRoleError}
                </span>
              )}
            </div>
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
              disabled={action !== null}
              onClick={() => onStart(session.id)}
            >
              {action === "start" ? "Starting…" : "Start"}
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
            onClick={() => {
              if (window.confirm("Delete this conversation and its Team chat history?")) {
                onDelete(session.id);
              }
            }}
          >
            {action === "delete" ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {active && (
        <p className="orch-run-summary" role="status">Stop this conversation before deleting it.</p>
      )}

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
        <span aria-hidden="true"> · </span>
        <span className="orch-run-summary-line">{summaryLine(session, currentAgent)}</span>
      </p>

      {failed && (
        <div className="orch-alert orch-alert-danger" role="alert">
          <span>{humanizeFailure(session.errorCode, session.errorMessage)}</span>
          {showTechnicalErrorCode && session.errorCode && (
            <code className="orch-error-code" title="Shown for technical review">
              {session.errorCode}
            </code>
          )}
        </div>
      )}
    </header>
  );
}
