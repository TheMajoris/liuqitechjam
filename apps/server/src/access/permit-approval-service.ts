import type { Storage } from "../store.js";
import {
  PermitApprovalConflictError,
  PermitApprovalError,
  type PermitApprovalClient,
  type PermitApprovalCorrelation,
  type PermitApprovalListFilter,
  type PermitApprovalRecord,
  type PermitApprovalRequest,
  type PermitApprovalScope,
  type PermitApprovalServiceOptions,
  type PermitExternalApproval,
  type PermitProjectAccessRequest,
} from "./permit-approval-types.js";
import { permitUserKey } from "./permit-policy.js";
import { defaultProjectAccessRole, validId } from "./permit-approval-helpers.js";
import { PermitApprovalExternalState } from "./permit-approval-external-state.js";
import { PermitApprovalProjection } from "./permit-approval-projection.js";
import { PermitOperationApprovalWorkflow } from "./permit-operation-approval-workflow.js";
import { PermitProjectAccessWorkflow } from "./permit-project-access-workflow.js";

export {
  PermitApprovalConflictError,
  PermitApprovalError,
  PERMIT_APPROVAL_CONFLICT_CODE,
  PERMIT_APPROVAL_ERROR_CODE,
} from "./permit-approval-types.js";
export type {
  PermitAccessRequestInput,
  PermitAccessRoleAssignment,
  PermitApprovalClient,
  PermitApprovalCorrelation,
  PermitApprovalKind,
  PermitApprovalListFilter,
  PermitApprovalRequest,
  PermitApprovalRecord,
  PermitApprovalScope,
  PermitApprovalServiceOptions,
  PermitApprovalStatus,
  PermitExternalApproval,
  PermitProjectAccessRequest,
} from "./permit-approval-types.js";
export { PermitHttpApprovalClient, createPermitApprovalClient } from "./permit-approval-http-client.js";
export type { PermitApprovalHttpConfig } from "./permit-approval-http-client.js";

/**
 * Compatibility facade for the application approval seam. Each workflow is
 * responsible for one external Permit lifecycle; this class only coordinates
 * them and exposes the stable methods used by ToolService and the API.
 */
export class PermitApprovalService {
  private readonly tenantKey: string;
  private readonly operationResource: string;
  private readonly projection: PermitApprovalProjection;
  private readonly external: PermitApprovalExternalState;
  private readonly operation: PermitOperationApprovalWorkflow;
  private readonly projectAccess: PermitProjectAccessWorkflow;

  constructor(
    store: Storage,
    client: PermitApprovalClient | null | undefined,
    options: PermitApprovalServiceOptions,
  ) {
    this.tenantKey = validId(options.tenantKey) ? options.tenantKey : "default";
    this.operationResource = validId(options.operationResource ?? "project")
      ? options.operationResource ?? "project"
      : "project";
    this.projection = new PermitApprovalProjection(store);
    this.external = new PermitApprovalExternalState(client, options.audit, options.telemetry);
    this.operation = new PermitOperationApprovalWorkflow({
      tenantKey: this.tenantKey,
      operationResource: this.operationResource,
      projection: this.projection,
      external: this.external,
    });
    this.projectAccess = new PermitProjectAccessWorkflow({
      tenantKey: this.tenantKey,
      projectAccessRole: options.projectAccessRole ?? defaultProjectAccessRole,
      projection: this.projection,
      external: this.external,
    });
  }

  isAvailable(): boolean {
    return this.external.isAvailable();
  }

  requestOperationApproval(input: PermitApprovalRequest): Promise<PermitApprovalRecord> {
    return this.operation.request(input);
  }

  async listApprovals(filter: PermitApprovalListFilter = {}): Promise<PermitApprovalRecord[]> {
    const correlations = this.projection.list(filter);
    const operationItems = filter.kind === "access_request"
      ? []
      : await this.external.call((client) => client.listOperationApprovals({
          ...(filter.status === undefined ? {} : { status: filter.status }),
          resource: this.operationResource,
        }));
    // API-only Access Request listing is user-scoped. Query only Agent
    // identities represented in the local correlation projection.
    const accessAgentIds = [...new Set(
      correlations
        .filter((item) => item.kind === "access_request")
        .map((item) => item.agentId),
    )];
    const accessItems = filter.kind === "operation_approval"
      ? []
      : (await Promise.all(
          accessAgentIds.map((agentId) => this.external.call((client) =>
            client.listAccessRequests(
              {
                userId: permitUserKey({ kind: "agent", id: agentId }),
                tenantId: this.tenantKey,
              },
              filter.status === undefined ? {} : { status: filter.status },
            ),
          )),
        )).flat();
    const external = new Map<string, PermitExternalApproval>();
    for (const item of [...operationItems, ...accessItems]) external.set(item.id, item);
    const records = await Promise.all(
      correlations
        .filter((item) => external.has(item.permitRequestId))
        .map(async (item) => {
          const current = external.get(item.permitRequestId)!;
          const synced = await this.projection.sync(item, current);
          return this.projection.toRecord(synced.correlation, synced.status);
        }),
    );
    return records
      .filter((item) => filter.status === undefined || item.status === filter.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getApproval(id: string): Promise<PermitApprovalRecord> {
    const correlation = this.projection.find(id);
    const current = await this.getExternal(correlation);
    const synced = await this.projection.sync(correlation, current);
    return this.projection.toRecord(synced.correlation, synced.status);
  }

  async approve(id: string, scope: PermitApprovalScope = "once"): Promise<PermitApprovalRecord> {
    const correlation = this.projection.find(id);
    const current = await this.getExternal(correlation);
    if (correlation.kind === "access_request") {
      return this.projectAccess.approve(correlation, current);
    }
    if (scope === "project") {
      if (correlation.projectId === null) {
        throw new PermitApprovalError("Project access requires a Project", 422);
      }
      const access = await this.projectAccess.grant({
        agentId: correlation.agentId,
        projectId: correlation.projectId,
        ...(correlation.runId === null ? {} : { runId: correlation.runId }),
        toolId: correlation.toolId,
        safeSummary: correlation.safeSummary,
      });
      try {
        await this.operation.closeForProject(correlation, current);
        return access;
      } catch (error) {
        // Conversion is atomic from the caller's perspective: clean up the
        // new persistent Permit role if the original approval cannot close.
        await this.projectAccess.revoke(this.projection.find(access.id)).catch(() => undefined);
        if (error instanceof PermitApprovalError || error instanceof PermitApprovalConflictError) {
          throw error;
        }
        throw new PermitApprovalError();
      }
    }
    return this.operation.approve(correlation, current);
  }

  async deny(id: string): Promise<PermitApprovalRecord> {
    const correlation = this.projection.find(id);
    const current = await this.getExternal(correlation);
    return correlation.kind === "access_request"
      ? this.projectAccess.deny(correlation, current)
      : this.operation.deny(correlation, current);
  }

  consumeOperationApproval(input: PermitApprovalRequest): Promise<boolean> {
    return this.operation.consume(input);
  }

  grantProjectAccess(input: PermitProjectAccessRequest): Promise<PermitApprovalRecord> {
    return this.projectAccess.grant(input);
  }

  listProjectAccess(agentId: string, projectId?: string): Promise<PermitApprovalRecord[]> {
    return this.listApprovals({
      kind: "access_request",
      agentId,
      ...(projectId === undefined ? {} : { projectId }),
    });
  }

  async revokeProjectAccess(id: string): Promise<PermitApprovalRecord> {
    const correlation = this.projection.find(id);
    if (correlation.kind !== "access_request" || correlation.projectId === null) {
      throw new PermitApprovalError("Project access grant not found", 404);
    }
    return this.projectAccess.revoke(correlation);
  }

  private async getExternal(
    correlation: PermitApprovalCorrelation,
  ): Promise<PermitExternalApproval> {
    return correlation.kind === "operation_approval"
      ? this.external.operation(correlation)
      : this.external.access(correlation, this.projectAccess.accessInput(correlation));
  }
}
