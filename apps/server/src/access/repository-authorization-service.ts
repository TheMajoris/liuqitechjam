import type { JsonStore } from "../store.js";
import {
  AuthorizationError,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AuthorizationService,
  DEMO_HUMAN_PRINCIPAL,
} from "./authorization-service.js";
import type { PermissionId } from "./permission-types.js";
import type { Principal } from "./access-types.js";
import { principalKey } from "./access-types.js";
import { roleAllows } from "./role-policy.js";

/** The role names are intentionally fixed in Wave 8. */
export const PROJECT_ROLES = ["owner", "editor", "viewer"] as const;

function principalFromRequest(input: AuthorizationRequest): Principal {
  if (input.principal !== undefined) return input.principal;
  if (input.agentId !== undefined) {
    return { kind: "agent", id: input.agentId };
  }
  return DEMO_HUMAN_PRINCIPAL;
}

function projectIdFromRequest(input: AuthorizationRequest): string | undefined {
  if (input.resource?.kind === "project") return input.resource.id;
  if (input.resource?.kind === "preview" && input.resource.owner.kind === "project") {
    return input.resource.owner.projectId;
  }
  return input.context?.projectId ?? input.projectId;
}

function agentIdFromRequest(input: AuthorizationRequest): string | undefined {
  if (input.resource?.kind === "agent") return input.resource.id;
  if (input.resource?.kind === "preview" && input.resource.owner.kind === "agent") {
    return input.resource.owner.agentId;
  }
  return input.context?.agentId ?? input.agentId;
}

function denyReason(permission: PermissionId): string {
  return "Permission denied for " + permission;
}

/**
 * Repository-backed fixed-role policy for Project authority.
 *
 * This service deliberately accepts only trusted principals from service
 * callers. The HTTP layer resolves the deterministic human principal, while
 * AgentService derives an Agent principal from the Agent record it is about
 * to execute. Legacy `agentId`/`projectId` fields are normalized for the Wave
 * 7 authorization seam and are never treated as a browser-supplied role.
 */
export class RepositoryAuthorizationService implements AuthorizationService {
  constructor(private readonly store: JsonStore) {}

  async decide(input: AuthorizationRequest): Promise<AuthorizationDecision> {
    const principal = principalFromRequest(input);
    const projectId = projectIdFromRequest(input);
    const agentId = agentIdFromRequest(input);

    // Agent-owned preview operations are still controlled by the human demo
    // owner. An Agent may operate only on its own preview when the operation is
    // reached through a trusted internal tool/runtime boundary.
    if (input.permission.startsWith("preview.") && projectId === undefined) {
      if (
        principal.kind === "human" &&
        principal.id === DEMO_HUMAN_PRINCIPAL.id
      ) {
        return { result: "allow", reason: "Demo owner may manage Agent previews" };
      }
      if (principal.kind === "agent" && agentId === principal.id) {
        return { result: "allow", reason: "Agent may manage its own preview" };
      }
      return {
        result: "deny",
        reason: denyReason(input.permission),
        errorCode: "PERMISSION_DENIED",
      };
    }

    if (projectId !== undefined) {
      const project = this.store
        .snapshot()
        .projects.find((item) => item.id === projectId);
      if (!project || project.status !== "active") {
        return {
          result: "deny",
          reason: denyReason(input.permission),
          errorCode: "PERMISSION_DENIED",
        };
      }

      if (principal.kind === "human") {
        const ownerId = project.ownerPrincipalId ?? DEMO_HUMAN_PRINCIPAL.id;
        if (principal.id === ownerId || principalKey(principal) === ownerId) {
          return { result: "allow", reason: "Project owner" };
        }
        return {
          result: "deny",
          reason: denyReason(input.permission),
          errorCode: "PERMISSION_DENIED",
        };
      }

      // Agent identity and membership are resolved from the repository. The
      // request cannot select a different role or project than this record.
      if (agentId !== undefined && agentId !== principal.id) {
        return {
          result: "deny",
          reason: denyReason(input.permission),
          errorCode: "PERMISSION_DENIED",
        };
      }
      const attachment = this.store
        .snapshot()
        .projectAgents.find(
          (item) => item.projectId === projectId && item.agentId === principal.id,
        );
      // The editor fallback is only for legacy attachments whose role field is
      // absent. A missing attachment is not membership and must never inherit
      // delegated Project authority.
      if (!attachment) {
        return {
          result: "deny",
          reason: denyReason(input.permission),
          errorCode: "PERMISSION_DENIED",
        };
      }
      const role = attachment.role ?? "editor";
      if (roleAllows(role, input.permission)) {
        return {
          result: "allow",
          reason: "Project membership role: " + role,
        };
      }
      return {
        result: "deny",
        reason: denyReason(input.permission),
        errorCode: "PERMISSION_DENIED",
      };
    }

    // Project creation/listing and the legacy Agent preview routes are owned
    // by the deterministic local human. An Agent without a Project context
    // has no delegated authority in this wave.
    if (principal.kind === "human" && principal.id === DEMO_HUMAN_PRINCIPAL.id) {
      return { result: "allow", reason: "Demo owner" };
    }
    return {
      result: "deny",
      reason: denyReason(input.permission),
      errorCode: "PERMISSION_DENIED",
    };
  }

  async require(input: AuthorizationRequest): Promise<void> {
    const decision = await this.decide(input);
    if (decision.result === "allow") return;
    throw new AuthorizationError(
      "You are not authorized to perform this operation",
      decision.reason,
    );
  }
}

export { principalFromRequest, projectIdFromRequest, agentIdFromRequest, roleAllows as projectRoleAllowed };
