import type { AuthorizationRequest } from "./authorization-service.js";
import type { AuthorizationContext, Principal, ResourceRef } from "./access-types.js";
import type { PermissionId } from "./permission-types.js";

/**
 * The stable resource namespaces used by the Permit policy.  These are
 * identifiers only; no role or allow/deny policy is kept in this module.
 */
export const PERMIT_RESOURCE_TYPES = {
  project: "project",
  agent: "agent",
  tool: "tool",
  skill: "skill",
} as const;

export interface PermitResource {
  type: string;
  key?: string;
  tenant?: string;
}

export type PermitContext = Readonly<Record<string, string>>;

export interface PermitAuthorizationCheck {
  user: string;
  action: string;
  resource: PermitResource;
  context?: PermitContext;
}

const ACTIONS: Readonly<Record<PermissionId, string>> = {
  "agent.invoke": "agent.invoke",
  "project.manage": "project.manage",
  "project.members.manage": "project.members.manage",
  "preview.inspect": "preview.inspect",
  "preview.start": "preview.start",
  "preview.restart": "preview.restart",
  "preview.stop": "preview.stop",
  "preview.logs": "preview.logs",
  "project.read": "project.read",
  "project.write": "project.write",
  "project.preview.inspect": "project.preview.inspect",
  "project.preview.start": "project.preview.start",
  "project.preview.restart": "project.preview.restart",
  "project.preview.stop": "project.preview.stop",
  "project.preview.logs": "project.preview.logs",
  "skill.read": "skill.read",
  "skill.assign": "skill.assign",
  "skill.search": "skill.search",
  "skill.install": "skill.install",
  "skill.remove": "skill.remove",
  "role.read": "role.read",
  "role.manage": "role.manage",
  // Tool action keys are stable policy identifiers. Project-scoped calls use
  // the reconciled Project resource below; they do not depend on a separate
  // Permit tool-instance directory that the repository never synchronizes.
  "tool.execute:web.search": "tool.execute.web_search",
  "tool.execute:web.fetch": "tool.execute.web_fetch",
  "tool.execute:project.preview.inspect": "tool.execute.preview_inspect",
  "tool.execute:project.preview.restart": "tool.execute.preview_restart",
};

const CONTEXT_KEYS = [
  "projectId",
  "agentId",
  "runId",
  "orchestrationId",
  "toolId",
] as const satisfies readonly (keyof AuthorizationContext)[];

const MAX_IDENTIFIER_LENGTH = 256;

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\0\r\n\\/]/.test(value)
  );
}

function scopedKey(type: string, id: string): string {
  return type + ":" + id;
}

function principalIsTrusted(principal: unknown): principal is Principal {
  if (!principal || typeof principal !== "object") return false;
  const value = principal as { kind?: unknown; id?: unknown };
  if (!safeIdentifier(value.id)) return false;
  if (value.kind === "human") return value.id === "demo-owner";
  return value.kind === "agent";
}

function resourceFromRef(resource: ResourceRef): PermitResource | null {
  if (!resource || typeof resource !== "object") return null;
  switch (resource.kind) {
    case "project":
      return safeIdentifier(resource.id)
        ? { type: PERMIT_RESOURCE_TYPES.project, key: scopedKey("project", resource.id) }
        : null;
    case "agent":
      return safeIdentifier(resource.id)
        ? { type: PERMIT_RESOURCE_TYPES.agent, key: scopedKey("agent", resource.id) }
        : null;
    case "tool":
      return safeIdentifier(resource.id)
        ? { type: PERMIT_RESOURCE_TYPES.tool, key: scopedKey("tool", resource.id) }
        : null;
    case "skill":
      return safeIdentifier(resource.id)
        ? { type: PERMIT_RESOURCE_TYPES.skill, key: scopedKey("skill", resource.id) }
        : null;
    case "preview": {
      const owner = resource.owner;
      if (!owner || typeof owner !== "object") return null;
      if (owner.kind === "project" && safeIdentifier(owner.projectId)) {
        return {
          type: PERMIT_RESOURCE_TYPES.project,
          key: scopedKey("project", owner.projectId),
        };
      }
      if (owner.kind === "agent" && safeIdentifier(owner.agentId)) {
        return {
          type: PERMIT_RESOURCE_TYPES.agent,
          key: scopedKey("agent", owner.agentId),
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function contextValues(input: AuthorizationRequest): PermitContext | null {
  const rawContext = input.context as unknown;
  if (
    rawContext !== undefined &&
    (rawContext === null || typeof rawContext !== "object" || Array.isArray(rawContext))
  ) {
    return null;
  }
  const context = (rawContext ?? {}) as AuthorizationContext;
  for (const key of Object.keys(context)) {
    if (!(CONTEXT_KEYS as readonly string[]).includes(key)) return null;
  }
  const values: Record<string, string> = {};
  for (const key of CONTEXT_KEYS) {
    const value = context[key];
    if (value !== undefined) {
      if (!safeIdentifier(value)) return null;
      values[key] = value;
    }
  }
  // Legacy fields are trusted service-side compatibility fields. They are
  // copied into the same bounded context shape, never treated as principals.
  if (input.projectId !== undefined) {
    if (!safeIdentifier(input.projectId)) return null;
    values.projectId ??= input.projectId;
  }
  if (input.agentId !== undefined) {
    if (!safeIdentifier(input.agentId)) return null;
    values.agentId ??= input.agentId;
  }
  return Object.keys(values).length === 0 ? {} : values;
}

function inferredResource(
  input: AuthorizationRequest,
  action: string,
  context: PermitContext,
): PermitResource | null {
  if (input.permission.startsWith("tool.execute:")) {
    if (safeIdentifier(context.projectId)) {
      return {
        type: PERMIT_RESOURCE_TYPES.project,
        key: scopedKey("project", context.projectId),
      };
    }
    const toolId = input.context?.toolId ?? context.toolId ?? input.permission.slice("tool.execute:".length);
    return safeIdentifier(toolId)
      ? { type: PERMIT_RESOURCE_TYPES.tool, key: scopedKey("tool", toolId) }
      : null;
  }
  if (input.permission.startsWith("skill.")) {
    const skillId = input.resource?.kind === "skill" ? input.resource.id : "catalog";
    return safeIdentifier(skillId)
      ? { type: PERMIT_RESOURCE_TYPES.skill, key: scopedKey("skill", skillId) }
      : null;
  }
  // ProjectService supplies a Project resource for delegated execution, so
  // `agent.invoke` is evaluated against project:<id> there. An Agent resource
  // is selected only for a genuinely Agent-scoped request with no Project
  // binding; it must never replace the Project membership check.
  const projectId = context.projectId;
  if (safeIdentifier(projectId)) {
    return { type: PERMIT_RESOURCE_TYPES.project, key: scopedKey("project", projectId) };
  }
  const agentId = context.agentId;
  if (safeIdentifier(agentId)) {
    return { type: PERMIT_RESOURCE_TYPES.agent, key: scopedKey("agent", agentId) };
  }
  // A type-level check is valid for project.manage/project.read and is useful
  // for creation/listing. It carries no client-selected instance identity.
  if (action.startsWith("project.") || action === "agent.invoke") {
    return { type: PERMIT_RESOURCE_TYPES.project };
  }
  return { type: PERMIT_RESOURCE_TYPES.project };
}

/** Translate one trusted repository authorization request into a Permit check. */
export function mapAuthorizationRequestToPermitCheck(
  input: AuthorizationRequest,
  options: { tenantKey?: string } = {},
): PermitAuthorizationCheck | null {
  try {
    if (!input || typeof input !== "object" || !principalIsTrusted(input.principal)) {
      return null;
    }
    if (typeof input.permission !== "string") return null;
    const action = ACTIONS[input.permission as PermissionId];
    if (!action) return null;
    const context = contextValues(input);
    if (context === null) return null;

    const mappedResource = input.resource
      ? resourceFromRef(input.resource)
      : inferredResource(input, action, context);
    if (!mappedResource) return null;

    const projectScopedTool =
      input.permission.startsWith("tool.execute:") && safeIdentifier(context.projectId);
    if (
      projectScopedTool &&
      input.resource !== undefined &&
      input.resource.kind !== "tool" &&
      input.resource.kind !== "project"
    ) {
      return null;
    }
    const resource = projectScopedTool
      ? {
          type: PERMIT_RESOURCE_TYPES.project,
          key: scopedKey("project", context.projectId!),
        }
      : mappedResource;

    const projectResourceId =
      input.resource?.kind === "project"
        ? input.resource.id
        : input.resource?.kind === "preview" &&
            input.resource.owner &&
            typeof input.resource.owner === "object" &&
            input.resource.owner.kind === "project"
          ? input.resource.owner.projectId
          : undefined;
    const agentResourceId =
      input.resource?.kind === "agent"
        ? input.resource.id
        : input.resource?.kind === "preview" &&
            input.resource.owner &&
            typeof input.resource.owner === "object" &&
            input.resource.owner.kind === "agent"
          ? input.resource.owner.agentId
          : undefined;
    if (
      projectResourceId !== undefined &&
      context.projectId !== undefined &&
      projectResourceId !== context.projectId
    ) {
      return null;
    }
    if (
      agentResourceId !== undefined &&
      context.agentId !== undefined &&
      agentResourceId !== context.agentId
    ) {
      return null;
    }
    if (
      input.principal.kind === "agent" &&
      context.agentId !== undefined &&
      input.principal.id !== context.agentId
    ) {
      return null;
    }

    if (safeIdentifier(options.tenantKey)) resource.tenant = options.tenantKey;
    else if (options.tenantKey !== undefined) return null;

    const result: PermitAuthorizationCheck = {
      user: scopedKey(input.principal.kind, input.principal.id),
      action,
      resource,
    };
    if (Object.keys(context).length > 0) result.context = context;
    return result;
  } catch {
    // A malformed runtime object must become a normal fail-closed denial at
    // the adapter boundary, never an uncaught provider-facing exception.
    return null;
  }
}

export function permissionToPermitAction(permission: PermissionId): string | null {
  return ACTIONS[permission] ?? null;
}

export function permitResourceKey(kind: "project" | "agent" | "tool" | "skill", id: string): string {
  if (!safeIdentifier(id)) throw new TypeError("Invalid Permit resource identifier");
  return scopedKey(kind, id);
}

export function permitUserKey(principal: Principal): string {
  if (!principalIsTrusted(principal)) throw new TypeError("Invalid Permit principal");
  return scopedKey(principal.kind, principal.id);
}
