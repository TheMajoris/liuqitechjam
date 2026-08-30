import {
  PermitApprovalConflictError,
  PermitApprovalError,
  type PermitAccessRequestInput,
  type PermitAccessRoleAssignment,
  type PermitApprovalCorrelation,
  type PermitApprovalRecord,
  type PermitExternalApproval,
  type PermitProjectAccessRequest,
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

export interface PermitProjectAccessWorkflowOptions {
  tenantKey: string;
  projectAccessRole: (toolId: string) => string;
  projection: PermitApprovalProjection;
  external: PermitApprovalExternalState;
}

/**
 * Owns persistent Project access requests. Approval is converted into a
 * Permit role assignment; the local projection only correlates that external
 * grant for the Agent/Run/Project UX.
 */
export class PermitProjectAccessWorkflow {
  private readonly inFlight = new Map<string, Promise<PermitApprovalRecord>>();
  private readonly revokeInFlight = new Map<string, Promise<PermitApprovalRecord>>();

  constructor(private readonly options: PermitProjectAccessWorkflowOptions) {}

  async grant(input: PermitProjectAccessRequest): Promise<PermitApprovalRecord> {
    const correlation = this.correlation(input);
    const key = projectAccessKey(correlation);
    const existingInFlight = this.inFlight.get(key);
    if (existingInFlight) return existingInFlight;
    const pending = this.grantNow(input, correlation);
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
    return this.approveExisting(correlation);
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
    const input = this.accessInput(correlation);
    const denied = await this.options.external.decide({
      decision: () => this.options.external.call((client) =>
        client.denyAccessRequest(correlation.permitRequestId, input),
      ),
      refresh: () => this.options.external.access(correlation, input),
      expected: "denied",
      correlation,
    });
    const synced = await this.options.projection.sync(correlation, denied);
    await this.options.external.recordTransition(
      synced.correlation,
      "denied",
      synced.status,
      "permit_project_access_transition",
    );
    return this.options.projection.toRecord(synced.correlation, synced.status);
  }

  async revoke(correlation: PermitApprovalCorrelation): Promise<PermitApprovalRecord> {
    if (correlation.projectId === null) {
      throw new PermitApprovalError("Project access grant not found", 404);
    }
    if (correlation.lastKnownStatus === "revoked") {
      return this.options.projection.toRecord(correlation, "revoked");
    }
    const existing = this.revokeInFlight.get(correlation.permitRequestId);
    if (existing) return existing;
    const pending = this.revokeNow(correlation);
    this.revokeInFlight.set(correlation.permitRequestId, pending);
    try {
      return await pending;
    } finally {
      if (this.revokeInFlight.get(correlation.permitRequestId) === pending) {
        this.revokeInFlight.delete(correlation.permitRequestId);
      }
    }
  }

  accessInput(correlation: PermitApprovalCorrelation): PermitAccessRequestInput {
    if (correlation.projectId === null) {
      throw new PermitApprovalError("Project access requires a Project", 422);
    }
    return {
      userId: permitUserKey({ kind: "agent", id: correlation.agentId }),
      tenantId: this.options.tenantKey,
      resource: "project",
      resourceInstance: permitResourceKey("project", correlation.projectId),
      role: this.options.projectAccessRole(correlation.toolId),
      reason: correlation.safeSummary,
    };
  }

  private correlation(input: PermitProjectAccessRequest): {
    kind: "access_request";
    agentId: string;
    projectId: string;
    runId: string | null;
    toolId: string;
  } {
    return {
      kind: "access_request",
      agentId: safeId(input.agentId),
      projectId: safeId(input.projectId),
      runId: input.runId === undefined ? null : safeId(input.runId),
      toolId: safeId(input.toolId),
    };
  }

  private async grantNow(
    input: PermitProjectAccessRequest,
    correlation: ReturnType<PermitProjectAccessWorkflow["correlation"]>,
  ): Promise<PermitApprovalRecord> {
    const details = requestDetails(input, this.options.tenantKey);
    const key = projectAccessKey(correlation);
    const candidates = this.options.projection.list({ kind: "access_request" })
      .filter((item) =>
        item.lastKnownStatus !== "revoked" &&
        projectAccessKey(item) === key,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const existing of candidates) {
      const current = await this.options.external.access(existing, this.accessInput(existing));
      const synced = await this.options.projection.sync(existing, current);
      if (synced.status === "approved") {
        return this.options.projection.toRecord(synced.correlation, synced.status);
      }
      if (synced.status === "pending") return this.approveExisting(synced.correlation);
      // An indeterminate request may already have been approved remotely;
      // never create a duplicate persistent grant until it is confirmed.
      if (synced.status === "unknown") throw new PermitApprovalError();
    }

    const accessInput: PermitAccessRequestInput = {
      ...details,
      role: this.options.projectAccessRole(correlation.toolId),
      reason: safeSummary(
        input.safeSummary,
        "Allow Project access for " + correlation.toolId + " to Agent " + correlation.agentId,
      ),
    };
    try {
      const created = await this.options.external.call((client) =>
        client.createAccessRequest(accessInput),
      );
      const approved = created.status === "approved"
        ? created
        : await this.options.external.decide({
            decision: () => this.options.external.call((client) =>
              client.approveAccessRequest(created.id, accessInput),
            ),
            refresh: () => this.options.external.call((client) =>
              client.getAccessRequest(created.id, accessInput),
            ),
            expected: "approved",
          });
      const projection = await this.options.projection.add({
        permitRequestId: created.id,
        ...correlation,
        safeSummary: accessInput.reason,
        lastKnownStatus: approved.status,
        createdAt: created.createdAt,
        updatedAt: approved.updatedAt,
      }, approved);
      await this.options.external.recordTransition(
        projection,
        "approved",
        approved.status,
        "permit_project_access_transition",
      );
      return this.options.projection.toRecord(projection, approved.status);
    } catch (error) {
      if (error instanceof PermitApprovalError || error instanceof PermitApprovalConflictError) {
        throw error;
      }
      throw new PermitApprovalError();
    }
  }

  private async approveExisting(
    correlation: PermitApprovalCorrelation,
  ): Promise<PermitApprovalRecord> {
    const input = this.accessInput(correlation);
    const approved = await this.options.external.decide({
      decision: () => this.options.external.call((client) =>
        client.approveAccessRequest(correlation.permitRequestId, input),
      ),
      refresh: () => this.options.external.access(correlation, input),
      expected: "approved",
      correlation,
    });
    const synced = await this.options.projection.sync(correlation, approved);
    await this.options.external.recordTransition(
      synced.correlation,
      "approved",
      synced.status,
      "permit_project_access_transition",
    );
    return this.options.projection.toRecord(synced.correlation, synced.status);
  }

  private async revokeNow(
    correlation: PermitApprovalCorrelation,
  ): Promise<PermitApprovalRecord> {
    const current = await this.options.external.access(correlation, this.accessInput(correlation));
    const currentStatus = projectedStatus(correlation, current.status);
    if (currentStatus === "revoked") {
      const synced = await this.options.projection.sync(correlation, current);
      return this.options.projection.toRecord(synced.correlation, "revoked");
    }
    if (currentStatus !== "approved") throw new PermitApprovalConflictError();
    try {
      await this.options.external.call((client) =>
        client.unassignProjectAccess(this.assignment(correlation)),
      );
    } catch {
      throw new PermitApprovalError();
    }
    const revoked = await this.options.projection.mark(correlation, "revoked");
    await this.options.external.recordTransition(
      revoked,
      "revoked",
      "revoked",
      "permit_project_access_transition",
    );
    return this.options.projection.toRecord(revoked, "revoked");
  }

  private assignment(correlation: PermitApprovalCorrelation): PermitAccessRoleAssignment {
    if (correlation.projectId === null) {
      throw new PermitApprovalError("Project access grant not found", 404);
    }
    return {
      user: permitUserKey({ kind: "agent", id: correlation.agentId }),
      role: this.options.projectAccessRole(correlation.toolId),
      tenant: this.options.tenantKey,
      resourceInstance: permitResourceKey("project", correlation.projectId),
    };
  }
}

/** Persistent Project access is intentionally keyed independently of a run. */
export function projectAccessKey(input: {
  agentId: string;
  projectId: string | null;
  toolId: string;
}): string {
  return correlationKey({
    kind: "access_request",
    agentId: input.agentId,
    projectId: input.projectId,
    runId: null,
    toolId: input.toolId,
  });
}
