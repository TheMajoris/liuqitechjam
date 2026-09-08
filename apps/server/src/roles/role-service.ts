import {
  DEMO_HUMAN_PRINCIPAL,
  type AuthorizationService,
} from "../access/authorization-service.js";
import type { Principal } from "../access/access-types.js";
import {
  PROJECT_ROLE_PERMISSIONS,
  roleAllows,
} from "../access/role-policy.js";
import {
  SUPPORTED_PERMISSION_IDS,
  type PermissionId,
} from "../access/permission-types.js";
import { HttpError } from "../errors.js";
import type { Storage } from "../store.js";
import type { ToolMetadata } from "../tools/tool-types.js";
import type { ProjectAgentAttachment } from "../projects/project-types.js";
import type { Agent } from "../types.js";
import {
  AgentRoleSchema,
  LEGACY_ROLE_IDS,
  ROLE_LIMITS,
  type AgentRole,
  type AgentRoleView,
  type CreateRoleInput,
  type LegacyRoleName,
  type UpdateRoleInput,
} from "./role-types.js";

const ROLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const RESERVED_AGENT_PERMISSIONS = new Set<PermissionId>([
  "project.manage",
  "project.members.manage",
]);

export type RoleErrorCode =
  | "ROLE_NOT_FOUND"
  | "ROLE_INVALID_INPUT"
  | "ROLE_IN_USE"
  | "ROLE_NOT_EDITABLE"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_AGENT_NOT_ATTACHED";

export class RoleError extends HttpError {
  readonly code: RoleErrorCode;

  constructor(code: RoleErrorCode, message: string) {
    super(
      code === "ROLE_NOT_FOUND" || code === "PROJECT_NOT_FOUND" ? 404 :
        code === "ROLE_IN_USE" ? 409 :
          code === "ROLE_NOT_EDITABLE" ? 403 : 422,
      message,
    );
    this.name = "RoleError";
    this.code = code;
  }
}

export function isRoleError(error: unknown): error is RoleError {
  return error instanceof RoleError;
}

export interface RoleToolDirectory {
  listMetadata(): ToolMetadata[];
}

export interface RoleSkillDirectory {
  has(id: string): boolean;
}

function now(): string {
  return new Date().toISOString();
}

function cloneRole(role: AgentRole): AgentRole {
  return {
    ...role,
    skillIds: [...role.skillIds],
    toolIds: [...role.toolIds],
    permissionIds: [...role.permissionIds],
  };
}

function roleView(
  role: AgentRole,
  attachments: readonly ProjectAgentAttachment[],
  agents: readonly Pick<Agent, "id" | "globalRoleId">[] = [],
): AgentRoleView {
  // An Agent carries exactly one role, so a Project reaches a role only
  // through the Agents attached to it.
  const assignedAgentIds = new Set(
    agents.filter((agent) => agent.globalRoleId === role.id).map((agent) => agent.id),
  );
  const assignedProjectIds = new Set(
    attachments
      .filter((attachment) => assignedAgentIds.has(attachment.agentId))
      .map((attachment) => attachment.projectId),
  );
  return {
    ...cloneRole(role),
    assignedAgentCount: assignedAgentIds.size,
    assignedProjectCount: assignedProjectIds.size,
  };
}

function permissionListForLegacyRole(role: LegacyRoleName): PermissionId[] {
  const permissions = new Set<PermissionId>(PROJECT_ROLE_PERMISSIONS[role]);
  // Keep the compatibility role's explicit tool preset visible to the new
  // role editor. This still does not affect the executor's authorization seam.
  for (const permission of SUPPORTED_PERMISSION_IDS) {
    if (permission.startsWith("tool.execute:") && roleAllows(role, permission)) {
      permissions.add(permission);
    }
  }
  return [...permissions];
}

/**
 * Repository-backed reusable Agent role templates. Roles are global records
 * referenced by one Agent field, so editing a role immediately changes every
 * Agent that carries it, in every Workspace.
 */
export class RoleService {
  constructor(
    private readonly store: Storage,
    private readonly tools: RoleToolDirectory,
    private readonly skills: RoleSkillDirectory,
    private readonly authorization: AuthorizationService,
  ) {}

  /** Add compatibility role templates and attach every legacy membership. */
  async initialize(): Promise<void> {
    await this.store.mutate((database) => {
      const timestamp = now();
      for (const legacyName of Object.keys(LEGACY_ROLE_IDS) as LegacyRoleName[]) {
        const id = LEGACY_ROLE_IDS[legacyName];
        if (database.roles.some((role) => role.id === id)) continue;
        database.roles.push({
          id,
          name: legacyName[0]!.toUpperCase() + legacyName.slice(1),
          description: "Migrated Project membership role",
          skillIds: [],
          toolIds: this.toolIdsForPermissions(permissionListForLegacyRole(legacyName)),
          permissionIds: permissionListForLegacyRole(legacyName),
          source: "system",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      // Per-Workspace role overrides were removed: an Agent's role is its own.
      // Any stored override is dropped here so it cannot keep shadowing the
      // Agent role. The legacy `role` membership level is untouched.
      for (const attachment of database.projectAgents) {
        if (attachment.roleId === undefined) continue;
        delete attachment.roleId;
        attachment.updatedAt ??= attachment.attachedAt;
      }
      // A deleted or stale role reference must not make a legacy Agent
      // unloadable. New writes reject such references; boot-time cleanup is
      // the compatibility path for older JSON stores.
      for (const agent of database.agents) {
        if (
          agent.globalRoleId !== undefined &&
          !database.roles.some((role) => role.id === agent.globalRoleId)
        ) {
          delete agent.globalRoleId;
        }
      }
    });
  }

  async list(principal: Principal = DEMO_HUMAN_PRINCIPAL): Promise<AgentRoleView[]> {
    await this.authorizeRead(principal);
    const snapshot = this.store.snapshot();
    return snapshot.roles
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map((role) => roleView(role, snapshot.projectAgents, snapshot.agents));
  }

  async get(id: string, principal: Principal = DEMO_HUMAN_PRINCIPAL): Promise<AgentRoleView> {
    await this.authorizeRead(principal, id);
    const snapshot = this.store.snapshot();
    const role = snapshot.roles.find((item) => item.id === id);
    if (!role) throw new RoleError("ROLE_NOT_FOUND", "Role not found");
    return roleView(role, snapshot.projectAgents, snapshot.agents);
  }

  async create(
    input: CreateRoleInput,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<AgentRoleView> {
    await this.authorizeManage(principal);
    const normalized = this.validateInput(input);
    const timestamp = now();
    const role: AgentRole = {
      id: this.newRoleId(normalized.name),
      ...normalized,
      source: "user",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.roles.push(role);
    });
    const snapshot = this.store.snapshot();
    return roleView(role, snapshot.projectAgents, snapshot.agents);
  }

  async update(
    id: string,
    input: UpdateRoleInput,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<AgentRoleView> {
    await this.authorizeManage(principal);
    const current = this.requireRole(id);
    if (current.source !== "user") {
      throw new RoleError("ROLE_NOT_EDITABLE", "System roles cannot be edited");
    }
    const snapshot = this.store.snapshot();
    const assignedCount = snapshot.agents.filter(
      (agent) => agent.globalRoleId === id,
    ).length;
    if (assignedCount > 0 && input.confirmPropagation !== true) {
      throw new RoleError(
        "ROLE_IN_USE",
        `Confirm this change because it affects ${assignedCount} assigned Agent${assignedCount === 1 ? "" : "s"}`,
      );
    }
    const normalized = this.validateInput({
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      skillIds: input.skillIds ?? current.skillIds,
      toolIds: input.toolIds ?? current.toolIds,
      permissionIds: input.permissionIds ?? current.permissionIds,
    });
    const updated: AgentRole = {
      ...current,
      ...normalized,
      updatedAt: now(),
    };
    await this.store.mutate((database) => {
      const stored = database.roles.find((role) => role.id === id);
      if (!stored) throw new RoleError("ROLE_NOT_FOUND", "Role not found");
      Object.assign(stored, updated);
    });
    const updatedSnapshot = this.store.snapshot();
    return roleView(updated, updatedSnapshot.projectAgents, updatedSnapshot.agents);
  }

  async remove(
    id: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<{ removed: true }> {
    await this.authorizeManage(principal);
    const current = this.requireRole(id);
    if (current.source !== "user") {
      throw new RoleError("ROLE_NOT_EDITABLE", "System roles cannot be removed");
    }
    const snapshot = this.store.snapshot();
    if (snapshot.agents.some((agent) => agent.globalRoleId === id)) {
      throw new RoleError("ROLE_IN_USE", "Role is assigned to an Agent");
    }
    await this.store.mutate((database) => {
      database.roles = database.roles.filter((role) => role.id !== id);
    });
    return { removed: true };
  }

  /**
   * Resolve the role that applies to an Agent.
   *
   * The Agent's own role is the only source: it applies identically in every
   * Workspace. A Project attachment's legacy `role` field remains the
   * independent membership/access level and is never read as a role template.
   */
  getEffectiveRole(
    agentId: string,
    _projectId?: string,
    agent?: Pick<Agent, "id" | "globalRoleId">,
  ): AgentRole | undefined {
    const snapshot = this.store.snapshot();
    const roleId = agent?.globalRoleId ??
      snapshot.agents.find((item) => item.id === agentId)?.globalRoleId;
    if (roleId === undefined) return undefined;
    const role = snapshot.roles.find((item) => item.id === roleId);
    return role ? cloneRole(role) : undefined;
  }

  /** The effective role's skills are additive to the Agent-global assignment. */
  assignedSkillIds(
    projectId: string | undefined,
    agentId: string,
    agent?: Pick<Agent, "id" | "globalRoleId">,
  ): string[] {
    return [...(this.getEffectiveRole(agentId, projectId, agent)?.skillIds ?? [])];
  }

  private requireRole(id: string): AgentRole {
    const role = this.store.snapshot().roles.find((item) => item.id === id);
    if (!role) throw new RoleError("ROLE_NOT_FOUND", "Role not found");
    const parsed = AgentRoleSchema.safeParse(role);
    if (!parsed.success) throw new RoleError("ROLE_INVALID_INPUT", "Stored role is invalid");
    return cloneRole(role);
  }

  private validateInput(input: CreateRoleInput): Omit<AgentRole, "id" | "source" | "createdAt" | "updatedAt"> {
    const name = input.name.trim();
    const description = (input.description ?? "").trim();
    if (name.length === 0 || name.length > ROLE_LIMITS.maxNameLength) {
      throw new RoleError("ROLE_INVALID_INPUT", "Role name is required and must be at most " + ROLE_LIMITS.maxNameLength + " characters");
    }
    if (description.length > ROLE_LIMITS.maxDescriptionLength) {
      throw new RoleError("ROLE_INVALID_INPUT", "Role description must be at most " + ROLE_LIMITS.maxDescriptionLength + " characters");
    }
    const skillIds = this.normalizeIds(input.skillIds ?? [], "skills", ROLE_LIMITS.maxSkills, (id) => this.skills.has(id));
    const toolIds = this.normalizeIds(input.toolIds ?? [], "tools", ROLE_LIMITS.maxTools, (id) =>
      this.tools.listMetadata().some((tool) => tool.id === id),
    );
    const permissionIds = this.normalizePermissions(input.permissionIds ?? []);
    return { name, description, skillIds, toolIds, permissionIds };
  }

  private normalizeIds(
    values: readonly string[],
    label: string,
    max: number,
    allowed: (id: string) => boolean,
  ): string[] {
    if (!Array.isArray(values) || values.length > max) {
      throw new RoleError("ROLE_INVALID_INPUT", "A role may have at most " + max + " " + label);
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || !ROLE_ID_PATTERN.test(value) || !allowed(value)) {
        throw new RoleError("ROLE_INVALID_INPUT", "Unknown " + label + " identifier");
      }
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  private normalizePermissions(values: readonly (PermissionId | string)[]): PermissionId[] {
    if (!Array.isArray(values) || values.length > ROLE_LIMITS.maxPermissions) {
      throw new RoleError("ROLE_INVALID_INPUT", "A role may have at most " + ROLE_LIMITS.maxPermissions + " permissions");
    }
    const known = new Set(SUPPORTED_PERMISSION_IDS);
    const result: PermissionId[] = [];
    const seen = new Set<PermissionId>();
    for (const value of values) {
      if (typeof value !== "string" || !known.has(value as PermissionId)) {
        throw new RoleError("ROLE_INVALID_INPUT", "Unknown permission identifier");
      }
      const permission = value as PermissionId;
      if (RESERVED_AGENT_PERMISSIONS.has(permission)) {
        throw new RoleError("ROLE_INVALID_INPUT", "Project administration permissions cannot be assigned to an Agent role");
      }
      if (seen.has(permission)) continue;
      seen.add(permission);
      result.push(permission);
    }
    return result;
  }

  private toolIdsForPermissions(permissions: readonly PermissionId[]): string[] {
    return this.tools
      .listMetadata()
      .filter((tool) => permissions.includes(tool.requiredPermission))
      .map((tool) => tool.id);
  }

  private newRoleId(name: string): string {
    const base = name
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "role";
    const existing = new Set(this.store.snapshot().roles.map((role) => role.id));
    let id = base;
    let suffix = 2;
    while (existing.has(id)) id = base + "-" + suffix++;
    return id;
  }

  private async authorizeRead(principal: Principal, roleId?: string): Promise<void> {
    await this.authorization.require({
      principal,
      permission: "role.read",
      resource: { kind: "agent", id: roleId ?? "roles" },
    });
  }

  private async authorizeManage(principal: Principal): Promise<void> {
    await this.authorization.require({
      principal,
      permission: "role.manage",
      resource: { kind: "agent", id: "roles" },
    });
  }
}
