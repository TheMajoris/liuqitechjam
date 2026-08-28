import type {
  Agent,
  OrchestrationEvent,
  OrchestrationParticipant,
  OrchestrationSessionDetail,
} from "../../types";
import { OrchestrationEventRow } from "./OrchestrationEventRow";

interface OrchestrationTimelineProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  embedded?: boolean;
}

export function OrchestrationTimeline({
  detail,
  agents,
  embedded = false,
}: OrchestrationTimelineProps) {
  const events = detail
    ? [...detail.events].sort((left, right) => left.sequence - right.sequence)
    : [];
  const participants = new Map<string, OrchestrationParticipant>(
    detail?.session.participants.map((participant) => [participant.id, participant]) ?? [],
  );

  return (
    <section
      className={`orch-timeline ${embedded ? "orch-timeline-embedded" : "orch-surface"}`}
      aria-labelledby="orch-timeline-heading"
    >
      <div className="orch-timeline-heading">
        {embedded ? (
          <h2 className="orch-sr-only" id="orch-timeline-heading">Execution timeline</h2>
        ) : (
          <div>
            <span className="orch-eyebrow">Technical view</span>
            <h2 id="orch-timeline-heading">Execution timeline</h2>
          </div>
        )}
        <span className="orch-timeline-count">
          {events.length} {events.length === 1 ? "event" : "events"}
        </span>
      </div>

      {events.length === 0 ? (
        <div className="orch-timeline-empty" role="status">
          <span className="orch-empty-glyph" aria-hidden="true">—</span>
          <strong>No execution events yet</strong>
          <span>Start the conversation to watch dispatches, handoffs, and final state arrive in order.</span>
        </div>
      ) : (
        <ol className="orch-event-list" aria-label="Ordered orchestration events">
          {events.map((event: OrchestrationEvent) => (
            <li key={event.id}>
              <OrchestrationEventRow
                event={event}
                participant={event.participantId ? participants.get(event.participantId) : undefined}
                agents={agents}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
