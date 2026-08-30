import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthorizationService } from "../access/authorization-service.js";
import { agentPrincipal } from "../access/access-types.js";
import {
  PermitApprovalService,
  type PermitApprovalClient,
  type PermitAccessRequestInput,
  type PermitAccessRoleAssignment,
  type PermitExternalApproval,
  type PermitOperationApprovalInput,
} from "../access/permit-approval-service.js";
import { JsonStore } from "../store.js";
import { ToolApprovalRequiredError } from "./tool-errors.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolService } from "./tool-service.js";
import type { ToolDefinition } from "./tool-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function now(): string {
  return new Date().toISOString();
}

class FakePermitApproval implements PermitApprovalClient {
  readonly operations = new Map<string, PermitExternalApproval>();
  readonly operationUnassigned: PermitAccessRoleAssignment[] = [];
  operationUnassignGate: Promise<void> | undefined;
  operationUnassignStarted: (() => void) | undefined;
  operationCreates = 0;

  async createOperationApproval(_input: PermitOperationApprovalInput): Promise<PermitExternalApproval> {
    this.operationCreates += 1;
    const item = {
      id: "permit-operation-1",
      status: "pending" as const,
      createdAt: now(),
      updatedAt: now(),
    };
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
    const item = await this.getOperationApproval(id);
    const next = { ...item, status: "approved" as const, updatedAt: now() };
    this.operations.set(id, next);
    return next;
  }

  async denyOperationApproval(id: string): Promise<PermitExternalApproval> {
    const item = await this.getOperationApproval(id);
    const next = { ...item, status: "denied" as const, updatedAt: now() };
    this.operations.set(id, next);
    return next;
  }

  async createAccessRequest(_input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    throw new Error("not used");
  }

  async getAccessRequest(id: string, _input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    throw new Error("not found: " + id);
  }

  async listAccessRequests(): Promise<readonly PermitExternalApproval[]> {
    return [];
  }

  async approveAccessRequest(id: string, _input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    throw new Error("not found: " + id);
  }

  async denyAccessRequest(id: string, _input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    throw new Error("not found: " + id);
  }

  async unassignOperationApproval(assignment: PermitAccessRoleAssignment): Promise<void> {
    this.operationUnassigned.push(assignment);
    this.operationUnassignStarted?.();
    if (this.operationUnassignGate) await this.operationUnassignGate;
  }

  async unassignProjectAccess(_assignment: PermitAccessRoleAssignment): Promise<void> {}
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tool-service-permit-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const permit = new FakePermitApproval();
  return { store, permit, approvals: new PermitApprovalService(store, permit, { tenantKey: "demo" }) };
}

function searchTool(calls: { count: number }): ToolDefinition<{ query: string }, { results: [] }> {
  return {
    id: "web.search",
    title: "Search",
    description: "Test search",
    risk: "network",
    requiredPermission: "tool.execute:web.search",
    inputSchema: z.object({ query: z.string().min(1) }),
    outputSchema: z.object({ results: z.tuple([]) }),
    async execute() {
      calls.count += 1;
      return { results: [] };
    },
  };
}

function previewTool(calls: { count: number }): ToolDefinition<{}, { ok: boolean }> {
  return {
    id: "project.preview.inspect",
    title: "Inspect preview",
    description: "Test preview inspection",
    risk: "read",
    requiredPermission: "tool.execute:project.preview.inspect",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute() {
      calls.count += 1;
      return { ok: true };
    },
  };
}

const context = {
  principal: agentPrincipal("agent-1"),
  agentId: "agent-1",
  projectId: "project-1",
  runId: "run-1",
};

describe("ToolService Permit approval boundary", () => {
  it("reuses one external operation approval and never writes legacy authority", async () => {
    const { store, permit, approvals } = await fixture();
    const calls = { count: 0 };
    const authorization: AuthorizationService = {
      decide: async ({ permission }) => permission === "project.read"
        ? { result: "allow", reason: "Project read allowed" }
        : { result: "deny", reason: "Permit approval required", errorCode: "PERMISSION_DENIED" },
      require: async () => undefined,
    };
    const service = new ToolService(
      new ToolRegistry([searchTool(calls)]),
      authorization,
      store,
      approvals,
    );

    const outcomes = await Promise.allSettled([
      service.execute(context, "web.search", { query: "one" }),
      service.execute(context, "web.search", { query: "two" }),
    ]);

    const rejected = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((error) => error instanceof ToolApprovalRequiredError)).toBe(true);
    expect(new Set(rejected.map((error) => error.permitRequestId)).size).toBe(1);
    expect(permit.operationCreates).toBe(1);
    expect(store.snapshot().permitApprovalCorrelations).toHaveLength(1);
    expect(store.snapshot().approvalRequests).toHaveLength(0);
    expect(store.snapshot().capabilityGrants).toHaveLength(0);
    expect(calls.count).toBe(0);
  });

  it("requires a fresh Permit allow on explicit retry even when a legacy grant exists", async () => {
    const { store, permit, approvals } = await fixture();
    await store.mutate((database) => {
      database.capabilityGrants.push({
        id: "legacy-grant",
        agentId: "agent-1",
        projectId: "project-1",
        toolId: "web.search",
        scope: "project",
        usesRemaining: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: now(),
      });
    });
    let allowed = false;
    const authorization: AuthorizationService = {
      decide: async ({ permission }) => permission === "project.read"
        ? { result: "allow", reason: "Project read allowed" }
        : allowed
          ? { result: "allow", reason: "Permit operation approved" }
          : { result: "deny", reason: "Permit approval required", errorCode: "PERMISSION_DENIED" },
      require: async () => undefined,
    };
    const calls = { count: 0 };
    const service = new ToolService(new ToolRegistry([searchTool(calls)]), authorization, store, approvals);

    const pending = await service.execute(context, "web.search", { query: "search" }).catch((error) => error);
    expect(pending).toBeInstanceOf(ToolApprovalRequiredError);
    await approvals.approve((pending as ToolApprovalRequiredError).permitRequestId);
    allowed = true;
    await expect(service.execute(context, "web.search", { query: "search" })).resolves.toEqual({ results: [] });
    expect(calls.count).toBe(1);
    expect(store.snapshot().capabilityGrants).toHaveLength(1);
  });

  it("fails closed for an Agent when the approval gateway is absent", async () => {
    const { store } = await fixture();
    const calls = { count: 0 };
    const authorization: AuthorizationService = {
      decide: async () => ({ result: "allow", reason: "Permit allowed" }),
      require: async () => undefined,
    };
    const service = new ToolService(
      new ToolRegistry([searchTool(calls)]),
      authorization,
      store,
    );

    await expect(service.execute(context, "web.search", { query: "search" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      statusCode: 503,
    });
    expect(calls.count).toBe(0);
  });

  it("lets only the claimant execute during a concurrent one-time retry", async () => {
    const { store, permit, approvals } = await fixture();
    const created = await approvals.requestOperationApproval({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "web.search",
    });
    await approvals.approve(created.id);

    let release!: () => void;
    const unassignFinished = new Promise<void>((resolve) => { release = resolve; });
    let unassignStarted!: () => void;
    const unassignEntered = new Promise<void>((resolve) => { unassignStarted = resolve; });
    permit.operationUnassignGate = unassignFinished;
    permit.operationUnassignStarted = unassignStarted;
    const calls = { count: 0 };
    const authorization: AuthorizationService = {
      decide: async () => ({ result: "allow", reason: "Permit operation approved" }),
      require: async () => undefined,
    };
    const service = new ToolService(
      new ToolRegistry([searchTool(calls)]),
      authorization,
      store,
      approvals,
    );

    const first = service.execute(context, "web.search", { query: "first" });
    await unassignEntered;
    const second = service.execute(context, "web.search", { query: "second" });
    await expect(second).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      statusCode: 403,
    });

    release();
    await expect(first).resolves.toEqual({ results: [] });
    expect(calls.count).toBe(1);
    expect(permit.operationUnassigned).toHaveLength(1);
  });

  it("keeps non-approvable tools denied and does not project legacy grants", async () => {
    const { store, approvals } = await fixture();
    await store.mutate((database) => {
      database.capabilityGrants.push({
        id: "legacy-preview-grant",
        agentId: "agent-1",
        projectId: "project-1",
        toolId: "project.preview.inspect",
        scope: "project",
        usesRemaining: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: now(),
      });
    });
    const calls = { count: 0 };
    const authorization: AuthorizationService = {
      decide: async () => ({
        result: "deny",
        reason: "Project role does not permit preview inspection",
        errorCode: "PERMISSION_DENIED",
      }),
      require: async () => undefined,
    };
    const service = new ToolService(new ToolRegistry([previewTool(calls)]), authorization, store, approvals);

    await expect(service.execute(context, "project.preview.inspect", {})).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(service.listCapabilities("agent-1", "project-1")).resolves.toMatchObject({
      tools: [{ availability: "denied", grant: null }],
    });
    expect(calls.count).toBe(0);
  });
});
