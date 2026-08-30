import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import {
  PermitApprovalConflictError,
  PermitApprovalService,
  type PermitApprovalClient,
  type PermitAccessRequestInput,
  type PermitAccessRoleAssignment,
  type PermitExternalApproval,
  type PermitOperationApprovalInput,
} from "./permit-approval-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function now(): string {
  return new Date().toISOString();
}

class FakePermitApproval implements PermitApprovalClient {
  readonly operations = new Map<string, PermitExternalApproval>();
  readonly accesses = new Map<string, PermitExternalApproval>();
  readonly unassigned: PermitAccessRoleAssignment[] = [];
  readonly operationUnassigned: PermitAccessRoleAssignment[] = [];
  operationCreates = 0;
  accessCreates = 0;
  operationUnassignGate: Promise<void> | undefined;
  operationUnassignStarted: (() => void) | undefined;
  operationDenyDoesNotConfirm = false;

  async createOperationApproval(_input: PermitOperationApprovalInput): Promise<PermitExternalApproval> {
    this.operationCreates += 1;
    const item = { id: "permit-operation-1", status: "pending" as const, createdAt: now(), updatedAt: now() };
    this.operations.set(item.id, item);
    return item;
  }
  async getOperationApproval(id: string): Promise<PermitExternalApproval> {
    const item = this.operations.get(id);
    if (!item) throw new Error("not found");
    return item;
  }
  async listOperationApprovals(): Promise<readonly PermitExternalApproval[]> {
    return [...this.operations.values()];
  }
  async approveOperationApproval(id: string): Promise<PermitExternalApproval> {
    const item = this.operations.get(id);
    if (!item) throw new Error("not found");
    const next = { ...item, status: "approved" as const, updatedAt: now() };
    this.operations.set(id, next);
    return next;
  }
  async denyOperationApproval(id: string): Promise<PermitExternalApproval> {
    const item = this.operations.get(id);
    if (!item) throw new Error("not found");
    if (this.operationDenyDoesNotConfirm) return item;
    const next = { ...item, status: "denied" as const, updatedAt: now() };
    this.operations.set(id, next);
    return next;
  }
  async createAccessRequest(_input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    this.accessCreates += 1;
    const item = { id: "permit-access-1", status: "pending" as const, createdAt: now(), updatedAt: now() };
    this.accesses.set(item.id, item);
    return item;
  }
  async getAccessRequest(id: string, _input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    const item = this.accesses.get(id);
    if (!item) throw new Error("not found");
    return item;
  }
  async listAccessRequests(): Promise<readonly PermitExternalApproval[]> {
    return [...this.accesses.values()];
  }
  async approveAccessRequest(id: string, _input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    const item = this.accesses.get(id);
    if (!item) throw new Error("not found");
    const next = { ...item, status: "approved" as const, updatedAt: now() };
    this.accesses.set(id, next);
    return next;
  }
  async denyAccessRequest(id: string, _input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    const item = this.accesses.get(id);
    if (!item) throw new Error("not found");
    const next = { ...item, status: "denied" as const, updatedAt: now() };
    this.accesses.set(id, next);
    return next;
  }
  async unassignOperationApproval(assignment: PermitAccessRoleAssignment): Promise<void> {
    this.operationUnassigned.push(assignment);
    this.operationUnassignStarted?.();
    if (this.operationUnassignGate) await this.operationUnassignGate;
  }
  async unassignProjectAccess(assignment: PermitAccessRoleAssignment): Promise<void> {
    this.unassigned.push(assignment);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "permit-approval-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const client = new FakePermitApproval();
  const service = new PermitApprovalService(store, client, { tenantKey: "demo" });
  return { store, client, service };
}

describe("PermitApprovalService", () => {
  it("reuses one external pending approval and stores correlation only", async () => {
    const { store, client, service } = await fixture();
    const input = { agentId: "agent-1", projectId: "project-1", runId: "run-1", toolId: "web.search" };
    const results = await Promise.all([
      service.requestOperationApproval(input),
      service.requestOperationApproval(input),
    ]);

    expect(client.operationCreates).toBe(1);
    expect(results[0]?.id).toBe("permit-operation-1");
    expect(store.snapshot().permitApprovalCorrelations).toEqual([
      expect.objectContaining({
        permitRequestId: "permit-operation-1",
        kind: "operation_approval",
        agentId: "agent-1",
        projectId: "project-1",
        runId: "run-1",
        toolId: "web.search",
        lastKnownStatus: "pending",
      }),
    ]);
    expect(JSON.stringify(store.snapshot().permitApprovalCorrelations)).not.toContain("usesRemaining");
  });

  it("delegates one-time approve/deny and reports external conflicts", async () => {
    const { service } = await fixture();
    const created = await service.requestOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      toolId: "web.search",
    });
    await expect(service.approve(created.id)).resolves.toMatchObject({ status: "approved", scope: "once" });
    await expect(service.deny(created.id)).rejects.toBeInstanceOf(PermitApprovalConflictError);
  });

  it("consumes Permit’s temporary approval role before one-time execution", async () => {
    const { client, store, service } = await fixture();
    const created = await service.requestOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "web.search",
    });
    await service.approve(created.id);

    await service.consumeOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "web.search",
    });

    expect(client.operationUnassigned).toEqual([
      {
        user: "agent:agent-1",
        role: "_Approved_",
        tenant: "demo",
        resourceInstance: "project:project-1",
      },
    ]);
    expect(store.snapshot().permitApprovalCorrelations[0]).toMatchObject({
      lastKnownStatus: "consumed",
    });
  });

  it("denies a concurrent retry while the first caller claims the approval", async () => {
    const { client, service } = await fixture();
    const created = await service.requestOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "web.search",
    });
    await service.approve(created.id);

    let release!: () => void;
    const unassignFinished = new Promise<void>((resolve) => { release = resolve; });
    let unassignStarted!: () => void;
    const unassignEntered = new Promise<void>((resolve) => { unassignStarted = resolve; });
    client.operationUnassignGate = unassignFinished;
    client.operationUnassignStarted = unassignStarted;

    const first = service.consumeOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "web.search",
    });
    await unassignEntered;
    await expect(service.consumeOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "web.search",
    })).resolves.toBe(false);

    release();
    await expect(first).resolves.toBe(true);
  });

  it("closes the original Operation Approval when escalating to project access", async () => {
    const { client, store, service } = await fixture();
    const operation = await service.requestOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "web.search",
    });

    const grant = await service.approve(operation.id, "project");

    expect(grant).toMatchObject({ kind: "access_request", status: "approved" });
    expect(client.operations.get(operation.id)?.status).toBe("denied");
    expect(store.snapshot().permitApprovalCorrelations).toEqual([
      expect.objectContaining({ permitRequestId: operation.id, lastKnownStatus: "denied" }),
      expect.objectContaining({ permitRequestId: grant.id, lastKnownStatus: "approved" }),
    ]);
  });

  it("revokes a newly approved project grant when the original cannot be closed", async () => {
    const { client, service } = await fixture();
    client.operationDenyDoesNotConfirm = true;
    const operation = await service.requestOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "web.search",
    });

    await expect(service.approve(operation.id, "project")).rejects.toBeInstanceOf(
      PermitApprovalConflictError,
    );
    expect(client.unassigned).toHaveLength(1);
  });

  it("shares one approved project Access Request across runs", async () => {
    const { client, service } = await fixture();
    const grants = await Promise.all([
      service.grantProjectAccess({
        agentId: "agent-1",
        projectId: "project-1",
        runId: "run-1",
        toolId: "web.search",
      }),
      service.grantProjectAccess({
        agentId: "agent-1",
        projectId: "project-1",
        runId: "run-2",
        toolId: "web.search",
      }),
    ]);

    expect(client.accessCreates).toBe(1);
    expect(grants[0]?.id).toBe(grants[1]?.id);
  });

  it("uses Access Request plus role unassignment for project grants", async () => {
    const { client, service } = await fixture();
    const grant = await service.grantProjectAccess({
      agentId: "agent-1",
      projectId: "project-1",
      toolId: "web.search",
    });
    expect(grant).toMatchObject({ id: "permit-access-1", kind: "access_request", scope: "project", status: "approved" });
    await expect(service.revokeProjectAccess(grant.id)).resolves.toMatchObject({ status: "revoked" });
    expect(client.unassigned).toEqual([
      expect.objectContaining({
        user: "agent:agent-1",
        tenant: "demo",
        resourceInstance: "project:project-1",
      }),
    ]);
    await expect(service.revokeProjectAccess(grant.id)).resolves.toMatchObject({ status: "revoked" });
    expect(client.unassigned).toHaveLength(1);
  });
});
