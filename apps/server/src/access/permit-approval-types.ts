import { HttpError } from "../errors.js";
import type {
  PermitApprovalCorrelation,
  PermitApprovalKind,
  PermitApprovalStatus,
} from "./access-types.js";
import type { AuditRecorder } from "../audit/audit-types.js";
import type { RuntimeTelemetry } from "../telemetry/telemetry-types.js";

export type PermitApprovalScope = "once" | "project";

export interface PermitApprovalRecord {
  id: string;
  kind: PermitApprovalKind;
  scope: PermitApprovalScope;
  agentId: string;
  projectId: string | null;
  runId: string | null;
  toolId: string;
  safeSummary: string;
  status: PermitApprovalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PermitApprovalRequest {
  agentId: string;
  projectId?: string;
  runId?: string;
  toolId: string;
  /** Callers may provide context, but it is redacted and never a policy fact. */
  safeSummary?: string;
}

export interface PermitProjectAccessRequest extends PermitApprovalRequest {
  projectId: string;
}

export interface PermitApprovalListFilter {
  agentId?: string | undefined;
  projectId?: string | undefined;
  status?: PermitApprovalStatus | undefined;
  kind?: PermitApprovalKind | undefined;
}

export interface PermitExternalApproval {
  id: string;
  status: PermitApprovalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PermitOperationApprovalInput {
  userId: string;
  tenantId: string;
  resource: string;
  resourceInstance: string;
  reason: string;
}

export interface PermitAccessRequestInput extends PermitOperationApprovalInput {
  role: string;
}

export interface PermitAccessRoleAssignment {
  user: string;
  role: string;
  tenant: string;
  resourceInstance: string;
}

/**
 * Small external surface for approvals. All production HTTP/SDK details stay
 * behind this interface, so service and ToolService tests use deterministic
 * fakes without contacting Permit.
 */
export interface PermitApprovalClient {
  createOperationApproval(input: PermitOperationApprovalInput): Promise<PermitExternalApproval>;
  getOperationApproval(id: string): Promise<PermitExternalApproval>;
  listOperationApprovals(filter?: {
    status?: PermitApprovalStatus;
    resource?: string;
    resourceInstance?: string;
  }): Promise<readonly PermitExternalApproval[]>;
  approveOperationApproval(id: string): Promise<PermitExternalApproval>;
  denyOperationApproval(id: string): Promise<PermitExternalApproval>;
  createAccessRequest(input: PermitAccessRequestInput): Promise<PermitExternalApproval>;
  getAccessRequest(id: string, input: PermitAccessRequestInput): Promise<PermitExternalApproval>;
  listAccessRequests(
    input: Pick<PermitAccessRequestInput, "userId" | "tenantId">,
    filter?: { status?: PermitApprovalStatus; resource?: string; resourceInstance?: string },
  ): Promise<readonly PermitExternalApproval[]>;
  approveAccessRequest(id: string, input: PermitAccessRequestInput): Promise<PermitExternalApproval>;
  denyAccessRequest(id: string, input: PermitAccessRequestInput): Promise<PermitExternalApproval>;
  /** Remove Permit Elements' temporary `_Approved_` role after one use. */
  unassignOperationApproval(assignment: PermitAccessRoleAssignment): Promise<void>;
  unassignProjectAccess(assignment: PermitAccessRoleAssignment): Promise<void>;
}

export interface PermitApprovalServiceOptions {
  tenantKey: string;
  operationResource?: string;
  projectAccessRole?: (toolId: string) => string;
  audit?: AuditRecorder;
  telemetry?: RuntimeTelemetry;
}

export const PERMIT_APPROVAL_ERROR_CODE = "PERMIT_APPROVAL_UNAVAILABLE" as const;
export const PERMIT_APPROVAL_CONFLICT_CODE = "PERMIT_APPROVAL_CONFLICT" as const;

/** Stable errors; provider bodies, URLs, and credentials never cross this seam. */
export class PermitApprovalError extends HttpError {
  readonly code: string = PERMIT_APPROVAL_ERROR_CODE;

  constructor(message = "Permit approval is unavailable", statusCode = 503) {
    super(statusCode, message);
    this.name = "PermitApprovalError";
  }
}

export class PermitApprovalConflictError extends PermitApprovalError {
  readonly code = PERMIT_APPROVAL_CONFLICT_CODE;

  constructor() {
    super("Permit approval changed concurrently", 409);
    this.name = "PermitApprovalConflictError";
  }
}

export type { PermitApprovalCorrelation, PermitApprovalKind, PermitApprovalStatus };
