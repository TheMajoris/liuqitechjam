/**
 * Kept as a small compatibility module so callers can import the contract
 * without pulling in the policy implementation.
 */
export type {
  AuthorizationContext,
  AuthorizationDecision,
  Principal,
  ResourceRef,
} from "./access-types.js";
