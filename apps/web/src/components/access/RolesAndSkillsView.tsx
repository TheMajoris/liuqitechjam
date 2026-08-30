import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { Agent, AgentRole, Project, SkillCatalogEntry, ToolMetadata } from "../../types";

interface Props {
  agents: Agent[];
  projects: Project[];
  onProjectsChanged: () => Promise<void>;
}

const BASE_PERMISSIONS = [
  ["project.read", "Read Project files"],
  ["project.write", "Edit Project files"],
  ["agent.invoke", "Run in the Project"],
  ["project.preview.inspect", "Inspect preview"],
  ["project.preview.logs", "Read preview logs"],
  ["project.preview.start", "Start preview"],
  ["project.preview.restart", "Restart preview"],
  ["project.preview.stop", "Stop preview"],
] as const;

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function RolesAndSkillsView({ agents, projects, onProjectsChanged }: Props) {
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [tools, setTools] = useState<ToolMetadata[]>([]);
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [permissionIds, setPermissionIds] = useState<string[]>(["project.read", "agent.invoke"]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = roles.find((role) => role.id === selectedId) ?? null;
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);

  const refresh = useCallback(async (search = query) => {
    const [roleResult, toolResult, skillResult] = await Promise.all([
      api.listRoles(),
      api.listTools(),
      api.searchSkills(search),
    ]);
    setRoles(roleResult.roles);
    setTools(toolResult.tools);
    setSkills(skillResult.skills);
  }, [query]);

  useEffect(() => {
    void refresh("").catch((reason) => setError(message(reason)));
  }, []); // Initial control-plane load only.

  const edit = (role: AgentRole | null) => {
    setSelectedId(role?.id ?? null);
    setName(role?.name ?? "");
    setDescription(role?.description ?? "");
    setToolIds(role?.toolIds ?? []);
    setSkillIds(role?.skillIds ?? []);
    setPermissionIds(role?.permissionIds ?? ["project.read", "agent.invoke"]);
    setError(null);
  };

  const toggle = (values: string[], value: string, setter: (next: string[]) => void) => {
    setter(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  };

  const save = async () => {
    if (!name.trim()) return;
    if (selected && selected.assignedAgentCount > 0 &&
      !window.confirm(`This changes ${selected.assignedAgentCount} assigned Agent${selected.assignedAgentCount === 1 ? "" : "s"}. Continue?`)) return;
    setBusy(true);
    setError(null);
    try {
      const toolPermissions = tools
        .filter((tool) => toolIds.includes(tool.id))
        .map((tool) => tool.requiredPermission);
      const body = {
        name: name.trim(),
        description: description.trim(),
        toolIds,
        skillIds,
        permissionIds: [...new Set([...permissionIds, ...toolPermissions])],
        ...(selected && selected.assignedAgentCount > 0 ? { confirmPropagation: true } : {}),
      };
      const result = selected
        ? await api.updateRole(selected.id, body)
        : await api.createRole(body);
      await refresh();
      edit(result.role);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected || !window.confirm(`Delete role “${selected.name}”?`)) return;
    setBusy(true);
    try {
      await api.deleteRole(selected.id);
      edit(null);
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const changeAssignment = async (projectId: string, agentId: string, roleId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.assignProjectRole(projectId, agentId, roleId);
      await Promise.all([refresh(), onProjectsChanged()]);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const changeInstall = async (skill: SkillCatalogEntry) => {
    setBusy(true);
    setError(null);
    try {
      if (skill.installed) await api.uninstallSkill(skill.id);
      else await api.installSkill(skill.id);
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="access-view">
      <header className="access-head">
        <div>
          <span className="eyebrow">Access design</span>
          <h1>Roles &amp; skills</h1>
          <p>Roles are reusable presets of Project permissions, tools, and installed skills.</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => edit(null)}>New role</button>
      </header>

      {error && <div className="error-banner" role="alert"><span>{error}</span></div>}

      <div className="access-grid">
        <section className="access-card role-list-card">
          <h2>Role presets</h2>
          <div className="access-role-list">
            {roles.map((role) => (
              <button key={role.id} type="button" className={selectedId === role.id ? "selected" : ""} onClick={() => edit(role)}>
                <strong>{role.name}</strong>
                <span>{role.toolIds.length} tools · {role.skillIds.length} skills · {role.assignedAgentCount} Agents</span>
              </button>
            ))}
          </div>
        </section>

        <section className="access-card role-editor-card">
          <div className="access-card-title">
            <h2>{selected ? `Edit ${selected.name}` : "Create a role"}</h2>
            {selected?.source === "system" && <span className="access-pill">Migrated preset</span>}
          </div>
          <label>Role name<input value={name} disabled={selected?.source === "system"} onChange={(event) => setName(event.target.value)} /></label>
          <label>Description<textarea value={description} disabled={selected?.source === "system"} onChange={(event) => setDescription(event.target.value)} /></label>

          <fieldset disabled={selected?.source === "system" || busy}>
            <legend>Project access</legend>
            {BASE_PERMISSIONS.map(([id, label]) => (
              <label className="access-check" key={id}><input type="checkbox" checked={permissionIds.includes(id)} onChange={() => toggle(permissionIds, id, setPermissionIds)} /><span>{label}</span></label>
            ))}
          </fieldset>
          <fieldset disabled={selected?.source === "system" || busy}>
            <legend>Tools</legend>
            {tools.map((tool) => (
              <label className="access-check" key={tool.id}><input type="checkbox" checked={toolIds.includes(tool.id)} onChange={() => toggle(toolIds, tool.id, setToolIds)} /><span><strong>{tool.title}</strong><small>{tool.description}</small></span></label>
            ))}
          </fieldset>
          <fieldset disabled={selected?.source === "system" || busy}>
            <legend>Installed skills</legend>
            {skills.filter((skill) => skill.installed).map((skill) => (
              <label className="access-check" key={skill.id}><input type="checkbox" checked={skillIds.includes(skill.id)} onChange={() => toggle(skillIds, skill.id, setSkillIds)} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>
            ))}
          </fieldset>
          {selected?.source !== "system" && <div className="access-actions">
            <button type="button" className="button button-primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save role"}</button>
            {selected && <button type="button" className="button button-danger" disabled={busy || selected.assignedAgentCount > 0} onClick={() => void remove()}>Delete</button>}
          </div>}
        </section>

        <section className="access-card assignments-card">
          <h2>Project assignments</h2>
          <p>Each Agent gets exactly one role in each Project.</p>
          {projects.map((project) => (
            <div className="assignment-project" key={project.id}>
              <strong>{project.name}</strong>
              {(project.memberships ?? project.agentIds.map((agentId) => ({ agentId, role: "editor" as const }))).map((membership) => (
                <label key={membership.agentId}><span>{agentNames.get(membership.agentId) ?? membership.agentId}</span><select disabled={busy} value={("roleId" in membership ? membership.roleId : undefined) ?? `legacy-${membership.role}`} onChange={(event) => void changeAssignment(project.id, membership.agentId, event.target.value)}>
                  {roles.map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}
                </select></label>
              ))}
            </div>
          ))}
        </section>

        <section className="access-card skills-card">
          <div className="access-card-title"><div><h2>Find skills</h2><p>Instruction-only skills never install code or grant tools.</p></div></div>
          <form onSubmit={(event) => { event.preventDefault(); void refresh(query); }} className="skill-search">
            <input aria-label="Search skills" placeholder="Search by name or capability" value={query} onChange={(event) => setQuery(event.target.value)} />
            <button type="submit" className="button button-ghost">Search</button>
          </form>
          <div className="skill-catalog-list">
            {skills.map((skill) => <div key={skill.id} className="skill-catalog-row"><div><strong>{skill.name}</strong><span>{skill.description}</span><small>{skill.capabilityTags.join(" · ")}</small></div>{skill.source === "built-in" ? <span className="access-pill">Built in</span> : <button type="button" className="button button-ghost" disabled={busy} onClick={() => void changeInstall(skill)}>{skill.installed ? "Uninstall" : "Install"}</button>}</div>)}
          </div>
        </section>
      </div>
    </div>
  );
}
