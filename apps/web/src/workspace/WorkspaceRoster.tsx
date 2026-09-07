import { useState } from "react";
import { AgentAvatar } from "../components/orchestration/AgentAvatar";

export interface WorkspaceRosterMember {
  agentId: string;
  name: string;
  /** The Agent's own role, which applies in every Workspace. */
  roleName: string | null;
  statusLabel: string;
  /** False when the membership points at an Agent that no longer exists. */
  available: boolean;
}

export interface WorkspaceRosterAddable {
  id: string;
  name: string;
  /** Shown under the name so a roster of six is still distinguishable. */
  description?: string | undefined;
}

interface WorkspaceRosterProps {
  projectName: string;
  members: WorkspaceRosterMember[];
  addableAgents: WorkspaceRosterAddable[];
  busy: boolean;
  error: string | null;
  onRemove: (agentId: string) => void;
  /** Attaches every chosen Agent; the caller decides how to batch the writes. */
  onAdd: (agentIds: string[]) => void;
  onSelectAgent: (agentId: string) => void;
}

/**
 * Who is in the room and what each of them is allowed to do.
 *
 * Membership is editable here; the role is not. An Agent carries one role,
 * edited on the Agent itself, so this panel reports it and links to the Agent
 * rather than offering a per-Workspace override.
 */
export function WorkspaceRoster({
  projectName,
  members,
  addableAgents,
  busy,
  error,
  onRemove,
  onAdd,
  onSelectAgent,
}: WorkspaceRosterProps) {
  // Staged locally: filling a room is one decision about who belongs in it,
  // not one decision per Agent. The select-one-then-reload dropdown this
  // replaces re-rendered the whole roster between every pick.
  const [staged, setStaged] = useState<string[]>([]);
  const addable = new Set(addableAgents.map((agent) => agent.id));
  const selected = staged.filter((agentId) => addable.has(agentId));

  const toggle = (agentId: string) => {
    setStaged((current) =>
      current.includes(agentId)
        ? current.filter((item) => item !== agentId)
        : [...current, agentId],
    );
  };

  return (
    <section className="ws-roster" aria-label={`Agents in ${projectName}`}>
      <header className="ws-roster-head">
        <div>
          <span className="ws-roster-kicker">In this room</span>
          <h3>Workspace members</h3>
        </div>
        <span className="ws-roster-count">
          {members.length} Agent{members.length === 1 ? "" : "s"}
        </span>
      </header>

      {error && (
        <p className="ws-inline-error" role="alert">
          {error}
        </p>
      )}

      {members.length === 0 ? (
        <p className="ws-roster-empty">No Agents in this room yet.</p>
      ) : (
        <ul className="ws-roster-list">
          {members.map((member) => (
            <li className="ws-roster-row" key={member.agentId}>
              <button
                type="button"
                className="ws-roster-identity"
                onClick={() => onSelectAgent(member.agentId)}
              >
                <AgentAvatar agentId={member.agentId} name={member.name} size="sm" />
                <span className="ws-roster-copy">
                  <strong title={member.name}>{member.name}</strong>
                  <span className="ws-roster-status">{member.statusLabel}</span>
                </span>
              </button>
              <span className="ws-roster-role">
                <span className="ws-roster-role-label">Agent role</span>
                <span className="ws-roster-role-value">{member.roleName ?? "No role"}</span>
              </span>
              <button
                type="button"
                className="button button-ghost ws-roster-remove"
                disabled={busy}
                aria-label={`Remove ${member.name} from workspace ${projectName}`}
                onClick={() => onRemove(member.agentId)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Only offered while an Agent is actually left to add. */}
      {addableAgents.length > 0 ? (
        <div className="ws-roster-add">
          <div className="ws-roster-add-head">
            <span className="ws-roster-role-label" id="ws-roster-add-label">
              Add Agents to this room
            </span>
            <span className="ws-roster-add-count" aria-live="polite">
              {selected.length === 0
                ? `${addableAgents.length} available`
                : `${selected.length} selected`}
            </span>
          </div>
          <ul
            className="ws-roster-add-list"
            role="group"
            aria-labelledby="ws-roster-add-label"
          >
            {addableAgents.map((agent) => {
              const checked = selected.includes(agent.id);
              return (
                <li key={agent.id}>
                  <label
                    className={"ws-roster-add-option" + (checked ? " is-checked" : "")}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => toggle(agent.id)}
                    />
                    <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
                    <span className="ws-roster-add-copy">
                      <strong>{agent.name}</strong>
                      {agent.description && <span>{agent.description}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="ws-roster-add-actions">
            {selected.length > 0 && (
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() => setStaged([])}
              >
                Clear
              </button>
            )}
            <button
              type="button"
              className="button button-primary"
              disabled={busy || selected.length === 0}
              onClick={() => {
                onAdd(selected);
                setStaged([]);
              }}
            >
              {busy
                ? "Adding…"
                : selected.length <= 1
                  ? "Add to room"
                  : `Add ${selected.length} Agents`}
            </button>
          </div>
        </div>
      ) : members.length > 0 ? (
        <p className="ws-roster-all">
          <span className="ws-roster-all-check" aria-hidden="true">✓</span>
          Every Agent is already in this room
        </p>
      ) : (
        /* Nothing to add and nobody here: the platform has no Agents yet. */
        <p className="ws-roster-all">Create an Agent to add one to this room.</p>
      )}
    </section>
  );
}
