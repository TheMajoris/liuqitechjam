import type { PermissionId } from "./permission-types.js";

export interface AuthorizationService {
  require(input: { agentId: string; permission: PermissionId }): Promise<void>;
}

