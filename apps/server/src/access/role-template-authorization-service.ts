import type { Storage } from "../store.js";
import {
  AuthorizationError,
  type AuthorizationRequest,
  type AuthorizationService,
} from "./authorization-service.js";
import type { PermissionId } from "./permission-types.js";

/**
 * Applies the repository role-template ceiling before the project policy
 * authority. A custom role can narrow access, never broaden it.
 */
export class RoleTemplateAuthorizationService implements AuthorizationService {
  constructor(
    private readonly store: Storage,
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
    if (principal?.kind !== "agent") return null;
    const snapshot = this.store.snapshot();
    // The Agent's own role is the ceiling in every Workspace; the repository
    // authorization service still performs the independent membership/access
    // check below it.
    const roleId = (snapshot.agents ?? []).find(
      (item) => item.id === principal.id,
    )?.globalRoleId;
    if (!roleId) return null;
    const role = snapshot.roles.find((item) => item.id === roleId);
    if (!role) return null;
    if (role.permissionIds.includes(input.permission as PermissionId)) return null;
    return {
      result: "deny",
      reason: "The assigned Agent role does not include " + input.permission,
      errorCode: "PERMISSION_DENIED",
    };
  }
}
