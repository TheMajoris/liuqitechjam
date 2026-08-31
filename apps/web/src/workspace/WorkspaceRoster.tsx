import type { AgentRole } from "../types";
import { AgentAvatar } from "../components/orchestration/AgentAvatar";

export interface WorkspaceRosterMember {
  agentId: string;
  name: string;
  /** Role applied inside this Workspace, already resolved from the membership. */
  roleId: string;
  statusLabel: string;
  /** False when the membership points at an Agent that no longer exists. */
  available: boolean;
}

export interface WorkspaceRosterAddable {
  id: string;
  name: string;
}

interface WorkspaceRosterProps {
  projectName: string;
  members: WorkspaceRosterMember[];
  roles: AgentRole[];
  addableAgents: WorkspaceRosterAddable[];
  busy: boolean;
  error: string | null;
  onAssignRole: (agentId: string, roleId: string) => void;
  onRemove: (agentId: string) => void;
  onAdd: (agentId: string) => void;
  onSelectAgent: (agentId: string) => void;
}

/**
 * Who is in the room and what each of them is allowed to do.
 *
 * The same Workspace override the Assignments tab edits, surfaced where the
 * work happens. Every control here calls a route the backend already exposes;
 * the panel never decides access on its own, it only shows and forwards.
 */
export function WorkspaceRoster({
  projectName,
  members,
  roles,
  addableAgents,
  busy,
  error,
  onAssignRole,
  onRemove,
  onAdd,
  onSelectAgent,
}: WorkspaceRosterProps) {
  return (
    <section className="ws-roster" aria-label={`Agents in ${projectName}`}>
      <header className="ws-roster-head">
        <div>
          <span className="ws-roster-kicker">In this room</span>
          <h3>Workspace roles</h3>
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
              <label className="ws-roster-role">
                <span className="ws-roster-role-label">Workspace role</span>
                <select
                  aria-label={`Workspace role for ${member.name} in ${projectName}`}
                  value={member.roleId}
                  disabled={busy || roles.length === 0 || !member.available}
                  onChange={(event) => onAssignRole(member.agentId, event.target.value)}
                >
                  {roles.map((role) => (
                    <option value={role.id} key={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
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
        <label className="ws-roster-add">
          <span className="ws-roster-role-label">Add an Agent to this room</span>
          <select
            aria-label={`Add an Agent to workspace ${projectName}`}
            value=""
            disabled={busy}
            onChange={(event) => {
              const agentId = event.target.value;
              if (agentId) onAdd(agentId);
            }}
          >
            <option value="">Choose an Agent…</option>
            {addableAgents.map((agent) => (
              <option value={agent.id} key={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
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
