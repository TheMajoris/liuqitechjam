import { useState } from "react";
import type {
  Agent,
  ModelProviderDescriptor,
  OrchestrationParticipant,
} from "../../types";
import { AgentAvatar } from "./AgentAvatar";
import { formatAgentWorkerModel } from "../WorkerModelFields";
import {
  agentName,
  createParticipant,
  normalizeParticipants,
} from "./orchestration-utils";

interface AgentPickerProps {
  participants: OrchestrationParticipant[];
  agents: Agent[];
  disabled?: boolean;
  error?: string;
  /**
   * Occurrence order drives deterministic turn taking, so it is only surfaced
   * when the conversation actually follows it. The order itself is always
   * captured, whether or not it is shown.
   */
  showOrder?: boolean;
  /** Worker assignments are informational and cannot be changed here. */
  modelProviders?: ModelProviderDescriptor[];
  onChange: (participants: OrchestrationParticipant[]) => void;
}

export function AgentPicker({
  participants,
  agents,
  disabled = false,
  error,
  showOrder = false,
  modelProviders = [],
  onChange,
}: AgentPickerProps) {
  const [catalogOpen, setCatalogOpen] = useState(true);

  const add = (agent: Agent) => {
    onChange(
      normalizeParticipants([
        ...participants,
        createParticipant(participants.length, agent.id),
      ]),
    );
  };

  const removeAt = (index: number) => {
    onChange(
      normalizeParticipants(participants.filter((_, itemIndex) => itemIndex !== index)),
    );
  };

  const moveAt = (index: number, direction: "up" | "down") => {
    const destination = direction === "up" ? index - 1 : index + 1;
    if (destination < 0 || destination >= participants.length) return;
    const updated = [...participants];
    const current = updated[index];
    const target = updated[destination];
    if (!current || !target) return;
    updated[index] = target;
    updated[destination] = current;
    onChange(normalizeParticipants(updated));
  };

  const updateRole = (index: number, role: string) => {
    onChange(
      normalizeParticipants(
        participants.map((participant, itemIndex) =>
          itemIndex === index ? { ...participant, role } : participant,
        ),
      ),
    );
  };

  const showCatalog = catalogOpen || participants.length === 0;

  return (
    <fieldset className="orch-picker" aria-describedby={error ? "orch-picker-error" : undefined}>
      <legend>Agents</legend>

      {error && (
        <p className="orch-field-error" id="orch-picker-error" role="alert">
          {error}
        </p>
      )}

      {participants.length > 0 && (
        <ul className="orch-chip-row" aria-label="Agents in this conversation">
          {participants.map((participant, index) => {
            const name = agentName(agents, participant.agentId);
            return (
              <li className="orch-chip" key={participant.id}>
                {showOrder && (
                  <span className="orch-chip-order" aria-hidden="true">{index + 1}</span>
                )}
                <AgentAvatar agentId={participant.agentId} name={name} size="sm" />
                <span className="orch-chip-name">{name}</span>
                <button
                  type="button"
                  className="orch-chip-remove"
                  disabled={disabled}
                  aria-label={`Remove ${name} from the conversation`}
                  onClick={() => removeAt(index)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {participants.length > 0 && (
        <button
          type="button"
          className="orch-button orch-button-quiet orch-add-agent"
          disabled={disabled}
          aria-expanded={showCatalog}
          aria-controls="orch-catalog"
          onClick={() => setCatalogOpen((current) => !current)}
        >
          {showCatalog ? (
            "Done adding"
          ) : (
            <>
              <span aria-hidden="true">+</span> Add Agent
            </>
          )}
        </button>
      )}

      {showCatalog &&
        (agents.length === 0 ? (
          <div className="orch-picker-empty" id="orch-catalog" role="status">
            <strong>No Agents yet</strong>
            <span>Create an Agent first, then invite it here.</span>
          </div>
        ) : (
          <div className="orch-catalog" id="orch-catalog">
            <span className="orch-eyebrow">Add an Agent</span>
            <ul className="orch-agent-grid">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className="orch-agent-chip"
                    disabled={disabled}
                    aria-label={`Add ${agent.name} to the conversation`}
                    onClick={() => add(agent)}
                  >
                    <AgentAvatar agentId={agent.id} name={agent.name} />
                    <span className="orch-agent-chip-copy">
                      <strong>{agent.name}</strong>
                      <span>{agent.description || "Coding Agent"}</span>
                      <span className="orch-agent-chip-model">
                        {formatAgentWorkerModel(agent, modelProviders)}
                      </span>
                    </span>
                    {agent.status === "ready" ? (
                      <span className="orch-sr-only">Ready</span>
                    ) : (
                      <span className={`orch-agent-status orch-agent-status-${agent.status}`}>
                        {agent.status}
                      </span>
                    )}
                    <span className="orch-agent-chip-count" aria-hidden="true">+</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}

      {participants.length > 0 && (
        <details className="orch-picker-details">
          <summary>
            <span>Order and focus</span>
            <span className="orch-advanced-hint">
              {showOrder
                ? "This conversation follows the order below"
                : "Used when you pick a fixed order in Advanced"}
            </span>
          </summary>
          <ol className="orch-turn-list">
            {participants.map((participant, index) => {
              const name = agentName(agents, participant.agentId);
              return (
                <li className="orch-turn-row" key={participant.id}>
                  <span className="orch-turn-index" aria-hidden="true">{index + 1}</span>
                  <AgentAvatar agentId={participant.agentId} name={name} size="sm" />
                  <span className="orch-turn-copy">
                    <strong>{name}</strong>
                    <input
                      className="orch-turn-role"
                      value={participant.role}
                      disabled={disabled}
                      maxLength={80}
                      placeholder="What this Agent focuses on (optional)"
                      aria-label={`Focus for ${name}, position ${index + 1}`}
                      onChange={(event) => updateRole(index, event.target.value)}
                    />
                  </span>
                  <span
                    className="orch-turn-actions"
                    role="group"
                    aria-label={`Reorder ${name}, position ${index + 1}`}
                  >
                    <button
                      type="button"
                      className="orch-icon-button"
                      disabled={disabled || index === 0}
                      aria-label={`Move ${name} earlier`}
                      onClick={() => moveAt(index, "up")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="orch-icon-button"
                      disabled={disabled || index === participants.length - 1}
                      aria-label={`Move ${name} later`}
                      onClick={() => moveAt(index, "down")}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="orch-icon-button orch-icon-button-danger"
                      disabled={disabled}
                      aria-label={`Remove ${name}`}
                      onClick={() => removeAt(index)}
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </fieldset>
  );
}
