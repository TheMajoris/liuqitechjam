import {
  PermitApprovalConflictError,
  PermitApprovalError,
  type PermitAccessRoleAssignment,
  type PermitApprovalCorrelation,
  type PermitApprovalRecord,
  type PermitApprovalRequest,
  type PermitExternalApproval,
} from "./permit-approval-types.js";
import {
  correlationKey,
  projectedStatus,
  requestDetails,
  safeId,
  safeSummary,
} from "./permit-approval-helpers.js";
import { permitResourceKey, permitUserKey } from "./permit-policy.js";
import { PermitApprovalExternalState } from "./permit-approval-external-state.js";
import { PermitApprovalProjection } from "./permit-approval-projection.js";

export interface PermitOperationApprovalWorkflowOptions {
  tenantKey: string;
  operationResource: string;
  projection: PermitApprovalProjection;
  external: PermitApprovalExternalState;
}

/**
 * Owns the temporary Operation Approval lifecycle: request, human decision,
 * one-time claim, and conversion cleanup. It never treats the local
 * correlation projection as an authorization decision.
 */
export class PermitOperationApprovalWorkflow {
  private readonly inFlight = new Map<string, Promise<PermitApprovalRecord>>();
  /** Only the claimant that wins this process-local race may execute. */
  private readonly consumeInFlight = new Map<string, Promise<boolean>>();

  constructor(private readonly options: PermitOperationApprovalWorkflowOptions) {}

  async request(input: PermitApprovalRequest): Promise<PermitApprovalRecord> {
    const details = requestDetails(input, this.options.tenantKey);
    const correlation = this.correlation(input);
    const key = correlationKey(correlation);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.requestNow(details, correlation, input.safeSummary);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  async approve(
    correlation: PermitApprovalCorrelation,
    current: PermitExternalApproval,
  ): Promise<PermitApprovalRecord> {
    const currentStatus = projectedStatus(correlation, current.status);
    if (currentStatus === "approved") {
      const synced = await this.options.projection.sync(correlation, current);
      return this.options.projection.toRecord(synced.correlation, synced.status);
    }
    if (["denied", "revoked", "expired", "consumed"].includes(currentStatus)) {
      throw new PermitApprovalConflictError();
    }
    const approved = await this.options.external.decide({
      decision: () => this.options.external.call((client) =>
        client.approveOperationApproval(correlation.permitRequestId),
      ),
      refresh: () => this.options.external.operation(correlation),
      expected: "approved",
      correlation,
    });
    const synced = await this.options.projection.sync(correlation, approved);
    await this.options.external.recordTransition(
      synced.correlation,
      "approved",
      synced.status,
      "permit_approval_transition",
    );
    return this.options.projection.toRecord(synced.correlation, synced.status);
  }

  async deny(
    correlation: PermitApprovalCorrelation,
    current: PermitExternalApproval,
  ): Promise<PermitApprovalRecord> {
    if (current.status === "denied") {
      const synced = await this.options.projection.sync(correlation, current);
      return this.options.projection.toRecord(synced.correlation, current.status);
    }
    if (current.status !== "pending" && current.status !== "unknown") {
      throw new PermitApprovalConflictError();
    }
    const denied = await this.options.external.decide({
      decision: () => this.options.external.call((client) =>
        client.denyOperationApproval(correlation.permitRequestId),
      ),
      refresh: () => this.options.external.operation(correlation),
      expected: "denied",
      correlation,
    });
    const synced = await this.options.projection.sync(correlation, denied);
    await this.options.external.recordTransition(
      synced.correlation,
      "denied",
      synced.status,
      "permit_approval_transition",
    );
    return this.options.projection.toRecord(synced.correlation, synced.status);
  }

  /**
   * Revoke Permit Elements' temporary `_Approved_` role before execution.
   * Returning false is a deny/retry signal; it is never an authorization
   * result derived from the local projection.
   */
  async consume(input: PermitApprovalRequest): Promise<boolean> {
    const correlation = this.options.projection.findLatest(
      this.correlation(input),
    );
    if (!correlation) return true;
    if (correlation.lastKnownStatus === "consumed" || correlation.lastKnownStatus === "revoked") {
      return false;
    }
    const existing = this.consumeInFlight.get(correlation.permitRequestId);
    if (existing) return false;
    const pending = this.consumeNow(correlation);
    this.consumeInFlight.set(correlation.permitRequestId, pending);
    try {
      return await pending;
    } finally {
      if (this.consumeInFlight.get(correlation.permitRequestId) === pending) {
        this.consumeInFlight.delete(correlation.permitRequestId);
      }
    }
  }

  /** Close a one-time approval when a human converts it to project access. */
  async closeForProject(
    correlation: PermitApprovalCorrelation,
    current: PermitExternalApproval,
  ): Promise<void> {
    if (current.status === "pending" || current.status === "unknown") {
      const denied = await this.options.external.decide({
        decision: () => this.options.external.call((client) =>
          client.denyOperationApproval(correlation.permitRequestId),
        ),
        refresh: () => this.options.external.operation(correlation),
        expected: "denied",
        correlation,
      });
      const synced = await this.options.projection.sync(correlation, denied);
      await this.options.external.recordTransition(
        synced.correlation,
        "denied",
        synced.status,
        "permit_approval_transition",
      );
      return;
    }
    if (current.status !== "approved") throw new PermitApprovalConflictError();

    await this.options.external.call((client) =>
      client.unassignOperationApproval(this.operationAssignment(correlation)),
    );
    const confirmed = await this.options.external.operation(correlation);
    if (confirmed.status !== "approved") throw new PermitApprovalError();
    const revoked = await this.options.projection.mark(correlation, "revoked");
    await this.options.external.recordTransition(
      revoked,
      "revoked",
      "revoked",
      "permit_approval_transition",
    );
  }

  private correlation(input: PermitApprovalRequest): Omit<
    PermitApprovalCorrelation,
    "permitRequestId" | "safeSummary" | "lastKnownStatus" | "createdAt" | "updatedAt"
  > {
    return {
      kind: "operation_approval",
      agentId: safeId(input.agentId),
      projectId: input.projectId === undefined ? null : safeId(input.projectId),
      runId: input.runId === undefined ? null : safeId(input.runId),
      toolId: safeId(input.toolId),
    };
  }

  private async requestNow(
    details: ReturnType<typeof requestDetails>,
    correlation: Omit<
      PermitApprovalCorrelation,
      "permitRequestId" | "safeSummary" | "lastKnownStatus" | "createdAt" | "updatedAt"
    >,
    providedSummary: string | undefined,
  ): Promise<PermitApprovalRecord> {
    const existing = this.options.projection.findLatest(correlation, ["pending", "approved"]);
    if (existing) {
      const current = await this.options.external.operation(existing);
      const synced = await this.options.projection.sync(existing, current);
      if (current.status === "pending" || current.status === "approved") {
        return this.options.projection.toRecord(synced.correlation, current.status);
      }
    }
    try {
      const created = await this.options.external.call((client) =>
        client.createOperationApproval({
          ...details,
          resource: this.options.operationResource,
          reason: safeSummary(providedSummary, details.reason),
        }),
      );
      const projection = await this.options.projection.add({
        permitRequestId: created.id,
        ...correlation,
        safeSummary: safeSummary(providedSummary, details.reason),
        lastKnownStatus: created.status,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      }, created);
      await this.options.external.recordTransition(
        projection,
        "requested",
        created.status,
        "permit_approval_transition",
      );
      return this.options.projection.toRecord(projection, created.status);
    } catch (error) {
      if (error instanceof PermitApprovalError || error instanceof PermitApprovalConflictError) {
        throw error;
      }
      throw new PermitApprovalError();
    }
  }

  private async consumeNow(correlation: PermitApprovalCorrelation): Promise<boolean> {
    const current = await this.options.external.operation(correlation);
    const status = projectedStatus(correlation, current.status);
    if (status !== "approved") {
      await this.options.projection.sync(correlation, current);
      return false;
    }
    await this.options.external.call((client) =>
      client.unassignOperationApproval(this.operationAssignment(correlation)),
    );
    const consumed = await this.options.projection.mark(correlation, "consumed");
    await this.options.external.recordTransition(
      consumed,
      "consumed",
      "consumed",
      "permit_approval_transition",
    );
    return true;
  }

  private operationAssignment(
    correlation: PermitApprovalCorrelation,
  ): PermitAccessRoleAssignment {
    return {
      user: permitUserKey({ kind: "agent", id: correlation.agentId }),
      role: "_Approved_",
      tenant: this.options.tenantKey,
      resourceInstance: correlation.projectId === null
        ? permitResourceKey("tool", correlation.toolId)
        : permitResourceKey("project", correlation.projectId),
    };
  }
}
