import type { PermissionId } from "./permission-types.js";

/**
 * Subject and resource of a privileged operation.
 *
 * Agent-scoped operations carry `agentId`; Project-scoped operations carry
 * `projectId`. Both may be present when an Agent acts on a Project.
 */
export interface AuthorizationRequest {
  permission: PermissionId;
  agentId?: string | undefined;
  projectId?: string | undefined;
}

export interface AuthorizationService {
  require(input: AuthorizationRequest): Promise<void>;
}
