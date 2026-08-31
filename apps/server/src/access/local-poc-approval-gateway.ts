import {
  PermitApprovalError,
  type PermitApprovalListFilter,
  type PermitApprovalRecord,
  type PermitApprovalRequest,
  type PermitApprovalScope,
  type PermitProjectAccessRequest,
} from "./permit-approval-types.js";
import type { ToolApprovalGateway } from "../tools/tool-service.js";

/**
 * Local POC seam for the second, Permit-specific tool approval check.
 *
 * RepositoryAuthorizationService still decides whether an Agent can use a
 * tool. This gateway only acknowledges that the external Permit approval
 * step is intentionally disabled for a loopback-only development process.
 * API-facing approval operations remain unavailable in this mode.
 */
export class LocalPocApprovalGateway implements ToolApprovalGateway {
  isAvailable(): boolean {
    return true;
  }

  async consumeOperationApproval(_input: PermitApprovalRequest): Promise<boolean> {
    return true;
  }

  async requestOperationApproval(_input: PermitApprovalRequest): Promise<PermitApprovalRecord> {
    throw new PermitApprovalError("Permit approvals are disabled in local POC mode", 503);
  }

  async listApprovals(_filter: PermitApprovalListFilter = {}): Promise<PermitApprovalRecord[]> {
    return [];
  }

  async getApproval(_id: string): Promise<PermitApprovalRecord> {
    throw new PermitApprovalError("Permit approvals are disabled in local POC mode", 503);
  }

  async approve(
    _id: string,
    _scope: PermitApprovalScope = "once",
  ): Promise<PermitApprovalRecord> {
    throw new PermitApprovalError("Permit approvals are disabled in local POC mode", 503);
  }

  async deny(_id: string): Promise<PermitApprovalRecord> {
    throw new PermitApprovalError("Permit approvals are disabled in local POC mode", 503);
  }

  async grantProjectAccess(_input: PermitProjectAccessRequest): Promise<PermitApprovalRecord> {
    throw new PermitApprovalError("Permit approvals are disabled in local POC mode", 503);
  }

  async listProjectAccess(
    _agentId: string,
    _projectId?: string,
  ): Promise<PermitApprovalRecord[]> {
    return [];
  }

  async revokeProjectAccess(_id: string): Promise<PermitApprovalRecord> {
    throw new PermitApprovalError("Permit approvals are disabled in local POC mode", 503);
  }
}
