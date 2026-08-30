import { humanPrincipal } from "./authorization-service.js";
import type { AuditEventType, AuditRecorder } from "../audit/audit-types.js";
import { correlationAttributes, type RuntimeTelemetry } from "../telemetry/telemetry-types.js";
import {
  PermitApprovalConflictError,
  PermitApprovalError,
  type PermitAccessRequestInput,
  type PermitApprovalClient,
  type PermitApprovalCorrelation,
  type PermitApprovalStatus,
  type PermitExternalApproval,
} from "./permit-approval-types.js";

export interface PermitApprovalDecision {
  decision: () => Promise<PermitExternalApproval>;
  refresh: () => Promise<PermitExternalApproval>;
  expected: PermitApprovalStatus;
  correlation?: PermitApprovalCorrelation;
}

/**
 * External-state seam shared by the operation and Project workflows.
 *
 * It concentrates provider error normalization, the retry-after-ambiguous-
 * mutation rule, and audit/trace recording. Workflows therefore express
 * approval intent without duplicating the fail-closed Permit mechanics.
 */
export class PermitApprovalExternalState {
  constructor(
    private readonly client: PermitApprovalClient | null | undefined,
    private readonly audit?: AuditRecorder,
    private readonly telemetry?: RuntimeTelemetry,
  ) {}

  isAvailable(): boolean {
    return this.client !== null && this.client !== undefined;
  }

  async call<T>(operation: (client: PermitApprovalClient) => Promise<T>): Promise<T> {
    if (!this.client) throw new PermitApprovalError();
    try {
      return await operation(this.client);
    } catch (error) {
      if (error instanceof PermitApprovalConflictError || error instanceof PermitApprovalError) {
        throw error;
      }
      throw new PermitApprovalError();
    }
  }

  async operation(correlation: PermitApprovalCorrelation): Promise<PermitExternalApproval> {
    return this.call((client) => client.getOperationApproval(correlation.permitRequestId));
  }

  async access(
    correlation: PermitApprovalCorrelation,
    input: PermitAccessRequestInput,
  ): Promise<PermitExternalApproval> {
    return this.call((client) => client.getAccessRequest(correlation.permitRequestId, input));
  }

  async decide({ decision, refresh, expected, correlation }: PermitApprovalDecision): Promise<PermitExternalApproval> {
    const resolve = () => this.decideNow(decision, refresh, expected);
    if (!this.telemetry) return resolve();
    return this.telemetry.withSpan(
      "permit.approval.resolve",
      {
        ...correlationAttributes({
          principalKind: "human",
          principalId: humanPrincipal().id,
          ...(correlation === undefined ? {} : { agentId: correlation.agentId }),
          ...(correlation?.projectId === null || correlation === undefined
            ? {}
            : { projectId: correlation.projectId }),
          ...(correlation?.runId === null || correlation === undefined
            ? {}
            : { runId: correlation.runId }),
          ...(correlation === undefined ? {} : { permitRequestId: correlation.permitRequestId }),
        }),
        "permit.approval.expected_status": expected,
      },
      resolve,
    );
  }

  async recordTransition(
    correlation: PermitApprovalCorrelation,
    transition: string,
    status: PermitApprovalStatus,
    type: AuditEventType,
  ): Promise<void> {
    const record = () => this.audit?.record({
      type,
      status: transition === "denied" ? "failure" : "success",
      summary: (correlation.kind === "operation_approval" ? "Permit approval " : "Permit Project access ") +
        transition + ": " + correlation.toolId,
      principal: humanPrincipal(),
      agentId: correlation.agentId,
      ...(correlation.projectId === null ? {} : { projectId: correlation.projectId }),
      ...(correlation.runId === null ? {} : { runId: correlation.runId }),
      permitRequestId: correlation.permitRequestId,
      metadata: {
        transition,
        status,
        kind: correlation.kind,
      },
    });
    const operation = this.telemetry
      ? this.telemetry.withSpan(
          "permit.approval.transition",
          {
            ...correlationAttributes({
              principalKind: "human",
              principalId: humanPrincipal().id,
              agentId: correlation.agentId,
              ...(correlation.projectId === null ? {} : { projectId: correlation.projectId }),
              ...(correlation.runId === null ? {} : { runId: correlation.runId }),
              permitRequestId: correlation.permitRequestId,
            }),
            "permit.approval.kind": correlation.kind,
            "permit.approval.status": status,
            "permit.approval.transition": transition,
          },
          async () => {
            await record();
          },
        )
      : record();
    await Promise.resolve(operation).catch(() => undefined);
  }

  private async decideNow(
    decision: () => Promise<PermitExternalApproval>,
    refresh: () => Promise<PermitExternalApproval>,
    expected: PermitApprovalStatus,
  ): Promise<PermitExternalApproval> {
    try {
      const result = await decision();
      if (result.status === expected) return result;
      if (result.status === "unknown") throw new PermitApprovalError();
      throw new PermitApprovalConflictError();
    } catch (error) {
      if (!(error instanceof PermitApprovalConflictError) && !(error instanceof PermitApprovalError)) {
        error = new PermitApprovalError();
      }
      try {
        const current = await refresh();
        if (current.status === expected) return current;
      } catch {
        // Keep the stable error below when Permit cannot confirm the outcome.
      }
      throw error;
    }
  }
}
