import type { Agent, WorkspaceCheckpointView } from "../../types";
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

export interface OrchestrationTurnInspectorProps {
  node: GraphNode;
  agents: Agent[];
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
  onClose: () => void;
}

/**
 * What one dot on the graph actually records: its status, its timings, and the
 * journal entries written against its Run.
 *
 * A failed turn offers the legacy retry, which reruns the Agent against the
 * files as they are now. A completed turn with a recorded source checkpoint
 * offers the restore: the files go back to how they were after that turn and
 * the remaining participants resume from there.
 */
export function OrchestrationTurnInspector({
  node,
  agents,
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
  onClose,
}: OrchestrationTurnInspectorProps) {
  const { turn } = node;
  const reason = node.reason && !isInternalWording(node.reason) ? node.reason.trim() : "";
  const canRetry = Boolean(onRetry) && turn.stepIndex !== undefined;
  const name = agentName(agents, turn.agentId);
  const completed = turn.status === "completed";
  const recoverable = completed && checkpoint !== undefined && checkpoint.recoverable;
  const canRecover = recoverable && Boolean(onRecover);

  return (
    <aside className="orch-inspector" aria-labelledby="orch-inspector-heading">
      <div className="orch-inspector-head">
        <div>
          <span className="orch-eyebrow">Step {node.stepNumber}</span>
          <h3 id="orch-inspector-heading">{name}</h3>
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
          {humanizeFailure(turn.errorCode, turn.safeOutput)}
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
        <p className="orch-inspector-quote">{turn.safeInputSummary || "—"}</p>
      </section>

      {turn.safeOutput && !node.failed && (
        <section className="orch-inspector-section">
          <h4>Replied</h4>
          <p className="orch-inspector-quote">
            {turn.safeOutput}
            {turn.outputTruncated && <em> (truncated)</em>}
          </p>
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
            {recoverPending ? "Restoring…" : `Restore after ${name} and resume`}
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
            {retryPending ? "Retrying…" : "Retry from this turn (current files)"}
          </button>
          <p className="orch-inspector-note">
            {retryBlocked
              ? "Stop the conversation before retrying it."
              : retryPending
                ? "Retrying this Agent turn using the current files…"
                : retryDisabled
                  ? "Wait for the current action to finish."
                  : "This reruns the Agent turn using the current files and continues from there. Earlier turns stay in the record. Workspace files are not rolled back."}
          </p>
        </section>
      )}
    </aside>
  );
}
