import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import type { Agent } from "../../types.js";
import { ProjectService } from "./project-service.js";
import { ProjectWorkspaceManager } from "./project-workspace.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const fakeAgent = (name: string): Agent => ({
  id: randomUUID(),
  name,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: "/workspaces/" + name,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const setup = async (): Promise<{
  service: ProjectService;
  store: JsonStore;
  agents: Agent[];
  root: string;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "project-service-"));
  dirs.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const agents = [fakeAgent("planner"), fakeAgent("builder"), fakeAgent("reviewer")];
  await store.mutate((db) => {
    db.agents.push(...agents);
  });
  const service = new ProjectService(
    store,
    new ProjectWorkspaceManager(path.join(root, "project-workspaces")),
  );
  await service.initialize();
  return { service, store, agents, root };
};

const roleInput = (agents: Agent[]) => ({
  plannerAgentId: agents[0]!.id,
  builderAgentId: agents[1]!.id,
  reviewerAgentId: agents[2]!.id,
});

describe("ProjectService", () => {
  it("creates a project with a contained workspace and three distinct roles", async () => {
    const { service, root, agents } = await setup();
    const project = await service.create({ name: "Demo", roles: roleInput(agents) });

    expect(project.status).toBe("active");
    expect(project.workspacePath).toBe(
      path.join(root, "project-workspaces", project.id),
    );
    await expect(stat(project.workspacePath)).resolves.toBeDefined();
    expect(service.list()).toHaveLength(1);
  });

  it("rejects role sets that are not three distinct existing Agents", async () => {
    const { service, agents } = await setup();
    await expect(
      service.create({
        name: "Bad",
        roles: {
          plannerAgentId: agents[0]!.id,
          builderAgentId: agents[0]!.id,
          reviewerAgentId: agents[2]!.id,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      service.create({
        name: "Bad",
        roles: {
          plannerAgentId: agents[0]!.id,
          builderAgentId: agents[1]!.id,
          reviewerAgentId: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("archives a project and moves its workspace out of the active root", async () => {
    const { service, agents } = await setup();
    const project = await service.create({ name: "Demo", roles: roleInput(agents) });
    const activePath = project.workspacePath;

    const { project: archived, archivedWorkspace } = await service.archive(project.id);
    expect(archived.status).toBe("archived");
    expect(archivedWorkspace).toContain(path.sep + ".archived" + path.sep);
    await expect(stat(activePath)).rejects.toThrow();
    await expect(stat(archivedWorkspace)).resolves.toBeDefined();
    await expect(service.archive(project.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("contains workspace path resolution against traversal", async () => {
    const { root } = await setup();
    const workspaces = new ProjectWorkspaceManager(path.join(root, "pw"));
    expect(() => workspaces.resolveWithin("p1", "../p2/secret")).toThrow(/escapes/);
    expect(() => workspaces.resolveWithin("p1", "/etc/passwd")).toThrow(/escapes/);
    expect(workspaces.resolveWithin("p1", "src/app.ts")).toBe(
      path.join(root, "pw", "p1", "src", "app.ts"),
    );
  });
});
