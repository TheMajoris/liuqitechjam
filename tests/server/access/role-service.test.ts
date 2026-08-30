import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonStore } from "../../../apps/server/src/store.js";
import { RoleService } from "../../../apps/server/src/roles/role-service.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("RoleService", () => {
  it("migrates legacy membership and propagates a confirmed reusable preset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "role-service-"));
    directories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    await store.mutate((database) => {
      database.projects.push({
        id: "project-1", name: "Project", description: "", workspacePath: root,
        teamId: null, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      database.projectAgents.push({
        projectId: "project-1", agentId: "agent-1", codexThreadId: null,
        attachedAt: new Date().toISOString(), role: "editor",
      });
    });
    const roles = new RoleService(
      store,
      { listMetadata: () => [{ id: "web.search", title: "Search", description: "", risk: "network", requiredPermission: "tool.execute:web.search" }] },
      { has: (id) => id === "research" },
    );
    await roles.initialize();
    expect(store.snapshot().projectAgents[0]?.roleId).toBe("legacy-editor");

    const created = await roles.create({
      name: "Local researcher",
      skillIds: ["research"],
      toolIds: ["web.search"],
      permissionIds: ["project.read", "agent.invoke", "tool.execute:web.search"],
    });
    await roles.assign("project-1", "agent-1", created.id);
    expect(roles.assignedSkillIds("project-1", "agent-1")).toEqual(["research"]);
    await expect(roles.update(created.id, { name: "Researcher" })).rejects.toMatchObject({ code: "ROLE_IN_USE" });
    await expect(roles.update(created.id, { name: "Researcher", confirmPropagation: true })).resolves.toMatchObject({ name: "Researcher" });
  });
});
