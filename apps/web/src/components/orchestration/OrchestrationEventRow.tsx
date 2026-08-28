import type {
  Agent,
  OrchestrationEvent,
  OrchestrationParticipant,
} from "../../types";
import {
  agentName,
  eventLabel,
  formatDateTime,
  formatDuration,
  humanizeFailure,
  participantNumber,
} from "./orchestration-utils";

interface OrchestrationEventRowProps {
  event: OrchestrationEvent;
  participant?: OrchestrationParticipant;
  agents?: Agent[];
}

function productEventLabel(
  event: OrchestrationEvent,
  participant: OrchestrationParticipant | undefined,
  agents: Agent[],
): string {
  if (event.type === "supervisor_decision") {
    if (event.completionReason === "supervisor_completed") {
      return "Conversation completed";
    }
    const selectedAgentId = event.agentId ?? participant?.agentId;
    if (selectedAgentId) {
      return `${agentName(agents, selectedAgentId)} selected as next participant`;
    }
    return "Conversation completed";
  }
  if (event.type === "orchestration_completed") return "Conversation completed";
  return eventLabel(event.type);
}

function productEventSummary(
  event: OrchestrationEvent,
  participant: OrchestrationParticipant | undefined,
  agents: Agent[],
): string {
  if (event.type === "supervisor_decision") {
    const summary = event.safeSummary?.trim();
    return summary &&
      !/\b(supervisor|mastra|langgraph|graph|workflow)\b/i.test(summary)
      ? summary
      : productEventLabel(event, participant, agents);
  }
  if (event.errorCode?.startsWith("SUPERVISOR_")) {
    return humanizeFailure(event.errorCode, event.safeSummary);
  }
  if (
    event.safeSummary &&
    /\b(supervisor|mastra|langgraph|graph|workflow)\b/i.test(event.safeSummary)
  ) {
    return "The control plane recorded this transition.";
  }
  return event.safeSummary || "The control plane recorded this transition.";
}

function shouldShowTechnicalErrorCode(event: OrchestrationEvent): boolean {
  return !event.errorCode?.startsWith("SUPERVISOR_");
}

export function OrchestrationEventRow({
  event,
  participant,
  agents = [],
}: OrchestrationEventRowProps) {
  return (
    <article className="orch-event-row">
      <div className="orch-event-marker" aria-hidden="true">
        {participant ? participantNumber(participant.position) : "·"}
      </div>
      <div className="orch-event-body">
        <div className="orch-event-topline">
          <strong>
            {participant && (
              <span className="orch-sr-only">
                Participant {participantNumber(participant.position)}: {" "}
              </span>
            )}
            {productEventLabel(event, participant, agents)}
          </strong>
          <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
        </div>
        <p>{productEventSummary(event, participant, agents)}</p>
        <div className="orch-event-meta">
          <span>{event.status}</span>
          {event.durationMs !== undefined && <span>{formatDuration(event.durationMs)}</span>}
          {event.completionReason === "roster_exhausted" && (
            <code>{event.completionReason}</code>
          )}
          {event.errorCode && shouldShowTechnicalErrorCode(event) && (
            <code className="orch-event-code-error">{event.errorCode}</code>
          )}
          {event.runId && <code>Run {event.runId.slice(0, 8)}</code>}
        </div>
      </div>
    </article>
  );
}
