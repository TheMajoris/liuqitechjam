import type { PermissionId } from "./permission-types.js";
import { HttpError } from "../errors.js";
import type {
  AuthorizationContext,
  AuthorizationDecision,
  Principal,
  ResourceRef,
} from "./access-types.js";

export type {
  AgentPrincipal,
  AuthorizationContext,
  AuditEvent,
  CapabilityGrant,
  HumanPrincipal,
  Principal,
  ResourceRef,
} from "./access-types.js";
export {
  agentPrincipal,
  DEMO_HUMAN_PRINCIPAL,
  humanPrincipal,
  principalKey,
} from "./access-types.js";

export type AuthorizationErrorCode = "PERMISSION_DENIED";

/** A stable error emitted by trusted authorization boundaries. */
export class AuthorizationError extends HttpError {
  readonly code: AuthorizationErrorCode = "PERMISSION_DENIED";
  readonly errorCode: AuthorizationErrorCode = "PERMISSION_DENIED";

  constructor(
    message = "You are not authorized to perform this operation",
    readonly reason?: string,
  ) {
    super(403, message);
    this.name = "AuthorizationError";
  }
}

export function isAuthorizationError(error: unknown): error is AuthorizationError {
  return error instanceof AuthorizationError;
}

/** A normalized request used by all trusted policy checks. */
export interface AuthorizationRequest {
  /** Required at trusted call sites; optional only for Wave 7 compatibility. */
  principal?: Principal;
  permission: PermissionId;
  resource?: ResourceRef;
  context?: AuthorizationContext;
  /** Legacy fields are normalized to a principal/resource by implementations. */
  agentId?: string | undefined;
  projectId?: string | undefined;
}

export type { AuthorizationDecision } from "./access-types.js";

export interface AuthorizationService {
  decide(input: AuthorizationRequest): Promise<AuthorizationDecision>;
  require(input: AuthorizationRequest): Promise<void>;
}
