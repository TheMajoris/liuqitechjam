import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PermitDirectoryClient,
  PermitDirectoryResourceInstance,
  PermitDirectoryRoleAssignment,
  PermitDirectoryUser,
} from "../../../apps/server/src/access/permit-directory-reconciler.js";
import {
  MAX_PERMIT_ROLE_ASSIGNMENT_PAGES,
  PERMIT_ROLE_ASSIGNMENT_PAGE_SIZE,
  PermitDirectoryReconciler,
  PermitSdkDirectoryClient,
  PermitDirectorySyncError,
} from "../../../apps/server/src/access/permit-directory-reconciler.js";
import { PermitSynchronizationGate } from "../../../apps/server/src/access/permit-synchronization-gate.js";
import { JsonStore } from "../../../apps/server/src/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakePermitDirectory implements PermitDirectoryClient {
  readonly users = new Set<string>();
  readonly resources = new Map<string, PermitDirectoryResourceInstance>();
  readonly assignments = new Map<string, PermitDirectoryRoleAssignment[]>();
  failWith: string | undefined;
  failAfterCalls: number | undefined;
  private calls = 0;

  async syncUser(user: PermitDirectoryUser): Promise<void> {
    this.failIfRequested();
    this.users.add(user.key);
  }

  async ensureResourceInstance(resource: PermitDirectoryResourceInstance): Promise<void> {
    this.failIfRequested();
    this.resources.set(resource.key, resource);
  }

  async listRoleAssignments(
    resourceInstanceKey: string,
    _tenantKey: string,
  ): Promise<readonly PermitDirectoryRoleAssignment[]> {
    this.failIfRequested();
    return [...(this.assignments.get(resourceInstanceKey) ?? [])];
  }

  async assignRole(assignment: PermitDirectoryRoleAssignment): Promise<void> {
    this.failIfRequested();
    const current = this.assignments.get(assignment.resource_instance) ?? [];
    if (!current.some((item) => sameAssignment(item, assignment))) current.push(assignment);
    this.assignments.set(assignment.resource_instance, current);
  }

  async unassignRole(assignment: PermitDirectoryRoleAssignment): Promise<void> {
    this.failIfRequested();
    const current = this.assignments.get(assignment.resource_instance) ?? [];
    this.assignments.set(
      assignment.resource_instance,
      current.filter((item) => !sameAssignment(item, assignment)),
    );
  }

  private failIfRequested(): void {
    this.calls += 1;
    if (this.failWith !== undefined) throw new Error(this.failWith);
    if (this.failAfterCalls !== undefined && this.calls > this.failAfterCalls) {
      throw new Error("partial response contains permit-secret");
    }
  }
}

function sameAssignment(
  left: PermitDirectoryRoleAssignment,
  right: PermitDirectoryRoleAssignment,
): boolean {
  return (
    left.user === right.user &&
    left.role === right.role &&
    left.tenant === right.tenant &&
    left.resource_instance === right.resource_instance
  );
}

async function makeStore() {
  const root = await mkdtemp(path.join(tmpdir(), "permit-directory-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    const timestamp = "2026-08-30T00:00:00.000Z";
    database.agents.push(
      {
        id: "agent-1",
        name: "Builder",
        description: "",
        instructions: "",
        status: "ready",
        workspacePath: "/agents/agent-1",
        codexThreadId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "agent-2",
        name: "Reviewer",
        description: "",
        instructions: "",
        status: "ready",
        workspacePath: "/agents/agent-2",
        codexThreadId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    );
    database.projects.push({
      id: "project-1",
      name: "Demo",
      description: "",
      workspacePath: "/projects/project-1",
      teamId: null,
      ownerPrincipalId: "demo-owner",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    database.projectAgents.push(
      {
        projectId: "project-1",
        agentId: "agent-1",
        codexThreadId: null,
        attachedAt: timestamp,
        role: "editor",
        toolGrants: [],
        updatedAt: timestamp,
      },
      {
        projectId: "project-1",
        agentId: "agent-2",
        codexThreadId: null,
        attachedAt: timestamp,
        role: "viewer",
        toolGrants: [],
        updatedAt: timestamp,
      },
    );
  });
  return store;
}

describe("PermitDirectoryReconciler", () => {
  it("converges users, project instances, and memberships idempotently", async () => {
    const store = await makeStore();
    const client = new FakePermitDirectory();
    const gate = new PermitSynchronizationGate();
    const reconciler = new PermitDirectoryReconciler(store, client, {
      tenantKey: "demo",
      synchronizationGate: gate,
    });

    expect(gate.getState()).toBe("unready");

    await expect(reconciler.reconcile()).resolves.toEqual({
      usersSynchronized: 3,
      resourcesSynchronized: 1,
      rolesAssigned: 3,
      rolesUnassigned: 0,
    });
    expect(gate.getState()).toBe("ready");
    await expect(reconciler.reconcile()).resolves.toEqual({
      usersSynchronized: 3,
      resourcesSynchronized: 1,
      rolesAssigned: 0,
      rolesUnassigned: 0,
    });

    const assignments = client.assignments.get("project:project-1") ?? [];
    expect(assignments.map((item) => [item.user, item.role])).toEqual([
      ["human:demo-owner", "owner"],
      ["agent:agent-1", "editor"],
      ["agent:agent-2", "viewer"],
    ]);
  });

  it("removes stale memberships and changes roles from repository facts", async () => {
    const store = await makeStore();
    const client = new FakePermitDirectory();
    const reconciler = new PermitDirectoryReconciler(store, client, "demo");
    await reconciler.reconcile();

    await store.mutate((database) => {
      database.projectAgents = database.projectAgents.filter(
        (attachment) => attachment.agentId !== "agent-2",
      );
      database.projectAgents[0]!.role = "viewer";
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({
      rolesAssigned: 1,
      rolesUnassigned: 2,
    });
    expect(client.assignments.get("project:project-1")).toEqual([
      {
        user: "human:demo-owner",
        role: "owner",
        tenant: "demo",
        resource_instance: "project:project-1",
      },
      {
        user: "agent:agent-1",
        role: "viewer",
        tenant: "demo",
        resource_instance: "project:project-1",
      },
    ]);
  });

  it("turns privileged sync failures into a stable error without provider details", async () => {
    const store = await makeStore();
    const client = new FakePermitDirectory();
    client.failWith = "response body contains permit-secret";
    const gate = new PermitSynchronizationGate();
    const reconciler = new PermitDirectoryReconciler(store, client, {
      tenantKey: "demo",
      synchronizationGate: gate,
    });

    const error = await reconciler.reconcile().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PermitDirectorySyncError);
    expect(error).toMatchObject({
      name: "PermitDirectorySyncError",
      code: "PERMIT_DIRECTORY_SYNC_FAILED",
      message: "Permit directory synchronization failed",
    });
    expect(String(error)).not.toContain("permit-secret");
    expect(gate.getState()).toBe("failed");
  });

  it("closes the gate after a partial external sync", async () => {
    const store = await makeStore();
    const client = new FakePermitDirectory();
    client.failAfterCalls = 4;
    const gate = new PermitSynchronizationGate();
    const reconciler = new PermitDirectoryReconciler(store, client, {
      tenantKey: "demo",
      synchronizationGate: gate,
    });

    await expect(reconciler.reconcile()).rejects.toBeInstanceOf(PermitDirectorySyncError);
    expect(gate.getState()).toBe("failed");
  });
});

describe("PermitSdkDirectoryClient role assignment pagination", () => {
  function sdkDouble(
    list: (params: { page?: number; perPage?: number }) => Promise<unknown>,
  ) {
    return {
      api: {
        ensureContext: vi.fn(async () => undefined),
        roleAssignments: { list },
      },
      config: {
        apiContext: {
          project: "launchpad",
          environment: "production",
        },
      },
    } as never;
  }

  it("fetches every page with bounded page size", async () => {
    const firstPage = Array.from({ length: PERMIT_ROLE_ASSIGNMENT_PAGE_SIZE }, (_, index) => ({
      user: "agent:" + index,
      role: "viewer",
      tenant: "demo",
      resource_instance: "project:project-1",
    }));
    const list = vi.fn(async ({ page }: { page?: number }) =>
      page === 1
        ? firstPage
        : [{
            user: "agent:100",
            role: "editor",
            tenant: "demo",
            resource_instance: "project:project-1",
          }],
    );
    const client = new PermitSdkDirectoryClient(
      sdkDouble(list),
      { permitProjectId: "launchpad", permitEnvironmentId: "production" },
    );

    await expect(client.listRoleAssignments("project:project-1", "demo")).resolves.toHaveLength(101);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1, perPage: 100 }));
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2, perPage: 100 }));
  });

  it("fails closed for malformed or unbounded pagination", async () => {
    const malformed = vi.fn(async () => ({ data: [] }));
    const malformedClient = new PermitSdkDirectoryClient(
      sdkDouble(malformed),
      { permitProjectId: "launchpad", permitEnvironmentId: "production" },
    );
    await expect(
      malformedClient.listRoleAssignments("project:project-1", "demo"),
    ).rejects.toBeInstanceOf(PermitDirectorySyncError);

    const fullPage = Array.from({ length: PERMIT_ROLE_ASSIGNMENT_PAGE_SIZE }, (_, index) => ({
      user: "agent:" + index,
      role: "viewer",
      tenant: "demo",
      resource_instance: "project:project-1",
    }));
    const unbounded = vi.fn(async () => fullPage);
    const unboundedClient = new PermitSdkDirectoryClient(
      sdkDouble(unbounded),
      { permitProjectId: "launchpad", permitEnvironmentId: "production" },
    );
    await expect(
      unboundedClient.listRoleAssignments("project:project-1", "demo"),
    ).rejects.toBeInstanceOf(PermitDirectorySyncError);
    expect(unbounded).toHaveBeenCalledTimes(MAX_PERMIT_ROLE_ASSIGNMENT_PAGES);
  });
});
