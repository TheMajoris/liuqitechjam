import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthorizationService } from "../../../apps/server/src/access/authorization-service.js";
import { DefaultAuthorizationService } from "../../../apps/server/src/access/default-authorization-service.js";
import { HttpError } from "../../../apps/server/src/errors.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type { Agent } from "../../../apps/server/src/types.js";
import { ProjectError } from "../../../apps/server/src/projects/project-errors.js";
import { ProjectService, type ProjectEventSink } from "../../../apps/server/src/projects/project-service.js";
import { ProjectWorkspaceManager } from "../../../apps/server/src/projects/project-workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function agentFor(id: string, name: string): Agent {
  const timestamp = new Date().toISOString();
  return {
    id,
    name,
    description: "",
    instructions: "Write careful code.",
    status: "ready",
    workspacePath: "/agents/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const directory = {
  getAgent(id: string): Agent {
    if (id === "missing") throw new HttpError(404, "Agent not found");
    return agentFor(id, id === "fe" ? "fe" : "fe builder2");
  },
};

async function makeService(
  onEvent?: ProjectEventSink,
  authorization: AuthorizationService = new DefaultAuthorizationService(),
) {
  const root = await mkdtemp(path.join(tmpdir(), "project-service-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  const workspaces = new ProjectWorkspaceManager(path.join(root, "projects"));
  const service = new ProjectService(
    store,
    workspaces,
    directory,
    authorization,
    onEvent,
  );
  await service.initialize();
  return { service, store, workspaces, root };
}

describe("Project lifecycle", () => {
  it("creates a Project with a backend-derived shared workspace", async () => {
    const { service, workspaces } = await makeService();
    const project = await service.create({ name: "Todo App", description: "Shared build" });

    expect(project).toMatchObject({
      name: "Todo App",
      description: "Shared build",
      teamId: null,
      agentIds: [],
      status: "active",
    });
    const workspacePath = workspaces.workspacePath(project.id);
    expect((await stat(workspacePath)).isDirectory()).toBe(true);
    expect(await readFile(path.join(workspacePath, "README.md"), "utf8")).toContain("Todo App");
  });

  it("never exposes the host workspace path through the HTTP projection", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });

    expect(JSON.stringify(project)).not.toMatch(/workspacePath|\/projects\//);
  });

  it("rejects a blank name", async () => {
    const { service } = await makeService();
    await expect(service.create({ name: "   " })).rejects.toThrow(ProjectError);
  });

  it("archives a Project without deleting the shared workspace", async () => {
    const { service, workspaces } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");

    const { archivedWorkspace } = await service.archive(project.id);

    expect(archivedWorkspace).not.toBeNull();
    expect((await stat(archivedWorkspace!)).isDirectory()).toBe(true);
    await expect(stat(workspaces.workspacePath(project.id))).rejects.toThrow();
    const archived = await service.get(project.id);
    expect(archived.status).toBe("archived");
    expect(archived.agentIds).toEqual([]);
  });

  it("stops the Project Preview before moving the workspace", async () => {
    const { service, workspaces } = await makeService();
    const project = await service.create({ name: "Todo App" });
    let cleanupSawWorkspace = false;
    service.setProjectPreviewLifecycle({
      async stopForProject(projectId) {
        await expect(stat(workspaces.workspacePath(projectId))).resolves.toBeDefined();
        cleanupSawWorkspace = true;
      },
    });

    await service.archive(project.id);

    expect(cleanupSawWorkspace).toBe(true);
  });

  it("rejects archiving while a Project write lease is active", async () => {
    const { service, workspaces } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");
    await service.acquireWriteLease(project.id, "fe", "run-1");

    await expect(service.archive(project.id)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
      statusCode: 409,
    });
    expect(service.writeLeaseHolder(project.id)).toEqual({
      agentId: "fe",
      runId: "run-1",
    });
    await expect(stat(workspaces.workspacePath(project.id))).resolves.toBeDefined();
  });

  it("archives a database Project when its shared workspace is already missing", async () => {
    const { service, store, workspaces } = await makeService();
    const project = await service.create({ name: "Missing checkout" });

    await rm(workspaces.workspacePath(project.id), { recursive: true, force: true });

    const result = await service.archive(project.id);

    expect(result.archivedWorkspace).toBeNull();
    expect(store.snapshot().projects.find((item) => item.id === project.id)).toMatchObject({
      status: "archived",
    });
  });
});

describe("Project attachment", () => {
  it("attaches Agents and a Team", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });

    await service.attachAgent(project.id, "fe");
    await service.attachAgent(project.id, "fe-builder2");
    const attached = await service.attachTeam(project.id, "team-1");

    expect(attached.agentIds).toEqual(["fe", "fe-builder2"]);
    expect(attached.teamId).toBe("team-1");
  });

  it("rejects attaching an Agent that does not exist", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });

    await expect(service.attachAgent(project.id, "missing")).rejects.toThrow(HttpError);
  });

  it("rejects a duplicate Agent attachment", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");

    await expect(service.attachAgent(project.id, "fe")).rejects.toMatchObject({
      code: "PROJECT_AGENT_ALREADY_ATTACHED",
    });
  });

  it("rejects a second Team on the same Project", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachTeam(project.id, "team-1");

    await expect(service.attachTeam(project.id, "team-2")).rejects.toMatchObject({
      code: "PROJECT_TEAM_ALREADY_ATTACHED",
    });
    await expect(service.attachTeam(project.id, "team-1")).resolves.toMatchObject({
      teamId: "team-1",
    });
  });

  it("detaching an Agent leaves the Project and its files intact", async () => {
    const { service, workspaces } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");

    const after = await service.detachAgent(project.id, "fe");

    expect(after.agentIds).toEqual([]);
    expect(after.status).toBe("active");
    expect((await stat(workspaces.workspacePath(project.id))).isDirectory()).toBe(true);
  });
});

describe("Project run scoping", () => {
  it("resolves the shared workspace and a per-pair Codex thread", async () => {
    const { service, workspaces } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");
    await service.attachAgent(project.id, "fe-builder2");

    const scope = service.projectRunScope(project.id, "fe");
    expect(scope.workspacePath).toBe(workspaces.workspacePath(project.id));
    expect(scope.codexThreadId).toBeNull();

    await service.recordProjectThread(project.id, "fe", "thread-fe");

    expect(service.projectRunScope(project.id, "fe").codexThreadId).toBe("thread-fe");
    // A second Agent on the same Project keeps its own session continuity.
    expect(service.projectRunScope(project.id, "fe-builder2").codexThreadId).toBeNull();
  });

  it("refuses to scope a run for an Agent that is not attached", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });

    expect(() => service.projectRunScope(project.id, "fe")).toThrow(
      expect.objectContaining({ code: "PROJECT_AGENT_NOT_ATTACHED" }),
    );
  });

  it("writes the acting Agent's identity into the shared AGENTS.md", async () => {
    const { service, workspaces } = await makeService();
    const view = await service.create({ name: "Todo App" });
    await service.attachAgent(view.id, "fe");
    const { project } = service.projectRunScope(view.id, "fe");

    await service.prepareTurn(project, agentFor("fe", "fe"));
    const first = await readFile(
      path.join(workspaces.workspacePath(view.id), "AGENTS.md"),
      "utf8",
    );
    expect(first).toContain("You are the coding Agent named fe.");
    expect(first).toContain("Shared Project workspace");
    expect(first).toContain("Other Agents on this Team edit these same files");

    await service.prepareTurn(project, agentFor("fe-builder2", "fe builder2"));
    const second = await readFile(
      path.join(workspaces.workspacePath(view.id), "AGENTS.md"),
      "utf8",
    );
    expect(second).toContain("You are the coding Agent named fe builder2.");
    expect(second).not.toContain("named fe.");
  });
});

describe("Project write lease", () => {
  it("admits one writer and blocks the second until release", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");
    await service.attachAgent(project.id, "fe-builder2");

    await service.acquireWriteLease(project.id, "fe", "run-1");
    expect(service.writeLeaseHolder(project.id)).toEqual({ agentId: "fe", runId: "run-1" });

    await expect(
      service.acquireWriteLease(project.id, "fe-builder2", "run-2", { waitMs: 0 }),
    ).rejects.toMatchObject({ code: "PROJECT_BUSY" });
  });

  it("lets a blocked writer proceed once the lease is released", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");
    await service.attachAgent(project.id, "fe-builder2");
    await service.acquireWriteLease(project.id, "fe", "run-1");

    const queued = service.acquireWriteLease(project.id, "fe-builder2", "run-2", {
      waitMs: 2_000,
    });
    await service.releaseWriteLease(project.id, "run-1");
    await expect(queued).resolves.toBeUndefined();

    expect(service.writeLeaseHolder(project.id)).toEqual({
      agentId: "fe-builder2",
      runId: "run-2",
    });
  });

  it("release is idempotent and only clears the matching run", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");
    await service.acquireWriteLease(project.id, "fe", "run-1");

    await service.releaseWriteLease(project.id, "other-run");
    expect(service.writeLeaseHolder(project.id)).not.toBeNull();

    await service.releaseWriteLease(project.id, "run-1");
    await service.releaseWriteLease(project.id, "run-1");
    expect(service.writeLeaseHolder(project.id)).toBeNull();
  });

  it("reconciles leases orphaned by a server restart", async () => {
    const { service, store, workspaces, root } = await makeService();
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");
    await service.acquireWriteLease(project.id, "fe", "run-1");

    const events: string[] = [];
    const restarted = new ProjectService(
      store,
      workspaces,
      directory,
      new DefaultAuthorizationService(),
      (event) => events.push(event.type + ":" + event.status),
    );
    await restarted.initialize();

    expect(restarted.writeLeaseHolder(project.id)).toBeNull();
    expect(events).toContain("project_write_lease_released:reconciled");
    expect(root).toContain("project-service-");
  });

  it("refuses a write lease for an Agent that is not attached", async () => {
    const { service } = await makeService();
    const project = await service.create({ name: "Todo App" });

    await expect(service.acquireWriteLease(project.id, "fe", "run-1")).rejects.toMatchObject({
      code: "PROJECT_AGENT_NOT_ATTACHED",
    });
    expect(service.writeLeaseHolder(project.id)).toBeNull();
  });

  it("reauthorizes a waiting writer after its role is revoked", async () => {
    let revoked = false;
    let secondLeaseChecks = 0;
    let secondLeaseCheck!: () => void;
    const secondLeaseChecked = new Promise<void>((resolve) => {
      secondLeaseCheck = resolve;
    });
    const authorization: AuthorizationService = {
      async decide() {
        return { result: "allow", reason: "test" };
      },
      async require(input) {
        if (revoked && input.principal?.kind === "agent") {
          throw new Error("Permission revoked");
        }
        if (
          input.principal?.kind === "agent" &&
          input.principal.id === "fe-builder2" &&
          input.permission === "project.write"
        ) {
          secondLeaseChecks += 1;
          if (secondLeaseChecks === 2) secondLeaseCheck();
        }
      },
    };
    const { service } = await makeService(undefined, authorization);
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");
    await service.attachAgent(project.id, "fe-builder2");
    await service.acquireWriteLease(project.id, "fe", "run-1");

    const waiting = service.acquireWriteLease(project.id, "fe-builder2", "run-2", {
      waitMs: 2_000,
    });
    await secondLeaseChecked;
    revoked = true;
    await service.releaseWriteLease(project.id, "run-1");

    await expect(waiting).rejects.toThrow("Permission revoked");
    expect(service.writeLeaseHolder(project.id)).toBeNull();
  });

  it("emits collaboration evidence for lease handover", async () => {
    const events: string[] = [];
    const { service } = await makeService((event) =>
      events.push(event.type + ":" + (event.agentId ?? "-")),
    );
    const project = await service.create({ name: "Todo App" });
    await service.attachAgent(project.id, "fe");
    await service.acquireWriteLease(project.id, "fe", "run-1");
    await service.releaseWriteLease(project.id, "run-1");

    expect(events).toEqual([
      "project_created:-",
      "project_agent_attached:fe",
      "project_write_lease_acquired:fe",
      "project_write_lease_released:fe",
    ]);
  });
});
