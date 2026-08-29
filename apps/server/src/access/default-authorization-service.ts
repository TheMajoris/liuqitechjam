import type {
  AuthorizationRequest,
  AuthorizationService,
} from "./authorization-service.js";

/**
 * The local single-user product currently has no user/role records. Keep the
 * policy permissive while making every privileged preview and Project
 * operation cross a stable authorization seam.
 */
export class DefaultAuthorizationService implements AuthorizationService {
  async require(_input: AuthorizationRequest): Promise<void> {
    return;
  }
}
