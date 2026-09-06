import { useId, useMemo, useState } from "react";
import type { AgentSkills, SkillMetadata } from "../types";

function availabilityLabel(value: AgentSkills["skills"][number]["capabilities"][number]["availability"]): string {
  if (value === "available") return "Available";
  return "Denied";
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
  const [query, setQuery] = useState("");
  const searchId = useId();

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((skillId) => skillId !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  /**
   * A skill can arrive from the Agent's own assignment or from its role. Both
   * are active, so both read as checked; only the Agent's own assignment is
   * editable here, because unchecking a role's skill would not remove it.
   */
  const roleSkillIds = useMemo(() => {
    const own = new Set(selectedIds);
    return new Set((assigned?.skillIds ?? []).filter((id) => !own.has(id)));
  }, [assigned, selectedIds]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return catalog;
    return catalog.filter((skill) =>
      skill.name.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle) ||
      skill.id.toLowerCase().includes(needle),
    );
  }, [catalog, query]);

  const activeCount = selectedIds.length + roleSkillIds.size;

  return (
    <section className="agent-skills-panel" aria-labelledby="agent-skills-heading">
      <div className="agent-skills-heading">
        <div>
          <span className="eyebrow">Reusable guidance</span>
          <h3 id="agent-skills-heading">Agent skills</h3>
        </div>
        {loading
          ? <span className="agent-skills-loading">Refreshing…</span>
          : <span className="agent-skills-count">{activeCount} active</span>}
      </div>
      <p className="agent-skills-note">
        Skills add platform guidance only. Required tools are checked against this Agent&apos;s
        role; assigning a skill never grants a capability.
      </p>
      {error && <p className="agent-skills-error" role="alert">{error}</p>}
      <div className="agent-skills-search">
        <label className="visually-hidden" htmlFor={searchId}>Search skills</label>
        <input
          id={searchId}
          type="search"
          value={query}
          placeholder="Search skills…"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="agent-skills-list">
        {matches.map((skill) => {
          const current = assigned?.skills.find((item) => item.id === skill.id);
          const own = selectedIds.includes(skill.id);
          const fromRole = roleSkillIds.has(skill.id);
          const active = own || fromRole;
          return (
            <label className="agent-skill-option" key={skill.id} data-from-role={fromRole}>
              <input
                type="checkbox"
                checked={active}
                // The role owns this one; it is unchecked from the role, not here.
                disabled={disabled || fromRole}
                title={fromRole ? "Supplied by this Agent's role" : undefined}
                onChange={() => toggle(skill.id)}
              />
              <span className="agent-skill-copy">
                <strong>
                  {skill.name}
                  {fromRole && <span className="agent-skill-source">From role</span>}
                </strong>
                <span>{skill.description}</span>
                {skill.requiredToolIds.length > 0 && (
                  <span className="agent-skill-capabilities">
                    Required: {skill.requiredToolIds.join(", ")}
                  </span>
                )}
                {active && current && current.capabilities.length > 0 && (
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
        {!loading && catalog.length > 0 && matches.length === 0 && (
          <span className="agent-skills-empty">No skill matches “{query.trim()}”.</span>
        )}
      </div>
    </section>
  );
}
