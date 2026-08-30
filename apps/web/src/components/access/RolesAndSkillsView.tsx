import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../api";
import { AgentAvatar } from "../orchestration/AgentAvatar";
import type {
  Agent,
  AgentRole,
  Project,
  ProjectMembership,
  SkillCatalogEntry,
  SkillDiscoveryResult,
  ToolMetadata,
} from "../../types";

interface Props {
  agents: Agent[];
  projects: Project[];
  onProjectsChanged: () => Promise<void>;
}

type AccessTab = "roles" | "assignments" | "skills";
type SkillLibraryFilter = "all" | "installed" | "discoverable";

interface RoleDraft {
  name: string;
  description: string;
  toolIds: string[];
  skillIds: string[];
  permissionIds: string[];
}

const MAX_MARKDOWN_BYTES = 64 * 1024;
const UUID_PROJECT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BASE_PERMISSIONS = [
  ["project.read", "Read workspace files", "Open files and inspect the shared Workspace."],
  ["project.write", "Edit workspace files", "Create, edit, and remove files in the Workspace."],
  ["agent.invoke", "Run in the Workspace", "Run Agent work against the shared Workspace."],
  ["project.preview.inspect", "Inspect preview", "Read the current preview status and URL."],
  ["project.preview.logs", "Read preview logs", "Read bounded logs from the Workspace preview."],
  ["project.preview.start", "Start preview", "Start the shared Workspace preview server."],
  ["project.preview.restart", "Restart preview", "Restart the shared Workspace preview server."],
  ["project.preview.stop", "Stop preview", "Stop the shared Workspace preview server."],
] as const;

const LEGACY_ROLE_IDS = {
  owner: "legacy-owner",
  editor: "legacy-editor",
  viewer: "legacy-viewer",
} as const;

const TABS: Array<{ id: AccessTab; label: string; description: string }> = [
  { id: "roles", label: "Roles", description: "Reusable access presets" },
  { id: "assignments", label: "Assignments", description: "Workspace membership" },
  { id: "skills", label: "Skill library", description: "Instruction-only guidance" },
];

function emptyDraft(): RoleDraft {
  return {
    name: "",
    description: "",
    toolIds: [],
    skillIds: [],
    permissionIds: ["project.read", "agent.invoke"],
  };
}

function draftFromRole(role: AgentRole): RoleDraft {
  return {
    name: role.name,
    description: role.description,
    toolIds: [...role.toolIds],
    skillIds: [...role.skillIds],
    permissionIds: [...role.permissionIds],
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function membershipsFor(project: Project): ProjectMembership[] {
  const memberships = Array.isArray(project.memberships)
    ? project.memberships.filter((membership) => typeof membership?.agentId === "string" && membership.agentId.trim().length > 0)
    : [];
  const source = memberships.length > 0
      ? memberships
    : (Array.isArray(project.agentIds) ? project.agentIds : [])
      .filter((agentId): agentId is string => typeof agentId === "string" && agentId.trim().length > 0)
      .map((agentId): ProjectMembership => ({ agentId, role: "editor" }));
  // The API enforces one attachment per Agent/Workspace pair. Deduping the
  // projection keeps a stale or legacy payload from rendering an Agent twice.
  const seen = new Set<string>();
  return source.filter((membership) => {
    if (seen.has(membership.agentId)) return false;
    seen.add(membership.agentId);
    return true;
  });
}

function isDisplayableProject(project: Project): boolean {
  const name = typeof project.name === "string" ? project.name.trim() : "";
  return name.length > 0 && !UUID_PROJECT_NAME.test(name);
}

function sourceLabel(skill: SkillCatalogEntry): string {
  if (skill.source === "built-in") return "Built in";
  if (skill.source === "user") return "Imported";
  return skill.installed ? "Installed" : "Catalog";
}

function domainFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web result";
  }
}

export function RolesAndSkillsView({ agents, projects, onProjectsChanged }: Props) {
  const [tab, setTab] = useState<AccessTab>("roles");
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [tools, setTools] = useState<ToolMetadata[]>([]);
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([]);
  const [librarySkills, setLibrarySkills] = useState<SkillCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RoleDraft>(emptyDraft);
  const [skillQuery, setSkillQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<SkillLibraryFilter>("all");
  const [importUrl, setImportUrl] = useState("");
  const [discoverQuery, setDiscoverQuery] = useState("");
  const [discoveryResults, setDiscoveryResults] = useState<SkillDiscoveryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = roles.find((role) => role.id === selectedId) ?? null;
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  /** Active Workspaces are the available scope for nested Agent memberships. */
  const visibleWorkspaces = useMemo(() => {
    const rows = projects
      .filter((project) => project.status === "active" && isDisplayableProject(project))
      .map((project) => ({ project }));
    // Two Workspaces may share a name. Only then is a discriminator shown, so
    // the common case stays clean while every control still targets an ID.
    const nameCounts = new Map<string, number>();
    for (const { project } of rows) {
      nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
    }
    return rows.map((row) => ({
      ...row,
      duplicateName: (nameCounts.get(row.project.name) ?? 0) > 1,
    }));
  }, [projects]);

  /** One row per complete Agent roster, including Agents with no memberships. */
  const assignmentRows = useMemo(() => {
    const membershipsByAgent = new Map<string, Array<{
      project: Project;
      membership: ProjectMembership;
      duplicateName: boolean;
    }>>();
    for (const { project, duplicateName } of visibleWorkspaces) {
      for (const membership of membershipsFor(project)) {
        if (!agentNames.has(membership.agentId)) continue;
        const memberships = membershipsByAgent.get(membership.agentId) ?? [];
        // This second guard protects against duplicate IDs from mixed legacy
        // fields even when the workspace projection was malformed.
        if (!memberships.some((item) => item.project.id === project.id)) {
          memberships.push({ project, membership, duplicateName });
        }
        membershipsByAgent.set(membership.agentId, memberships);
      }
    }
    return [...agentNames.values()].map((agent) => ({
      agent,
      memberships: membershipsByAgent.get(agent.id) ?? [],
    }));
  }, [agentNames, visibleWorkspaces]);

  const installedSkills = useMemo(
    () => librarySkills.filter((skill) => skill.installed || skill.source === "built-in"),
    [librarySkills],
  );
  const discoverableSkills = useMemo(
    () => librarySkills.filter((skill) => !skill.installed && skill.source !== "built-in"),
    [librarySkills],
  );
  const installedCount = skills.filter((skill) => skill.installed || skill.source === "built-in").length;

  const refreshRoleAndCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const [roleResult, toolResult, skillResult] = await Promise.all([
        api.listRoles(),
        api.listTools(),
        api.searchSkills(""),
      ]);
      setRoles(roleResult.roles);
      setTools(toolResult.tools);
      setSkills(skillResult.skills);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLibrary = useCallback(async (query: string, filter: SkillLibraryFilter) => {
    setLibraryLoading(true);
    try {
      const installed = filter === "installed" ? true : filter === "discoverable" ? false : undefined;
      const result = await api.searchSkills(query, installed);
      setLibrarySkills(result.skills);
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      refreshRoleAndCatalog(),
      fetchLibrary("", "all"),
    ]).catch((reason) => setError(errorMessage(reason)));
  }, [fetchLibrary, refreshRoleAndCatalog]);

  useEffect(() => {
    if (creating) return;
    const role = (selectedId ? roles.find((item) => item.id === selectedId) : undefined) ?? roles[0];
    if (!role) {
      setSelectedId(null);
      setDraft(emptyDraft());
      return;
    }
    if (role.id !== selectedId) setSelectedId(role.id);
    setDraft(draftFromRole(role));
  }, [creating, roles, selectedId]);

  const openRole = (role: AgentRole | null) => {
    setTab("roles");
    setError(null);
    setNotice(null);
    setCreating(role === null);
    setSelectedId(role?.id ?? null);
    setDraft(role ? draftFromRole(role) : emptyDraft());
  };

  const toggleDraftValue = (field: "permissionIds" | "toolIds" | "skillIds", value: string) => {
    setDraft((current) => ({
      ...current,
      [field]: current[field].includes(value)
        ? current[field].filter((item) => item !== value)
        : [...current[field], value],
    }));
  };

  const saveRole = async () => {
    if (!draft.name.trim()) return;
    if (selected?.source === "system") return;
    if (
      selected &&
      selected.assignedAgentCount > 0 &&
      !window.confirm(
        `This changes ${selected.assignedAgentCount} assigned Agent${selected.assignedAgentCount === 1 ? "" : "s"}. Continue?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const toolPermissions = tools
        .filter((tool) => draft.toolIds.includes(tool.id))
        .map((tool) => tool.requiredPermission);
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        toolIds: draft.toolIds,
        skillIds: draft.skillIds,
        permissionIds: [...new Set([...draft.permissionIds, ...toolPermissions])],
        ...(selected && selected.assignedAgentCount > 0 ? { confirmPropagation: true } : {}),
      };
      const result = creating
        ? await api.createRole(body)
        : await api.updateRole(selected!.id, body);
      setCreating(false);
      setSelectedId(result.role.id);
      setDraft(draftFromRole(result.role));
      await refreshRoleAndCatalog();
      await fetchLibrary(skillQuery, libraryFilter);
      setNotice(creating ? "Role created." : "Role updated.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeRole = async () => {
    if (!selected || selected.source === "system" || selected.assignedAgentCount > 0) return;
    if (!window.confirm(`Delete role “${selected.name}”?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteRole(selected.id);
      setCreating(false);
      setSelectedId(null);
      await refreshRoleAndCatalog();
      setNotice("Role deleted.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Arrow-key movement inside the tablist, as the tab pattern requires.
   * Focus follows selection, so the matching panel is announced immediately.
   */
  const moveTab = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: TABS.length - 1,
    };
    const target = keys[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = TABS[(target + TABS.length) % TABS.length];
    if (!next) return;
    setTab(next.id);
    document.getElementById(`${next.id}-tab`)?.focus();
  };

  const attachAgent = async (projectId: string, agentId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.attachProjectAgent(projectId, agentId);
      await onProjectsChanged();
      setNotice("Agent added to workspace.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const detachAgent = async (projectId: string, agentId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.detachProjectAgent(projectId, agentId);
      await onProjectsChanged();
      setNotice("Agent removed from workspace.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const changeAssignment = async (projectId: string, agentId: string, roleId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.assignProjectRole(projectId, agentId, roleId);
      await Promise.all([refreshRoleAndCatalog(), onProjectsChanged()]);
      setNotice("Assignment updated.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const refreshAfterSkillChange = async () => {
    await Promise.all([
      refreshRoleAndCatalog(),
      fetchLibrary(skillQuery, libraryFilter),
    ]);
  };

  const changeInstall = async (skill: SkillCatalogEntry) => {
    if (skill.source === "built-in") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (skill.installed) {
        await api.uninstallSkill(skill.id);
        setNotice(`${skill.name} removed from the library.`);
      } else {
        await api.installSkill(skill.id);
        setNotice(`${skill.name} installed.`);
      }
      await refreshAfterSkillChange();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const importMarkdown = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset immediately so selecting the same file after an error retries.
    event.target.value = "";
    if (!file) return;
    if (!/\.(md|markdown)$/i.test(file.name)) {
      setError("Choose a Markdown file (.md or .markdown).");
      return;
    }
    if (file.size > MAX_MARKDOWN_BYTES) {
      setError("Markdown files must be 64 KB or smaller.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const markdown = await file.text();
      if (new TextEncoder().encode(markdown).byteLength > MAX_MARKDOWN_BYTES) {
        throw new Error("Markdown files must be 64 KB or smaller.");
      }
      await api.importSkillFromMarkdown(markdown, file.name);
      await refreshAfterSkillChange();
      setNotice(`${file.name} imported as a skill.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const importFromUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = importUrl.trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.importSkillFromUrl(url);
      await refreshAfterSkillChange();
      setImportUrl("");
      setNotice("Skill imported from URL.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const discoverOnWeb = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = discoverQuery.trim();
    if (query.length < 2) {
      setError("Enter at least 2 characters to search the web.");
      return;
    }
    setDiscoverLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.discoverSkills(query);
      setDiscoveryResults(result.results);
      setNotice(result.results.length > 0 ? `${result.results.length} web candidates found.` : "No web candidates found.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDiscoverLoading(false);
    }
  };

  const importDiscoveryResult = async (result: SkillDiscoveryResult) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.importSkillFromUrl(result.url);
      await refreshAfterSkillChange();
      setNotice(`${result.title} imported.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const searchLibrary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await fetchLibrary(skillQuery, libraryFilter);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const selectLibraryFilter = (filter: SkillLibraryFilter) => {
    setLibraryFilter(filter);
    setError(null);
    void fetchLibrary(skillQuery, filter).catch((reason) => setError(errorMessage(reason)));
  };

  return (
    <div className="access-view">
      <header className="access-head">
        <div className="access-head-copy">
          <span className="eyebrow">Access control</span>
          <h1>Roles &amp; skills</h1>
          <p>Shape what each Agent can do in a shared Workspace, then reuse that setup everywhere.</p>
        </div>
        <dl className="access-head-stats" aria-label="Access summary">
          <div>
            <dt>Roles</dt>
            <dd>{roles.length}</dd>
          </div>
          <div>
            <dt>Workspaces</dt>
            <dd>{visibleWorkspaces.length}</dd>
          </div>
          <div>
            <dt>Skills</dt>
            <dd>{installedCount}</dd>
          </div>
        </dl>
      </header>

      <nav className="access-tabs" aria-label="Roles and skills sections" role="tablist">
        {TABS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${item.id}-tab`}
            aria-selected={tab === item.id}
            aria-controls={`access-panel-${item.id}`}
            // Roving tabindex: the tablist is one stop, arrows move within it.
            tabIndex={tab === item.id ? 0 : -1}
            className={tab === item.id ? "is-active" : ""}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => moveTab(event, index)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {(error || notice) && (
        <div
          className={`access-notice ${error ? "is-error" : "is-success"}`}
          role={error ? "alert" : "status"}
          aria-live="polite"
        >
          <span aria-hidden="true">{error ? "!" : "✓"}</span>
          <p>{error ?? notice}</p>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      {tab === "roles" && (
        <div id="access-panel-roles" className="access-tab-panel role-layout" role="tabpanel" aria-labelledby="roles-tab">
          <section className="access-card role-index-card" aria-labelledby="role-list-title">
            <div className="access-section-heading">
              <div>
                <span className="access-kicker">Presets</span>
                <h2 id="role-list-title">Roles</h2>
              </div>
              <span className="access-count">{roles.length}</span>
            </div>
            <p className="access-muted">One reusable boundary for Workspace access, tools, and skills.</p>
            <button type="button" className="button button-primary role-new-button" onClick={() => openRole(null)}>
              <span aria-hidden="true">＋</span> New role
            </button>
            <div className="access-role-list" aria-label="Role presets">
              {loading && roles.length === 0 ? (
                <p className="access-empty-inline">Loading roles…</p>
              ) : roles.length === 0 ? (
                <p className="access-empty-inline">No roles yet. Create one to get started.</p>
              ) : (
                roles.map((role) => (
                  <button
                    key={role.id}
                    type="button"
                    className={selectedId === role.id && !creating ? "is-selected" : ""}
                    onClick={() => openRole(role)}
                  >
                    <span className="access-role-title"><strong>{role.name}</strong>{role.source === "system" && <span className="access-mini-tag">Preset</span>}</span>
                    <span className="access-role-meta">
                      {role.permissionIds.length} permissions · {role.toolIds.length} tools · {role.skillIds.length} skills
                    </span>
                    <span className="access-role-meta">{role.assignedAgentCount} assigned Agent{role.assignedAgentCount === 1 ? "" : "s"}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="access-card role-editor-card" aria-labelledby="role-editor-title">
            {selected?.source === "system" && !creating ? (
              <RoleSummary role={selected} />
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRole();
                }}
                className="role-form"
              >
                <div className="access-section-heading role-editor-heading">
                  <div>
                    <span className="access-kicker">{creating ? "New preset" : "Custom preset"}</span>
                    <h2 id="role-editor-title">{creating ? "Create a role" : `Edit ${selected?.name ?? "role"}`}</h2>
                  </div>
                  {!creating && selected && <span className="access-mini-tag is-purple">{selected.assignedAgentCount} assigned</span>}
                </div>

                <fieldset className="role-form-card role-details-card" disabled={busy}>
                  <legend>Details</legend>
                  <label className="access-field">
                    <span>Role name</span>
                    <input value={draft.name} maxLength={80} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} autoComplete="off" />
                  </label>
                  <label className="access-field">
                    <span>Description <em>Optional</em></span>
                    <textarea value={draft.description} maxLength={500} rows={2} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
                  </label>
                </fieldset>

                <div className="role-option-grid">
                  <fieldset className="role-form-card" disabled={busy}>
                    <legend>Workspace access</legend>
                    <p className="role-card-hint">Explicit permissions are the only access boundary.</p>
                    <div className="access-option-list">
                      {BASE_PERMISSIONS.map(([id, title, description]) => (
                        <label className="access-option" key={id}>
                          <input type="checkbox" checked={draft.permissionIds.includes(id)} onChange={() => toggleDraftValue("permissionIds", id)} />
                          <span><strong>{title}</strong><small>{description}</small></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset className="role-form-card" disabled={busy}>
                    <legend>Tools</legend>
                    <p className="role-card-hint">Tools never grant permissions by themselves.</p>
                    <div className="access-option-list">
                      {tools.length === 0 ? <p className="access-empty-inline">No tools available.</p> : tools.map((tool) => (
                        <label className="access-option" key={tool.id}>
                          <input type="checkbox" checked={draft.toolIds.includes(tool.id)} onChange={() => toggleDraftValue("toolIds", tool.id)} />
                          <span><strong>{tool.title}</strong><small>{tool.description}</small></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset className="role-form-card role-skills-card" disabled={busy}>
                    <legend>Skills</legend>
                    <p className="role-card-hint">Instruction-only guidance. It never installs code or grants tools.</p>
                    <div className="access-option-list">
                      {skills.filter((skill) => skill.installed || skill.source === "built-in").length === 0 ? (
                        <div className="access-empty-inline">No skills installed. <button type="button" className="access-inline-link" onClick={() => setTab("skills")}>Browse the library</button></div>
                      ) : skills.filter((skill) => skill.installed || skill.source === "built-in").map((skill) => (
                        <label className="access-option" key={skill.id}>
                          <input type="checkbox" checked={draft.skillIds.includes(skill.id)} onChange={() => toggleDraftValue("skillIds", skill.id)} />
                          <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>

                <div className="access-actions role-save-actions">
                  <button type="submit" className="button button-primary" disabled={busy || !draft.name.trim()}>{busy ? "Saving…" : creating ? "Create role" : "Save changes"}</button>
                  {!creating && selected && <button type="button" className="button button-danger" disabled={busy || selected.assignedAgentCount > 0} onClick={() => void removeRole()}>Delete role</button>}
                  {!creating && selected?.assignedAgentCount ? <span className="access-action-note">Assigned roles update all linked Agents.</span> : null}
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      {tab === "assignments" && (
        <section id="access-panel-assignments" className="access-tab-panel assignments-panel" role="tabpanel" aria-labelledby="assignments-tab">
          <div className="access-panel-heading">
            <div>
              <span className="access-kicker">Agent roster</span>
              <h2>Assignments</h2>
              <p>
                Each Agent appears once. Workspaces and roles are nested beneath
                them, including Agents that are not assigned yet.
              </p>
            </div>
            <span className="access-count-label">{assignmentRows.length} Agent{assignmentRows.length === 1 ? "" : "s"}</span>
          </div>

          {assignmentRows.length === 0 ? (
            <div className="access-empty-state">
              <span className="access-empty-icon" aria-hidden="true">⌁</span>
              <h3>No Agents yet</h3>
              <p>Create an Agent to manage its Workspace memberships here.</p>
            </div>
          ) : (
            <div className="assignment-list">
              {assignmentRows.map(({ agent, memberships }) => {
                const assignedWorkspaceIds = new Set(memberships.map(({ project }) => project.id));
                const addableWorkspaces = visibleWorkspaces.filter(({ project }) => !assignedWorkspaceIds.has(project.id));
                return (
                  <article className="access-card assignment-card assignment-agent-card" key={agent.id}>
                    <header className="assignment-card-heading">
                      <div className="assignment-agent-heading">
                        <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
                        <div className="assignment-card-title">
                          <h3>{agent.name}</h3>
                          <span className="assignment-agent-status">
                            {agent.status === "busy" ? "Working" : agent.status === "stopped" ? "Stopped" : agent.status === "error" ? "Needs attention" : "Available"}
                          </span>
                        </div>
                      </div>
                      <label className="assignment-add-field">
                        <span className="sr-only">Add {agent.name} to workspace</span>
                        <select
                          aria-label={`Add ${agent.name} to workspace`}
                          value=""
                          disabled={busy || addableWorkspaces.length === 0}
                          onChange={(event) => {
                            const projectId = event.target.value;
                            if (projectId) void attachAgent(projectId, agent.id);
                          }}
                        >
                          <option value="">{addableWorkspaces.length === 0 ? "All workspaces assigned" : "Add to workspace…"}</option>
                          {addableWorkspaces.map(({ project, duplicateName }) => (
                            <option value={project.id} key={project.id}>
                              {project.name}{duplicateName ? ` · ${project.id.slice(0, 8)}` : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    </header>
                    <div className="assignment-workspace-list">
                      {memberships.length === 0 ? (
                        <p className="assignment-empty">Not assigned to a workspace</p>
                      ) : memberships.map(({ project, membership, duplicateName }) => {
                        const roleId = membership.roleId ?? LEGACY_ROLE_IDS[membership.role];
                        return (
                          <div className="assignment-workspace-row" key={project.id}>
                            <div className="assignment-workspace-copy">
                              <strong>{project.name}</strong>
                              {duplicateName && <code className="assignment-discriminator" title={project.id}>{project.id.slice(0, 8)}</code>}
                            </div>
                            <label className="assignment-role-field">
                              <span className="sr-only">Role for {agent.name} in {project.name}</span>
                              <select disabled={busy || roles.length === 0} value={roleId} onChange={(event) => void changeAssignment(project.id, agent.id, event.target.value)}>
                                {roles.map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="button button-ghost assignment-remove"
                              disabled={busy}
                              aria-label={`Remove ${agent.name} from workspace ${project.name}`}
                              onClick={() => void detachAgent(project.id, agent.id)}
                            >
                              Remove
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tab === "skills" && (
        <div id="access-panel-skills" className="access-tab-panel skills-panel" role="tabpanel" aria-labelledby="skills-tab">
          <section className="access-card skill-import-card" aria-labelledby="skill-import-title">
            <div className="access-panel-heading compact">
              <div>
                <span className="access-kicker">Bring your own guidance</span>
                <h2 id="skill-import-title">Import a skill</h2>
                <p>Skills are instruction-only Markdown. Importing never executes code or grants tools.</p>
              </div>
            </div>
            <div className="skill-import-actions">
              <input ref={fileInputRef} className="sr-only" type="file" accept=".md,.markdown,text/markdown" onChange={(event) => void importMarkdown(event)} />
              <button type="button" className="button button-primary" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                <span aria-hidden="true">↑</span> Upload .md
              </button>
              <span className="skill-import-or" aria-hidden="true">or</span>
              <form className="skill-url-form" onSubmit={(event) => void importFromUrl(event)}>
                <label className="sr-only" htmlFor="skill-url">Markdown or GitHub URL</label>
                <input id="skill-url" type="url" inputMode="url" placeholder="Paste a Markdown or GitHub URL" value={importUrl} onChange={(event) => setImportUrl(event.target.value)} disabled={busy} />
                <button type="submit" className="button button-ghost" disabled={busy || !importUrl.trim()}>Import URL</button>
              </form>
            </div>
            <p className="skill-import-note">Maximum 64 KB. GitHub file links are normalized server-side; the backend validates remote URLs.</p>
          </section>

          <section className="access-card skill-library-card" aria-labelledby="skill-library-title">
            <div className="access-panel-heading skill-library-heading">
              <div>
                <span className="access-kicker">Local catalog</span>
                <h2 id="skill-library-title">Skill library</h2>
                <p>Install only the guidance you want your roles to use.</p>
              </div>
              <span className="access-safety-chip"><span aria-hidden="true">✓</span> Instruction-only</span>
            </div>
            <form className="skill-search-form" onSubmit={(event) => void searchLibrary(event)}>
              <label className="sr-only" htmlFor="skill-search">Search installed and discoverable skills</label>
              <span className="skill-search-icon" aria-hidden="true">⌕</span>
              <input id="skill-search" placeholder="Search by name, capability, or tag" value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} />
              <button type="submit" className="button button-ghost" disabled={libraryLoading}>{libraryLoading ? "Searching…" : "Search"}</button>
            </form>
            <div className="skill-filter-row" role="group" aria-label="Skill library filter">
              {(["all", "installed", "discoverable"] as const).map((filter) => (
                <button key={filter} type="button" className={libraryFilter === filter ? "is-selected" : ""} aria-pressed={libraryFilter === filter} onClick={() => selectLibraryFilter(filter)}>
                  {filter === "all" ? "All skills" : filter === "installed" ? "Installed" : "Discoverable"}
                </button>
              ))}
            </div>

            {libraryLoading && librarySkills.length === 0 ? <p className="access-loading">Loading library…</p> : (
              <div className="skill-library-sections">
                <SkillList title="Installed" skills={installedSkills} busy={busy} onToggle={changeInstall} emptyLabel="No installed skills yet." />
                <SkillList title="Discoverable" skills={discoverableSkills} busy={busy} onToggle={changeInstall} emptyLabel="No discoverable skills match this search." />
              </div>
            )}
          </section>

          <section className="access-card skill-discovery-card" aria-labelledby="skill-discovery-title">
            <div className="access-panel-heading compact">
              <div>
                <span className="access-kicker">Bounded web search</span>
                <h2 id="skill-discovery-title">Find a skill on the web</h2>
                <p>Search returns candidates only. Review a result, then import it explicitly.</p>
              </div>
            </div>
            <form className="skill-discovery-form" onSubmit={(event) => void discoverOnWeb(event)}>
              <label className="sr-only" htmlFor="skill-discovery-search">Search the web for a skill</label>
              <input id="skill-discovery-search" minLength={2} placeholder="Try “React testing” or “API design”" value={discoverQuery} onChange={(event) => setDiscoverQuery(event.target.value)} />
              <button type="submit" className="button button-ghost" disabled={discoverLoading || discoverQuery.trim().length < 2}>{discoverLoading ? "Searching…" : "Search web"}</button>
            </form>
            {discoveryResults.length > 0 && (
              <div className="skill-discovery-results" aria-live="polite">
                {discoveryResults.map((result) => (
                  <article className="skill-discovery-result" key={result.url}>
                    <div>
                      <h3>{result.title}</h3>
                      <span className="skill-result-domain">{result.domain || domainFor(result.url)}</span>
                      <p>{result.description}</p>
                    </div>
                    <button type="button" className="button button-ghost" disabled={busy} onClick={() => void importDiscoveryResult(result)}>Import</button>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function RoleSummary({ role }: { role: AgentRole }) {
  return (
    <div className="role-summary">
      <div className="access-section-heading role-editor-heading">
        <div>
          <span className="access-kicker">Compatibility preset</span>
          <h2 id="role-editor-title">{role.name}</h2>
        </div>
        <span className="access-mini-tag">Read only</span>
      </div>
      <p className="role-summary-copy">{role.description || "This preset preserves a legacy Workspace membership boundary."}</p>
      <div className="role-summary-note"><span aria-hidden="true">i</span><p>This migrated preset mirrors legacy Owner, Editor, or Viewer access. Create a new role if you need to customize it.</p></div>
      <div className="role-summary-grid">
        <SummaryMetric label="Permissions" value={role.permissionIds.length} items={role.permissionIds} />
        <SummaryMetric label="Tools" value={role.toolIds.length} items={role.toolIds} />
        <SummaryMetric label="Skills" value={role.skillIds.length} items={role.skillIds} />
      </div>
      <p className="role-summary-assignment">Assigned to {role.assignedAgentCount} Agent{role.assignedAgentCount === 1 ? "" : "s"} across {role.assignedProjectCount} Workspace{role.assignedProjectCount === 1 ? "" : "s"}.</p>
    </div>
  );
}

function SummaryMetric({ label, value, items }: { label: string; value: number; items: string[] }) {
  return (
    <div className="role-summary-metric">
      <strong>{value}</strong><span>{label}</span>
      <div className="role-summary-items">{items.length > 0 ? items.slice(0, 3).map((item) => <code key={item}>{item}</code>) : <em>None selected</em>}{items.length > 3 && <em>+{items.length - 3} more</em>}</div>
    </div>
  );
}

function SkillList({
  title,
  skills,
  busy,
  onToggle,
  emptyLabel,
}: {
  title: string;
  skills: SkillCatalogEntry[];
  busy: boolean;
  onToggle: (skill: SkillCatalogEntry) => Promise<void>;
  emptyLabel: string;
}) {
  return (
    <section className="skill-library-section" aria-labelledby={`skill-list-${title.toLowerCase()}`}>
      <div className="skill-list-heading"><h3 id={`skill-list-${title.toLowerCase()}`}>{title}</h3><span>{skills.length}</span></div>
      {skills.length === 0 ? <p className="access-empty-inline">{emptyLabel}</p> : (
        <div className="skill-catalog-list">
          {skills.map((skill) => (
            <article className="skill-catalog-row" key={skill.id}>
              <div className="skill-catalog-copy">
                <div className="skill-title-line"><h3>{skill.name}</h3><span className={`skill-source-tag ${skill.source === "built-in" ? "is-built-in" : ""}`}>{sourceLabel(skill)}</span></div>
                <p>{skill.description}</p>
                <small>{skill.capabilityTags.length > 0 ? skill.capabilityTags.join(" · ") : "General guidance"}</small>
              </div>
              {/* Built-ins already carry a "Built in" tag beside the name, so
                  the action column stays empty rather than repeating it. */}
              {skill.source !== "built-in" && (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy || !skill.installable}
                  onClick={() => void onToggle(skill)}
                >
                  {skill.installed ? "Uninstall" : "Install"}
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
