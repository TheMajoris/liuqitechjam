import { useState } from "react";
import { api } from "../../api/client";
import type { Agent, Project } from "../../api/contracts";
import { Spinner } from "../../shared/ui/states";

const ROLES = [
  {
    key: "plannerAgentId",
    label: "Planner",
    note: "Read-only. Produces the bounded implementation plan.",
  },
  {
    key: "builderAgentId",
    label: "Builder",
    note: "Sole workspace writer. Applies the change.",
  },
  {
    key: "reviewerAgentId",
    label: "Reviewer",
    note: "Read-only. Inspects the workspace and reports.",
  },
] as const;

type RoleKey = (typeof ROLES)[number]["key"];

export function CreateProjectForm({
  agents,
  onCreated,
  onCancel,
}: {
  agents: Agent[];
  onCreated: (project: Project) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [roles, setRoles] = useState<Record<RoleKey, string>>({
    plannerAgentId: "",
    builderAgentId: "",
    reviewerAgentId: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = Object.values(roles).filter(Boolean);
  const distinct = new Set(chosen).size === chosen.length;
  const complete = name.trim() !== "" && chosen.length === 3 && distinct;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!complete) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        roles: {
          plannerAgentId: roles.plannerAgentId,
          builderAgentId: roles.builderAgentId,
          reviewerAgentId: roles.reviewerAgentId,
        },
      });
      onCreated(project);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel form-panel" onSubmit={submit} aria-label="Create project">
      <h2>New project</h2>
      <p className="panel-lead">
        A project binds three distinct agents to the fixed pipeline and owns one
        shared workspace.
      </p>

      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field-row">
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
          />
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
          />
        </label>
      </div>

      <fieldset className="role-grid">
        <legend>Role assignments</legend>
        {ROLES.map((role) => (
          <label className="field" key={role.key}>
            <span>{role.label}</span>
            <select
              value={roles[role.key]}
              onChange={(e) =>
                setRoles((prev) => ({ ...prev, [role.key]: e.target.value }))
              }
              required
            >
              <option value="">Select an agent…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <span className="field-note">{role.note}</span>
          </label>
        ))}
      </fieldset>

      {!distinct ? (
        <p className="inline-error" role="alert">
          Planner, Builder and Reviewer must be three different agents.
        </p>
      ) : null}
      {agents.length < 3 ? (
        <p className="field-note">
          You need at least three agents before a project can be created.
        </p>
      ) : null}

      <div className="panel-actions">
        <button
          type="button"
          className="button button-ghost"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="button button-primary"
          disabled={busy || !complete}
        >
          {busy ? <Spinner label="Creating" /> : "Create project"}
        </button>
      </div>
    </form>
  );
}
