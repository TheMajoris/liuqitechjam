import type { JsonStore } from "../store.js";
import type {
  PermitApprovalCorrelation,
  PermitApprovalListFilter,
  PermitApprovalRecord,
  PermitApprovalStatus,
  PermitExternalApproval,
} from "./permit-approval-types.js";
import { PermitApprovalError } from "./permit-approval-types.js";
import {
  correlationKey,
  correlationToRecord,
  projectedStatus,
  safeId,
} from "./permit-approval-helpers.js";

/**
 * Local projection of Permit approval state.
 *
 * This module deliberately knows nothing about authorization. It serializes
 * safe correlation facts and keeps terminal UX state (`consumed`/`revoked`)
 * without ever making that state a reason to allow a tool call.
 */
export class PermitApprovalProjection {
  constructor(private readonly store: JsonStore) {}

  list(filter: PermitApprovalListFilter = {}): PermitApprovalCorrelation[] {
    return this.store.snapshot().permitApprovalCorrelations.filter((item) =>
      (filter.agentId === undefined || item.agentId === filter.agentId) &&
      (filter.projectId === undefined || item.projectId === filter.projectId) &&
      (filter.kind === undefined || item.kind === filter.kind),
    );
  }

  find(id: string): PermitApprovalCorrelation {
    const correlation = this.store.snapshot().permitApprovalCorrelations.find(
      (item) => item.permitRequestId === safeId(id),
    );
    if (!correlation) throw new PermitApprovalError("Permit approval not found", 404);
    return correlation;
  }

  findLatest(input: {
    kind: PermitApprovalCorrelation["kind"];
    agentId: string;
    projectId: string | null;
    runId: string | null;
    toolId: string;
  }, statuses?: readonly PermitApprovalStatus[]): PermitApprovalCorrelation | undefined {
    return this.store.snapshot().permitApprovalCorrelations
      .filter((item) =>
        correlationKey(item) === correlationKey(input) &&
        (statuses === undefined || statuses.includes(item.lastKnownStatus)),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async add(
    correlation: PermitApprovalCorrelation,
    external: PermitExternalApproval,
  ): Promise<PermitApprovalCorrelation> {
    const now = new Date().toISOString();
    const projection: PermitApprovalCorrelation = {
      ...correlation,
      permitRequestId: external.id,
      lastKnownStatus: external.status,
      createdAt: external.createdAt || now,
      updatedAt: external.updatedAt || now,
    };
    await this.store.mutate((database) => {
      const index = database.permitApprovalCorrelations.findIndex(
        (item) => item.permitRequestId === projection.permitRequestId,
      );
      if (index === -1) database.permitApprovalCorrelations.push(projection);
      else database.permitApprovalCorrelations[index] = projection;
    });
    return projection;
  }

  /** Refresh a projection from Permit and return the refreshed local copy. */
  async sync(
    correlation: PermitApprovalCorrelation,
    external: PermitExternalApproval,
  ): Promise<{ correlation: PermitApprovalCorrelation; status: PermitApprovalStatus }> {
    const now = new Date().toISOString();
    let refreshed = correlation;
    let status = projectedStatus(correlation, external.status);
    await this.store.mutate((database) => {
      const index = database.permitApprovalCorrelations.findIndex(
        (item) => item.permitRequestId === correlation.permitRequestId,
      );
      if (index === -1) return;
      const current = database.permitApprovalCorrelations[index];
      if (!current) return;
      status = projectedStatus(current, external.status);
      refreshed = {
        ...current,
        lastKnownStatus: status,
        updatedAt: external.updatedAt || now,
      };
      database.permitApprovalCorrelations[index] = refreshed;
    });
    return { correlation: refreshed, status };
  }

  async mark(
    correlation: PermitApprovalCorrelation,
    status: PermitApprovalStatus,
  ): Promise<PermitApprovalCorrelation> {
    const updatedAt = new Date().toISOString();
    let updated: PermitApprovalCorrelation | undefined;
    await this.store.mutate((database) => {
      const index = database.permitApprovalCorrelations.findIndex(
        (item) => item.permitRequestId === correlation.permitRequestId,
      );
      if (index === -1) return;
      const current = database.permitApprovalCorrelations[index];
      if (!current) return;
      updated = { ...current, lastKnownStatus: status, updatedAt };
      database.permitApprovalCorrelations[index] = updated;
    });
    if (!updated) throw new PermitApprovalError("Permit approval not found", 404);
    return updated;
  }

  toRecord(
    correlation: PermitApprovalCorrelation,
    status = correlation.lastKnownStatus,
  ): PermitApprovalRecord {
    return correlationToRecord(correlation, status);
  }
}
