import { useMemo } from "react";
import type { Agent, OrchestrationParticipant, WorkspaceCheckpointView, ToolApproval } from "../../types";
import { MarkdownMessage } from "../MarkdownMessage";

import {
  agentName,
  eventLabel,
  formatDateTime,
  formatDuration,
  humanizeFailure,
  isInternalWording,
  turnStatusLabel,
} from "./orchestration-utils";
import type { GraphNode } from "./orchestration-graph";
import {
  buildTurnBriefing,
  digestReply,
  type NarrativeExcerpt,
} from "./turn-narrative";
import { ToolApprovalList } from "../approvals/ToolApprovalCard";

export interface OrchestrationTurnInspectorProps {
  node: GraphNode;
  agents: Agent[];
  /**
   * The roster, used only to name the Agents quoted inside a turn's briefing.
   * Absent for callers that do not hold one; the Agent name is then enough.
   */
  participants?: readonly OrchestrationParticipant[];
  /** Absent when the caller cannot retry, which closes the affordance. */
  onRetry?: ((fromStepIndex: number) => void) | undefined;
  retryPending?: boolean;
  /** True while the conversation is running, when a retry must not be offered. */
  retryBlocked?: boolean;
  /** True while another lifecycle action is in flight. */
  retryDisabled?: boolean;
  /**
   * The source checkpoint saved after this turn, resolved by the caller from
   * the turn's own `workspaceCheckpointId`. Absent when none was recorded.
   */
  checkpoint?: WorkspaceCheckpointView | undefined;
  /** True when the detail carries checkpoints at all, so an absence is worth stating. */
  checkpointsEnabled?: boolean;
  /** Absent when the caller cannot restore, which closes the affordance. */
  onRecover?: ((checkpointId: string) => void) | undefined;
  recoverPending?: boolean;
  /** True while the conversation is running, when a restore must not be offered. */
  recoverBlocked?: boolean;
  /** True while another lifecycle action is in flight. */
  recoverDisabled?: boolean;
  /** Approval projections joined to this turn by turn ID or Agent Run ID. */
  approvals?: readonly ToolApproval[];
  approvalPendingId?: string | null;
  approvalPendingAction?: "approve" | "reject" | null;
  approvalErrors?: Readonly<Record<string, string>>;
  onApprovalDecision?: (approvalId: string, approved: boolean) => void;
  onClose: () => void;
}

/**
 * Name the Agent behind one quoted excerpt, in the reader's vocabulary.
 *
 * The prompt identifies speakers by opaque ID. A reader knows them by the name
 * on the roster and the job they were given, so both are recovered and the ID
 * is never shown.
 */
function speakerLabel(
  agents: readonly Agent[],
  participants: readonly OrchestrationParticipant[],
  excerpt: NarrativeExcerpt,
): string {
  const role =
    participants.find((participant) => participant.id === excerpt.participantId)?.role.trim() ??
    "";
  const name = excerpt.agentId ? agentName(agents, excerpt.agentId) : "";
  if (name && role && role !== name) return name + " · " + role;
  return name || role || "Another Agent";
}

function stepTag(stepNumber: number | undefined): string {
  return stepNumber === undefined ? "··" : String(stepNumber).padStart(2, "0");
}

/**
 * What one dot on the graph actually records: its status, its timings, what it
 * was asked to do, what it answered, and the journal entries written against
 * its Run.
 *
 * The record the server keeps is the rendered handoff prompt — delimiters,
 * identifiers, safety contract and all. That text is kept verbatim behind a
 * disclosure, because it is the truthful artefact, but it is not what the panel
 * leads with: a reader opening a step wants the task, the role, the result
 * handed over, and the conversation so far, in their own words.
 *
 * A failed turn offers the legacy retry, which reruns the Agent against the
 * files as they are now. A completed turn with a recorded source checkpoint
 * offers the restore: the files go back to how they were after that turn and
 * the remaining participants resume from there.
 */
export function OrchestrationTurnInspector({
  node,
  agents,
  participants = [],
  onRetry,
  retryPending = false,
  retryBlocked = false,
  retryDisabled = false,
  checkpoint,
  checkpointsEnabled = false,
  onRecover,
  recoverPending = false,
  recoverBlocked = false,
  recoverDisabled = false,
  approvals = [],
  approvalPendingId = null,
  approvalPendingAction = null,
  approvalErrors = {},
  onApprovalDecision,
  onClose,
}: OrchestrationTurnInspectorProps) {
  const { turn } = node;
  const reason = node.reason && !isInternalWording(node.reason) ? node.reason.trim() : "";
  const canRetry = Boolean(onRetry) && turn.stepIndex !== undefined;
  const completed = turn.status === "completed";
  const recoverable = completed && checkpoint !== undefined && checkpoint.recoverable;
  const canRecover = recoverable && Boolean(onRecover);
  const briefing = useMemo(
    () => buildTurnBriefing(turn.safeInputSummary),
    [turn.safeInputSummary],
  );
  const reply = useMemo(() => digestReply(turn.safeOutput), [turn.safeOutput]);
  const speaker = (excerpt: NarrativeExcerpt) =>
    speakerLabel(agents, participants, excerpt);
  const turnApprovals = approvals.filter(
    (approval) => approval.turnId === turn.id || approval.runId === turn.runId,
  );

  return (
    <aside className="orch-inspector" aria-labelledby="orch-inspector-heading">
      <div className="orch-inspector-head">
        <div>
          <span className="orch-eyebrow">Step {node.stepNumber}</span>
          <h3 id="orch-inspector-heading">{agentName(agents, turn.agentId)}</h3>
        </div>
        <button
          type="button"
          className="orch-inspector-close"
          onClick={onClose}
          aria-label="Close turn details"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <dl className="orch-inspector-facts">
        <div>
          <dt>Status</dt>
          <dd data-status={turn.status}>{turnStatusLabel(turn.status)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(node.durationMs)}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(turn.createdAt)}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd><code>{turn.runId.slice(0, 8)}</code></dd>
        </div>
      </dl>

      {turnApprovals.length > 0 && (
        <ToolApprovalList
          approvals={turnApprovals}
          getAgentName={(agentId) => agentName(agents, agentId)}
          runLabel={`Run ${turn.runId.slice(0, 8)}`}
          pendingDecisionId={approvalPendingId}
          pendingDecision={approvalPendingAction}
          decisionErrors={approvalErrors}
          onDecision={onApprovalDecision}
          className="tool-approval-list-turn"
        />
      )}

      {completed && checkpoint && (
        <p className="orch-inspector-checkpoint">
          <span className="orch-checkpoint-badge">
            Workspace checkpoint #{checkpoint.ordinal}
          </span>
          <span className="orch-inspector-checkpoint-facts">
            {checkpoint.fileCount} {checkpoint.fileCount === 1 ? "file" : "files"}
            {checkpoint.excludedFileCount > 0 &&
              ` · ${checkpoint.excludedFileCount} excluded`}
            {!checkpoint.recoverable && " · not restorable"}
          </span>
        </p>
      )}

      {completed && !checkpoint && checkpointsEnabled && (
        <p className="orch-inspector-note">
          No workspace checkpoint was recorded for this turn.
        </p>
      )}

      {node.failed && (
        <p className="orch-inspector-failure">
          {humanizeFailure(turn.errorCode, turn.safeOutput, turn.modelId)}
          {turn.errorCode && <code>{turn.errorCode}</code>}
        </p>
      )}

      {reason && (
        <section className="orch-inspector-section">
          <h4>Why this Agent</h4>
          <p>{reason}</p>
        </section>
      )}

      <section className="orch-inspector-section">
        <h4>Asked to do</h4>
        {briefing.task ? (
          <div className="orch-brief-item">
            <span className="orch-brief-label">The task</span>
            <p className="orch-brief-text">{briefing.task}</p>
          </div>
        ) : (
          <p className="orch-inspector-empty">
            No instructions were recorded for this turn.
          </p>
        )}

        {briefing.role && (
          <div className="orch-brief-item">
            <span className="orch-brief-label">Its job on the team</span>
            <p className="orch-brief-text">{briefing.role}</p>
          </div>
        )}

        {briefing.handoff && (
          <div className="orch-brief-item">
            <span className="orch-brief-label">
              Handed over by {speaker(briefing.handoff)}
            </span>
            <p className="orch-brief-text orch-inspector-quote">
              {briefing.handoff.text}
              {briefing.handoff.truncated && <em> (shortened)</em>}
            </p>
          </div>
        )}

        {briefing.context.length > 0 && (
          <div className="orch-brief-item">
            <span className="orch-brief-label">
              What had happened before ({briefing.context.length}{" "}
              {briefing.context.length === 1 ? "turn" : "turns"})
            </span>
            <ol className="orch-brief-context">
              {briefing.context.map((entry, index) => (
                <li key={index}>
                  <span className="orch-brief-step">{stepTag(entry.stepNumber)}</span>
                  <div className="orch-brief-context-body">
                    <span className="orch-brief-speaker">{speaker(entry)}</span>
                    <p className="orch-brief-text orch-inspector-quote">
                      {entry.text}
                      {entry.truncated && <em> (shortened)</em>}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {briefing.truncated && (
          <p className="orch-inspector-note">
            This record was shortened when it was written, so some of it is missing.
          </p>
        )}

        {/* Kept verbatim: the briefing above is a reading of this text, and a
            reader checking the Agent's behaviour needs the text itself. */}
        {briefing.recognized && (
          <details className="orch-verbatim">
            <summary>Exact text sent to this Agent</summary>
            <pre>{turn.safeInputSummary}</pre>
          </details>
        )}
      </section>

      {turn.safeOutput && !reply.empty && !node.failed && (
        <section className="orch-inspector-section">
          <h4>Replied</h4>
          {/* A reply with no structure of its own is already readable, and
              summarising it to one sentence would only hide the rest. Only a
              structured reply earns an at-a-glance list above its full text. */}
          {reply.keyPoints.length === 0 ? (
            <MarkdownMessage
              content={turn.safeOutput}
              className="orch-inspector-markdown"
            />
          ) : (
            <>
              {reply.headline && <p className="orch-brief-text">{reply.headline}</p>}
              <ul className="orch-brief-points">
                {reply.keyPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              {reply.codeBlocks > 0 && (
                <p className="orch-inspector-note">
                  Includes {reply.codeBlocks} code{" "}
                  {reply.codeBlocks === 1 ? "block" : "blocks"}, shown in the full reply.
                </p>
              )}
              <details className="orch-verbatim">
                <summary>Full reply</summary>
                <MarkdownMessage
                  content={turn.safeOutput}
                  className="orch-inspector-markdown"
                />
              </details>
            </>
          )}
          {turn.outputTruncated && (
            <p className="orch-inspector-note">
              This reply was shortened when it was recorded.
            </p>
          )}
        </section>
      )}

      <section className="orch-inspector-section">
        <h4>Event log</h4>
        {node.events.length === 0 ? (
          <p className="orch-inspector-empty">No events recorded for this Run.</p>
        ) : (
          <ol className="orch-inspector-events">
            {node.events.map((event) => (
              <li key={event.id}>
                <span className="orch-inspector-event-name">{eventLabel(event.type)}</span>
                <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                {event.errorCode && <code>{event.errorCode}</code>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {canRecover && checkpoint && (
        <section className="orch-inspector-restore">
          <button
            type="button"
            className="orch-inspector-restore-action"
            disabled={recoverPending || recoverBlocked || recoverDisabled}
            onClick={() => onRecover?.(checkpoint.checkpointId)}
          >
            {recoverPending ? "Restoring…" : `Restore after ${agentName(agents, turn.agentId)} and resume`}
          </button>
          <p className="orch-inspector-note" role={recoverPending ? "status" : undefined}>
            {recoverBlocked
              ? "Stop the conversation before restoring its files."
              : recoverPending
                ? "Saving a safety checkpoint, then restoring the source files…"
                : recoverDisabled
                  ? "Wait for the current action to finish."
                  : "Source files go back to how they were after this turn. A safety checkpoint of the current files is saved first, and the next Agent starts with fresh Project context. Credentials, generated files and external tool actions are not rolled back."}
          </p>
        </section>
      )}

      {node.failed && canRetry && (
        <section className="orch-inspector-resume">
          <button
            type="button"
            className="orch-inspector-resume-action"
            disabled={retryPending || retryBlocked || retryDisabled}
            onClick={() => onRetry?.(turn.stepIndex as number)}
          >
            {retryPending ? "Retrying…" : "Retry this turn"}
          </button>
          <p className="orch-inspector-note">
            {retryBlocked
              ? "Stop the conversation before retrying it."
              : retryPending
                ? "Retrying this Agent turn…"
                : retryDisabled
                  ? "Wait for the current action to finish."
                  : "Reruns this turn with the Workspace files as they are now — nothing is rolled back. Earlier turns stay in the record."}
          </p>
        </section>
      )}
    </aside>
  );
}
