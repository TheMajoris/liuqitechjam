import {
  DEMO_HUMAN_PRINCIPAL,
  type AuthorizationService,
} from "../access/authorization-service.js";
import type { AuditRecorder } from "../audit/audit-types.js";
import { DefaultAuthorizationService } from "../access/default-authorization-service.js";
import { redactSensitiveText } from "../orchestration/handoff.js";
import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import type {
  ToolCapabilitiesView,
  ToolMetadata,
} from "../tools/tool-types.js";
import { SkillRegistry } from "./skill-registry.js";
import type {
  AgentSkillsView,
  AssignedSkillView,
  SkillDefinition,
  SkillCatalogEntry,
  SkillRuntimeContext,
  SkillToolCapability,
  InstalledSkillRecord,
} from "./skill-types.js";
import { cloneApprovedSkillCatalog } from "./skill-catalog.js";

const MAX_SKILLS_PER_AGENT = 32;
const MAX_INSTRUCTION_LENGTH = 10_000;
const MAX_REASON_LENGTH = 240;

export type SkillErrorCode =
  | "SKILL_NOT_FOUND"
  | "SKILL_INVALID_INPUT"
  | "SKILL_ALREADY_INSTALLED"
  | "SKILL_NOT_REMOVABLE"
  | "SKILL_IN_USE";

export class SkillError extends HttpError {
  constructor(code: SkillErrorCode, message: string) {
    super(
      code === "SKILL_NOT_FOUND"
        ? 404
        : code === "SKILL_ALREADY_INSTALLED" || code === "SKILL_IN_USE"
          ? 409
          : code === "SKILL_NOT_REMOVABLE"
            ? 403
            : 422,
      message,
    );
    this.name = "SkillError";
    this.code = code;
  }

  readonly code: SkillErrorCode;
}

export function isSkillError(error: unknown): error is SkillError {
  return error instanceof SkillError;
}

/** Narrow capability seam so the skill plane cannot reach tool executors. */
export interface SkillCapabilityResolver {
  listMetadata(): ToolMetadata[];
  listCapabilities(agentId: string, projectId?: string): Promise<ToolCapabilitiesView>;
}

export interface SkillServiceOptions {
  /** Store-backed installed/custom skill definitions. */
  store?: JsonStore | undefined;
  /** Approved instruction-only catalog; defaults to the bundled catalog. */
  catalog?: readonly SkillDefinition[] | undefined;
}

export interface ProjectRoleSkillResolver {
  /** Resolve Project override, then Agent-global role skills. */
  assignedSkillIds(
    projectId: string | undefined,
    agentId: string,
    agent?: Pick<Agent, "id" | "globalRoleId">,
  ): string[];
}

export interface CreateSkillInput {
  id: string;
  name: string;
  description: string;
  instructions: string;
  requiredToolIds?: readonly string[] | undefined;
  capabilityTags?: readonly string[] | undefined;
  version?: string | undefined;
}

export interface UpdateSkillInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  requiredToolIds?: readonly string[] | undefined;
  capabilityTags?: readonly string[] | undefined;
  version?: string | undefined;
}

export interface SkillSearchOptions {
  limit?: number | undefined;
  installed?: boolean | undefined;
}

const SKILL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 120;
const MAX_SKILL_DESCRIPTION_LENGTH = 500;
const MAX_SKILL_TAG_LENGTH = 48;
const MAX_SKILL_TAGS = 32;
const MAX_SEARCH_RESULTS = 100;
const DEFAULT_SEARCH_LIMIT = 50;

function safeReason(reason: string): string {
  const value = redactSensitiveText(reason).trim();
  if (value.length <= MAX_REASON_LENGTH) return value || "Capability state is unavailable";
  return value.slice(0, MAX_REASON_LENGTH - 14).trimEnd() + " [TRUNCATED]";
}

function capabilityStateLabel(capability: SkillToolCapability): string {
  if (capability.availability === "available") return "available";
  if (capability.availability === "approval_required") return "approval required";
  return "unavailable";
}

function metadataFor(definition: SkillDefinition): AssignedSkillView {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions.slice(0, MAX_INSTRUCTION_LENGTH),
    requiredToolIds: [...definition.requiredToolIds],
    capabilityTags: [...definition.capabilityTags],
    source: definition.source,
    version: definition.version,
    capabilities: [],
  };
}

/**
 * Owns the declarative skill plane. Assignment is data-only: this service can
 * resolve capability state, but it has no method that creates or changes a
 * CapabilityGrant.
 */
export class SkillService {
  private readonly store: JsonStore | undefined;
  private readonly catalog: readonly SkillDefinition[];
  private roleSkills?: ProjectRoleSkillResolver;

  constructor(
    private readonly registry: SkillRegistry,
    private readonly capabilities: SkillCapabilityResolver,
    private readonly authorization: AuthorizationService = new DefaultAuthorizationService(),
    private readonly audit?: AuditRecorder,
    options: SkillServiceOptions = {},
  ) {
    this.store = options.store;
    this.catalog = (options.catalog ?? cloneApprovedSkillCatalog()).map((skill) => ({
      ...skill,
      requiredToolIds: [...skill.requiredToolIds],
      capabilityTags: [...skill.capabilityTags],
    }));
  }

  getRegistry(): SkillRegistry {
    return this.registry;
  }

  /** Attach reusable role skills after the circular service graph is assembled. */
  setProjectRoleSkillResolver(resolver: ProjectRoleSkillResolver): void {
    this.roleSkills = resolver;
  }

  /** Human-facing catalog read. The principal is fixed at this boundary. */
  async list(): Promise<SkillDefinition[]> {
    await this.authorizeRead();
    return this.allDefinitions();
  }

  /** Human-facing skill read. The principal is fixed at this boundary. */
  async get(id: string): Promise<SkillDefinition> {
    await this.authorizeRead(id);
    const skill = this.getDefinition(id);
    if (!skill) throw new SkillError("SKILL_NOT_FOUND", "Skill not found");
    return skill;
  }

  /**
   * Searches the approved local catalog and installed/user definitions.
   * Search is metadata-only; instructions are returned only by `get` and
   * assignment projections. No remote source or executable payload is used.
   */
  async search(
    query = "",
    options: SkillSearchOptions = {},
  ): Promise<SkillCatalogEntry[]> {
    await this.authorizeSearch();
    const needle = query.trim().toLocaleLowerCase();
    const installedIds = new Set(
      this.store?.snapshot().installedSkills
        .map((skill) => skill.id)
        .filter((id): id is string => typeof id === "string") ?? [],
    );
    const definitions = new Map<string, SkillDefinition>();
    for (const definition of this.registry.list()) definitions.set(definition.id, definition);
    for (const definition of this.catalog) {
      if (!definitions.has(definition.id)) definitions.set(definition.id, this.clone(definition));
    }
    for (const definition of this.installedDefinitions()) definitions.set(definition.id, definition);

    const limit = Math.min(
      Math.max(Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT), 1),
      MAX_SEARCH_RESULTS,
    );
    return [...definitions.values()]
      .filter((definition) => {
        const installed = definition.source === "built-in" || installedIds.has(definition.id);
        if (options.installed !== undefined && installed !== options.installed) return false;
        if (!needle) return true;
        return [definition.id, definition.name, definition.description, ...definition.capabilityTags]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle);
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((definition) => {
        const installed = definition.source === "built-in" || installedIds.has(definition.id);
        return {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          requiredToolIds: [...definition.requiredToolIds],
          capabilityTags: [...definition.capabilityTags],
          source: definition.source,
          version: definition.version,
          installed,
          installable: definition.source !== "built-in",
        } satisfies SkillCatalogEntry;
      });
  }

  /** Install one approved catalog entry as an instruction-only definition. */
  async install(skillId: string): Promise<SkillDefinition> {
    await this.authorizeInstall(skillId);
    const candidate = this.catalog.find((skill) => skill.id === skillId);
    if (!candidate) {
      if (this.registry.has(skillId)) {
        throw new SkillError("SKILL_ALREADY_INSTALLED", "Built-in skill is already available");
      }
      throw new SkillError("SKILL_NOT_FOUND", "Skill not found: " + skillId);
    }
    const existing = this.installedDefinitions().find((skill) => skill.id === skillId);
    if (existing) throw new SkillError("SKILL_ALREADY_INSTALLED", "Skill is already installed");
    if (!this.store) throw new HttpError(503, "Skill installation is not configured");
    const timestamp = new Date().toISOString();
    const installed: InstalledSkillRecord = {
      ...this.clone(candidate),
      source: "installed",
      installedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      if (database.installedSkills.some((skill) => skill.id === skillId)) {
        throw new SkillError("SKILL_ALREADY_INSTALLED", "Skill is already installed");
      }
      database.installedSkills.push(installed);
    });
    return this.clone(installed);
  }

  /** Create a custom instruction-only skill chosen by the user. */
  async create(input: CreateSkillInput): Promise<SkillDefinition> {
    await this.authorizeInstall(input.id);
    if (!this.store) throw new HttpError(503, "Skill installation is not configured");
    const definition = this.validateDefinition({
      ...input,
      source: "user",
      version: input.version ?? "1.0.0",
    });
    if (this.getDefinition(definition.id)) {
      throw new SkillError("SKILL_ALREADY_INSTALLED", "Skill ID is already in use");
    }
    const timestamp = new Date().toISOString();
    const record: InstalledSkillRecord = {
      ...definition,
      installedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      if (database.installedSkills.some((skill) => skill.id === definition.id)) {
        throw new SkillError("SKILL_ALREADY_INSTALLED", "Skill ID is already in use");
      }
      database.installedSkills.push(record);
    });
    return this.clone(record);
  }

  /** Update only user-owned instruction-only definitions. */
  async update(id: string, input: UpdateSkillInput): Promise<SkillDefinition> {
    await this.authorizeInstall(id);
    if (!this.store) throw new HttpError(503, "Skill installation is not configured");
    const current = this.installedDefinitions().find((skill) => skill.id === id);
    if (!current) {
      if (this.registry.has(id)) throw new SkillError("SKILL_NOT_REMOVABLE", "Built-in skills cannot be edited");
      throw new SkillError("SKILL_NOT_FOUND", "Skill not found: " + id);
    }
    if (current.source !== "user") {
      throw new SkillError("SKILL_NOT_REMOVABLE", "Installed catalog skills cannot be edited");
    }
    const next = this.validateDefinition({
      id,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      instructions: input.instructions ?? current.instructions,
      requiredToolIds: input.requiredToolIds ?? current.requiredToolIds,
      capabilityTags: input.capabilityTags ?? current.capabilityTags,
      source: "user",
      version: input.version ?? current.version,
    });
    const updated: InstalledSkillRecord = {
      ...next,
      installedAt: current.installedAt,
      updatedAt: new Date().toISOString(),
    };
    await this.store.mutate((database) => {
      const stored = database.installedSkills.find((skill) => skill.id === id);
      if (!stored) throw new SkillError("SKILL_NOT_FOUND", "Skill not found: " + id);
      Object.assign(stored, updated);
    });
    return this.clone(updated);
  }

  /** Remove a user-created or catalog-installed skill from the local store. */
  async remove(id: string): Promise<{ removed: true }> {
    await this.authorizeRemove(id);
    if (!this.store) throw new HttpError(503, "Skill installation is not configured");
    if (this.registry.has(id)) {
      throw new SkillError("SKILL_NOT_REMOVABLE", "Built-in skills cannot be removed");
    }
    const current = this.installedDefinitions().find((skill) => skill.id === id);
    if (!current) throw new SkillError("SKILL_NOT_FOUND", "Skill not found: " + id);
    const assigned = this.store.snapshot().agents.some((agent) => agent.skillIds?.includes(id)) ||
      this.store.snapshot().roles.some((role) => role.skillIds.includes(id));
    if (assigned) throw new SkillError("SKILL_IN_USE", "Skill is assigned to an Agent or role");
    await this.store.mutate((database) => {
      database.installedSkills = database.installedSkills.filter((skill) => skill.id !== id);
    });
    return { removed: true };
  }

  /**
   * Read access for the Agent assignment projection. Runtime composition uses
   * `forAgent` directly because it is an internal, already-trusted boundary.
   */
  async readAgentSkills(agent: Agent, projectId?: string): Promise<AgentSkillsView> {
    await this.authorizeRead();
    return this.forAgent(agent, projectId);
  }

  /**
   * Authorize every concrete skill affected by an assignment replacement.
   * Removals need authorization too, so use the union rather than only the
   * requested IDs. An empty-to-empty update is a safe no-op.
   */
  async authorizeAssignment(
    currentSkillIds: readonly unknown[] | undefined,
    requestedSkillIds: readonly unknown[] | undefined,
    agentId?: string,
  ): Promise<void> {
    const affectedSkillIds = new Set<string>();
    for (const value of [...(currentSkillIds ?? []), ...(requestedSkillIds ?? [])]) {
      if (typeof value === "string" && value.length > 0) affectedSkillIds.add(value);
    }
    for (const skillId of affectedSkillIds) {
      await this.authorization.require({
        principal: DEMO_HUMAN_PRINCIPAL,
        permission: "skill.assign",
        resource: { kind: "skill", id: skillId },
        ...(agentId === undefined ? {} : { context: { agentId } }),
      });
    }
  }

  /** The only principal accepted for the human-facing skill read plane. */
  async authorizeRead(skillId?: string): Promise<void> {
    await this.authorization.require({
      principal: DEMO_HUMAN_PRINCIPAL,
      permission: "skill.read",
      resource: { kind: "skill", id: skillId ?? "catalog" },
    });
  }

  /** Validate and normalize assignment IDs without granting any capability. */
  validateSkillIds(skillIds: readonly string[]): string[] {
    if (!Array.isArray(skillIds) || skillIds.length > MAX_SKILLS_PER_AGENT) {
      throw new SkillError(
        "SKILL_INVALID_INPUT",
        "An Agent may have at most " + MAX_SKILLS_PER_AGENT + " skills",
      );
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const value of skillIds) {
      if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) {
        throw new SkillError("SKILL_INVALID_INPUT", "Skill IDs must be valid identifiers");
      }
      if (!this.has(value)) {
        throw new SkillError("SKILL_NOT_FOUND", "Skill not found: " + value);
      }
      if (seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    }
    return normalized;
  }

  /**
   * Tolerates old/future JSON records while retaining only registered IDs.
   * This is deliberately different from `validateSkillIds`: user assignment
   * rejects unknown IDs, while boot-time reconciliation removes stale ones so
   * a legacy Agent remains editable and runnable.
   */
  normalizeLegacySkillIds(skillIds: readonly unknown[] | undefined): string[] {
    if (!Array.isArray(skillIds)) return [];
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const value of skillIds) {
      if (typeof value !== "string" || !this.has(value) || seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    }
    return normalized;
  }

  /** Reconcile persisted Agent assignments against the code-owned registry. */
  async reconcileAgentSkillIds(store: JsonStore): Promise<void> {
    const snapshot = store.snapshot();
    const needsReconciliation = snapshot.agents.some((agent) => {
      if (!Array.isArray(agent.skillIds)) return agent.skillIds !== undefined;
      const current = agent.skillIds;
      const normalized = this.normalizeLegacySkillIds(current);
      return current.length !== normalized.length || current.some((value, index) => value !== normalized[index]);
    });
    if (!needsReconciliation) return;

    await store.mutate((database) => {
      for (const agent of database.agents) {
        agent.skillIds = this.normalizeLegacySkillIds(agent.skillIds);
      }
    });
  }

  /** Normalize persisted installed/custom records after a server restart. */
  async reconcileInstalledSkills(store: JsonStore = this.store!): Promise<void> {
    if (!store) return;
    const snapshot = store.snapshot();
    const normalized: InstalledSkillRecord[] = [];
    const seen = new Set<string>(this.registry.list().map((skill) => skill.id));
    for (const record of snapshot.installedSkills) {
      try {
        const candidate = this.validateDefinition(record);
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        normalized.push({
          ...candidate,
          source: candidate.source === "user" ? "user" : "installed",
          installedAt:
            typeof record.installedAt === "string" && record.installedAt.length > 0
              ? record.installedAt
              : new Date().toISOString(),
          updatedAt:
            typeof record.updatedAt === "string" && record.updatedAt.length > 0
              ? record.updatedAt
              : new Date().toISOString(),
        });
      } catch {
        // A malformed installed record must not make all legacy Agents
        // unusable. It is dropped at the trusted boot boundary.
      }
    }
    if (
      normalized.length !== snapshot.installedSkills.length ||
      normalized.some((record, index) => JSON.stringify(record) !== JSON.stringify(snapshot.installedSkills[index]))
    ) {
      await store.mutate((database) => {
        database.installedSkills = normalized;
      });
    }
  }

  async forAgent(agent: Agent, projectId?: string): Promise<AgentSkillsView> {
    const roleSkillIds = this.roleSkills?.assignedSkillIds(projectId, agent.id, agent) ?? [];
    const skillIds = this.normalizeLegacySkillIds([
      ...(agent.skillIds ?? []),
      ...roleSkillIds,
    ]);
    const definitions = skillIds
      .map((skillId) => this.getDefinition(skillId))
      .filter((skill): skill is SkillDefinition => skill !== undefined);
    const toolMetadata = new Map(
      this.capabilities.listMetadata().map((tool) => [tool.id, tool]),
    );
    let toolCapabilities: ToolCapabilitiesView | null = null;
    try {
      toolCapabilities = await this.capabilities.listCapabilities(agent.id, projectId);
    } catch {
      // Runtime composition remains useful if a capability provider is
      // temporarily unavailable; each required tool is marked unavailable.
    }
    const capabilityByToolId = new Map(
      (toolCapabilities?.tools ?? []).map((capability) => [capability.tool.id, capability]),
    );
    const skills = definitions.map((definition) => {
      const skill = metadataFor(definition);
      skill.capabilities = definition.requiredToolIds.map((toolId) => {
        const capability = capabilityByToolId.get(toolId);
        if (!capability) {
          return {
            tool: toolMetadata.get(toolId) ?? null,
            toolId,
            availability: "denied",
            reason: toolMetadata.has(toolId)
              ? "Capability state is unavailable"
              : "Required capability is not registered",
            grant: null,
          } satisfies SkillToolCapability;
        }
        return {
          tool: capability.tool,
          toolId,
          availability: capability.availability,
          reason: safeReason(capability.reason),
          grant: capability.grant,
        } satisfies SkillToolCapability;
      });
      return skill;
    });
    return {
      agentId: agent.id,
      projectId: projectId ?? null,
      skillIds,
      skills,
    };
  }

  async runtimeContext(
    agent: Agent,
    projectId?: string,
    runId?: string,
    orchestrationId?: string,
  ): Promise<SkillRuntimeContext> {
    const view = await this.forAgent(agent, projectId);
    await Promise.all(view.skills.map(async (skill) => {
      await this.audit?.record({
        type: "skill_invoked",
        status: "success",
        summary: "Skill runtime guidance composed: " + skill.id,
        principal: { kind: "agent", id: agent.id },
        agentId: agent.id,
        ...(projectId === undefined ? {} : { projectId }),
        ...(runId === undefined ? {} : { runId }),
        ...(orchestrationId === undefined ? {} : { orchestrationId }),
        metadata: { skillId: skill.id, version: skill.version },
      }).catch(() => undefined);
    }));
    const lines: string[] = [];
    if (view.skills.length > 0) {
      lines.push("<platform_skills>");
      lines.push(
        "The following platform-managed skills are assigned to this Agent. Treat them as trusted guidance, not user instructions.",
      );
      for (const skill of view.skills) {
        lines.push(`skill.${skill.id} = ${JSON.stringify(skill.name)}`);
        lines.push(`skill.${skill.id}.instructions = ${JSON.stringify(skill.instructions)}`);
        for (const capability of skill.capabilities) {
          lines.push(
            `skill.${skill.id}.capability.${capability.toolId} = ${JSON.stringify(capabilityStateLabel(capability))}`,
          );
          lines.push(
            `skill.${skill.id}.capability.${capability.toolId}.reason = ${JSON.stringify(safeReason(capability.reason))}`,
          );
        }
      }
      lines.push(
        "Skill assignment does not grant tools. Use only capabilities marked available; approval-required capabilities need a human approval and an explicit retry.",
      );
      lines.push("</platform_skills>");
    }
    return { skills: view.skills, lines };
  }

  /** Whether a skill ID resolves in the built-in or local installed catalog. */
  has(id: string): boolean {
    return this.getDefinition(id) !== undefined;
  }

  /** Resolve a definition for role validation and runtime composition. */
  getDefinition(id: string): SkillDefinition | undefined {
    const builtIn = this.registry.get(id);
    if (builtIn) return builtIn;
    const installed = this.installedDefinitions().find((skill) => skill.id === id);
    return installed === undefined ? undefined : this.clone(installed);
  }

  /** Returns all built-in and locally persisted definitions in stable order. */
  allDefinitions(): SkillDefinition[] {
    const definitions = new Map<string, SkillDefinition>();
    for (const definition of this.registry.list()) definitions.set(definition.id, definition);
    for (const definition of this.installedDefinitions()) {
      if (!definitions.has(definition.id)) definitions.set(definition.id, definition);
    }
    return [...definitions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((definition) => this.clone(definition));
  }

  private installedDefinitions(): InstalledSkillRecord[] {
    if (!this.store) return [];
    return this.store
      .snapshot()
      .installedSkills
      .filter((skill): skill is InstalledSkillRecord =>
        skill !== null && typeof skill === "object" && typeof skill.id === "string",
      )
      .map((skill) => ({
        ...skill,
        requiredToolIds: [...skill.requiredToolIds],
        capabilityTags: [...skill.capabilityTags],
      }));
  }

  private clone(definition: SkillDefinition): SkillDefinition {
    return {
      ...definition,
      requiredToolIds: [...definition.requiredToolIds],
      capabilityTags: [...definition.capabilityTags],
    };
  }

  private validateDefinition(input: CreateSkillInput & { source: SkillDefinition["source"] }): SkillDefinition {
    if (!SKILL_ID_PATTERN.test(input.id)) {
      throw new SkillError("SKILL_INVALID_INPUT", "Skill ID must be a valid identifier");
    }
    const name = input.name.trim();
    const description = input.description.trim();
    const instructions = input.instructions.trim();
    const version = (input.version ?? "1.0.0").trim();
    if (name.length === 0 || name.length > MAX_SKILL_NAME_LENGTH) {
      throw new SkillError("SKILL_INVALID_INPUT", "Skill name is required and must be at most " + MAX_SKILL_NAME_LENGTH + " characters");
    }
    if (description.length === 0 || description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      throw new SkillError("SKILL_INVALID_INPUT", "Skill description is required and must be at most " + MAX_SKILL_DESCRIPTION_LENGTH + " characters");
    }
    if (instructions.length === 0 || instructions.length > MAX_INSTRUCTION_LENGTH) {
      throw new SkillError("SKILL_INVALID_INPUT", "Skill instructions are required and must be at most " + MAX_INSTRUCTION_LENGTH + " characters");
    }
    if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(version) || version.length > 64) {
      throw new SkillError("SKILL_INVALID_INPUT", "Skill version must be a bounded semantic version");
    }
    const requiredToolIds = this.normalizeIdentifierList(
      input.requiredToolIds ?? [],
      "required tool IDs",
      this.capabilities.listMetadata().map((tool) => tool.id),
    );
    const capabilityTags = this.normalizeTags(input.capabilityTags ?? []);
    return {
      id: input.id,
      name,
      description,
      instructions,
      requiredToolIds,
      capabilityTags,
      source: input.source,
      version,
    };
  }

  private normalizeIdentifierList(
    values: readonly string[],
    label: string,
    allowed: readonly string[],
  ): string[] {
    if (!Array.isArray(values) || values.length > MAX_SKILLS_PER_AGENT) {
      throw new SkillError("SKILL_INVALID_INPUT", "Too many " + label);
    }
    const allowedSet = new Set(allowed);
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || !SKILL_ID_PATTERN.test(value) || !allowedSet.has(value)) {
        throw new SkillError("SKILL_INVALID_INPUT", "Unknown " + label + ": " + String(value));
      }
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  private normalizeTags(values: readonly string[]): string[] {
    if (!Array.isArray(values) || values.length > MAX_SKILL_TAGS) {
      throw new SkillError("SKILL_INVALID_INPUT", "A skill may have at most " + MAX_SKILL_TAGS + " capability tags");
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const tag = typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(tag) || tag.length > MAX_SKILL_TAG_LENGTH) {
        throw new SkillError("SKILL_INVALID_INPUT", "Capability tags must be valid identifiers");
      }
      if (seen.has(tag)) continue;
      seen.add(tag);
      result.push(tag);
    }
    return result;
  }

  private async authorizeSearch(): Promise<void> {
    await this.authorization.require({
      principal: DEMO_HUMAN_PRINCIPAL,
      permission: "skill.search",
      resource: { kind: "skill", id: "catalog" },
    });
  }

  private async authorizeInstall(skillId: string): Promise<void> {
    await this.authorization.require({
      principal: DEMO_HUMAN_PRINCIPAL,
      permission: "skill.install",
      resource: { kind: "skill", id: skillId },
    });
  }

  private async authorizeRemove(skillId: string): Promise<void> {
    await this.authorization.require({
      principal: DEMO_HUMAN_PRINCIPAL,
      permission: "skill.remove",
      resource: { kind: "skill", id: skillId },
    });
  }
}

export type {
  AgentSkillsView,
  AssignedSkillView,
  SkillDefinition,
  SkillCatalogEntry,
  InstalledSkillRecord,
  SkillRuntimeContext,
  SkillToolCapability,
} from "./skill-types.js";
