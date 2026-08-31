import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthorizationService } from "../../../apps/server/src/access/authorization-service.js";
import { agentPrincipal } from "../../../apps/server/src/access/access-types.js";
import { LocalPocApprovalGateway } from "../../../apps/server/src/access/local-poc-approval-gateway.js";
import {
  PermitApprovalService,
  type PermitApprovalClient,
  type PermitAccessRequestInput,
  type PermitAccessRoleAssignment,
  type PermitExternalApproval,
  type PermitOperationApprovalInput,
} from "../../../apps/server/src/access/permit-approval-service.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import { ToolApprovalRequiredError } from "../../../apps/server/src/tools/tool-errors.js";
import { ToolRegistry } from "../../../apps/server/src/tools/tool-registry.js";
import { ToolService } from "../../../apps/server/src/tools/tool-service.js";
import type { ToolDefinition } from "../../../apps/server/src/tools/tool-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function now(): string {
  return new Date().toISOString();
}

class FakePermitApproval implements PermitApprovalClient {
  readonly operations = new Map<string, PermitExternalApproval>();
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
    void assignment;
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

  it("never lets the local POC approval seam bypass repository authorization", async () => {
    const { store } = await fixture();
    const calls = { count: 0 };
    const authorization: AuthorizationService = {
      decide: async () => ({
        result: "deny",
        reason: "Repository role denied",
        errorCode: "PERMISSION_DENIED",
      }),
      require: async () => undefined,
    };
    const service = new ToolService(
      new ToolRegistry([searchTool(calls)]),
      authorization,
      store,
      new LocalPocApprovalGateway(),
    );

    await expect(service.execute(context, "web.search", { query: "search" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      statusCode: 403,
    });
    expect(calls.count).toBe(0);
  });

});
