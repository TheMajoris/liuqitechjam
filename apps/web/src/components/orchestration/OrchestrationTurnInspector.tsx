import type { Agent } from "../../types";
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
  onClose: () => void;
}

/**
 * What one dot on the graph actually records: its status, its timings, and the
 * journal entries written against its Run.
 *
 * A failed turn is also the one place a retry is offered, because a successful
 * turn has no failure checkpoint to recover.
 */
export function OrchestrationTurnInspector({
  node,
  agents,
  onRetry,
  retryPending = false,
  retryBlocked = false,
  retryDisabled = false,
  onClose,
}: OrchestrationTurnInspectorProps) {
  const { turn } = node;
  const reason = node.reason && !isInternalWording(node.reason) ? node.reason.trim() : "";
  const canRetry = Boolean(onRetry) && turn.stepIndex !== undefined;

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

      {node.failed && canRetry && (
        <section className="orch-inspector-resume">
          <button
            type="button"
            className="orch-inspector-resume-action"
            disabled={retryPending || retryBlocked || retryDisabled}
            onClick={() => onRetry?.(turn.stepIndex as number)}
          >
            {retryPending ? "Retrying…" : "Retry from this turn"}
          </button>
          <p className="orch-inspector-note">
            {retryBlocked
              ? "Stop the conversation before retrying it."
              : retryPending
                ? "Retrying this Agent turn and continuing from the checkpoint…"
                : retryDisabled
                  ? "Wait for the current action to finish."
                  : "This reruns the Agent turn and continues from there. Earlier turns stay in the record. Shared Workspace files are not rolled back."}
          </p>
        </section>
      )}
    </aside>
  );
}
