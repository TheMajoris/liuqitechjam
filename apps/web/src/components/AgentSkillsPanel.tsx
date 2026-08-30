import type { AgentSkills, SkillMetadata } from "../types";

function availabilityLabel(value: AgentSkills["skills"][number]["capabilities"][number]["availability"]): string {
  if (value === "approval_required") return "Approval required";
  if (value === "available") return "Available";
  return "Unavailable";
}

interface AgentSkillsPanelProps {
  catalog: SkillMetadata[];
  selectedIds: string[];
  assigned: AgentSkills | null;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  onChange: (skillIds: string[]) => void;
}

/** Minimal Agent-global skill assignment UI; capability state stays backend-owned. */
export function AgentSkillsPanel({
  catalog,
  selectedIds,
  assigned,
  loading = false,
  error = null,
  disabled = false,
  onChange,
}: AgentSkillsPanelProps) {
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((skillId) => skillId !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <section className="agent-skills-panel" aria-labelledby="agent-skills-heading">
      <div className="agent-skills-heading">
        <div>
          <span className="eyebrow">Reusable guidance</span>
          <h3 id="agent-skills-heading">Agent skills</h3>
        </div>
        {loading && <span className="agent-skills-loading">Refreshing…</span>}
      </div>
      <p className="agent-skills-note">
        Skills add platform guidance only. Required tools are checked against the current
        Project role and grants; assigning a skill never grants a capability.
      </p>
      {error && <p className="agent-skills-error" role="alert">{error}</p>}
      <div className="agent-skills-list">
        {catalog.map((skill) => {
          const current = assigned?.skills.find((item) => item.id === skill.id);
          const selected = selectedIds.includes(skill.id);
          return (
            <label className="agent-skill-option" key={skill.id}>
              <input
                type="checkbox"
                checked={selected}
                disabled={disabled}
                onChange={() => toggle(skill.id)}
              />
              <span className="agent-skill-copy">
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
                {skill.requiredToolIds.length > 0 && (
                  <span className="agent-skill-capabilities">
                    Required: {skill.requiredToolIds.join(", ")}
                  </span>
                )}
                {selected && current && current.capabilities.length > 0 && (
                  <span className="agent-skill-capabilities">
                    {current.capabilities.map((capability) => (
                      <span className="agent-skill-capability" key={capability.toolId}>
                        {capability.toolId}: {availabilityLabel(capability.availability)}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {!loading && catalog.length === 0 && (
          <span className="agent-skills-empty">No platform skills are configured.</span>
        )}
      </div>
    </section>
  );
}

