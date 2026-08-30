import type { JsonStore } from "../store.js";
import {
  AuthorizationError,
  type AuthorizationRequest,
  type AuthorizationService,
} from "./authorization-service.js";
import type { PermissionId } from "./permission-types.js";

/**
 * Applies the repository role-template ceiling before the configured policy
 * authority. A custom role can narrow Permit/local access, never broaden it.
 */
export class RoleTemplateAuthorizationService implements AuthorizationService {
  constructor(
    private readonly store: JsonStore,
    private readonly delegate: AuthorizationService,
  ) {}

  async decide(input: AuthorizationRequest) {
    const denial = this.roleDenial(input);
    if (denial) return denial;
    return this.delegate.decide(input);
  }

  async require(input: AuthorizationRequest): Promise<void> {
    const denial = this.roleDenial(input);
    if (denial) throw new AuthorizationError(denial.reason, denial.reason);
    await this.delegate.require(input);
  }

  private roleDenial(input: AuthorizationRequest): {
    result: "deny";
    reason: string;
    errorCode: "PERMISSION_DENIED";
  } | null {
    const principal = input.principal;
    const projectId = input.context?.projectId ?? input.projectId;
    if (principal?.kind !== "agent" || !projectId) return null;
    const snapshot = this.store.snapshot();
    const attachment = snapshot.projectAgents.find(
      (item) => item.projectId === projectId && item.agentId === principal.id,
    );
    if (!attachment?.roleId) return null;
    const role = snapshot.roles.find((item) => item.id === attachment.roleId);
    if (!role) return null;
    if (role.permissionIds.includes(input.permission as PermissionId)) return null;
    return {
      result: "deny",
      reason: "The assigned Project role does not include " + input.permission,
      errorCode: "PERMISSION_DENIED",
    };
  }
}
