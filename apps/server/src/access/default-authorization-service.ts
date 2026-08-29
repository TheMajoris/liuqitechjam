import type { AuthorizationService } from "./authorization-service.js";
import type { PermissionId } from "./permission-types.js";

/**
 * The local single-user product currently has no user/role records. Keep the
 * policy permissive while making every privileged preview operation cross a
 * stable authorization seam.
 */
export class DefaultAuthorizationService implements AuthorizationService {
  async require(_input: { agentId: string; permission: PermissionId }): Promise<void> {
    return;
  }
}

