import type {
  Agent,
  ModelProviderDescriptor,
  OrchestrationParticipant,
} from "../../types";
import { formatAgentWorkerModel } from "../WorkerModelFields";
import { AgentAvatar } from "./AgentAvatar";
import { agentName } from "./orchestration-utils";

interface ParticipantBarProps {
  participants: OrchestrationParticipant[];
  agents: Agent[];
  currentParticipantId?: string | null;
  /** Configured order is only shown where execution actually follows it. */
  showOrder?: boolean;
  /** Worker assignments are display-only Team metadata. */
  modelProviders?: ModelProviderDescriptor[];
}

/**
 * The people in this conversation. Configured occurrence order is preserved
 * in the rendering order either way, because deterministic execution follows
 * it and one Agent may appear more than once.
 */
export function ParticipantBar({
  participants,
  agents,
  currentParticipantId = null,
  showOrder = false,
  modelProviders = [],
}: ParticipantBarProps) {
  if (participants.length === 0) return null;

  return (
    <ul
      className="orch-participant-bar"
      aria-label={showOrder ? "Participants, in speaking order" : "Participants"}
    >
      {participants.map((participant, index) => {
        const name = agentName(agents, participant.agentId);
        const agent = agents.find((candidate) => candidate.id === participant.agentId);
        const isActive = participant.id === currentParticipantId;
        const focus = participant.role.trim();
        return (
          <li
            className={`orch-participant-pill ${isActive ? "is-active" : ""}`}
            key={participant.id}
            title={focus && focus !== name ? `${name} — ${focus}` : name}
          >
            {showOrder && (
              <span className="orch-participant-pill-order" aria-hidden="true">{index + 1}</span>
            )}
            <AgentAvatar agentId={participant.agentId} name={name} size="sm" />
            <span className="orch-participant-pill-copy">
              <span className="orch-participant-pill-name">{name}</span>
              <span className="orch-participant-pill-model">
                {formatAgentWorkerModel(agent ?? { modelRef: undefined }, modelProviders)}
              </span>
            </span>
            {isActive && <span className="orch-participant-pill-state">speaking</span>}
          </li>
        );
      })}
    </ul>
  );
}
