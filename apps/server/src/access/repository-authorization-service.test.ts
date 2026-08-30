import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_HUMAN_PRINCIPAL, AuthorizationError } from "./authorization-service.js";
import { RepositoryAuthorizationService } from "./repository-authorization-service.js";
import { JsonStore } from "../store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore() {
  const root = await mkdtemp(path.join(tmpdir(), "authorization-service-"));
  roots.push(root);
  const file = path.join(root, "db.json");
  await writeFile(file, JSON.stringify({
    version: 1,
    agents: [],
    messages: [],
    runs: [],
    projects: [{
      id: "project-1",
      name: "Demo",
      description: "",
      workspacePath: "/tmp/project-1",
      teamId: null,
      ownerPrincipalId: "demo-owner",
      status: "active",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    }],
    projectAgents: [{
      projectId: "project-1",
      agentId: "agent-1",
      codexThreadId: null,
      attachedAt: "2026-08-30T00:00:00.000Z",
      role: "editor",
      toolGrants: [],
      updatedAt: "2026-08-30T00:00:00.000Z",
    }],
    projectLeases: [],
  }), "utf8");
  const store = new JsonStore(file);
  await store.initialize();
  return store;
}

describe("RepositoryAuthorizationService", () => {
  it("applies fixed Project roles and emits stable denial errors", async () => {
    const store = await makeStore();
    const service = new RepositoryAuthorizationService(store);
    const project = { kind: "project", id: "project-1" } as const;

    await expect(service.decide({
      principal: { kind: "agent", id: "agent-1" },
      permission: "project.write",
      resource: project,
    })).resolves.toMatchObject({ result: "allow" });

    await store.mutate((database) => {
      database.projectAgents[0]!.role = "viewer";
    });
    await expect(service.require({
      principal: { kind: "agent", id: "agent-1" },
      permission: "project.write",
      resource: project,
    })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(service.decide({
      principal: { kind: "agent", id: "agent-1" },
      permission: "project.write",
      resource: project,
    })).resolves.toMatchObject({ result: "deny", errorCode: "PERMISSION_DENIED" });
  });

  it("allows the deterministic human owner to manage membership", async () => {
    const store = await makeStore();
    const service = new RepositoryAuthorizationService(store);
    await expect(service.require({
      principal: DEMO_HUMAN_PRINCIPAL,
      permission: "project.members.manage",
      projectId: "project-1",
    })).resolves.toBeUndefined();
  });

  it("does not grant authority to an Agent that is not attached", async () => {
    const store = await makeStore();
    const service = new RepositoryAuthorizationService(store);
    await expect(service.decide({
      principal: { kind: "agent", id: "unattached-agent" },
      permission: "project.write",
      projectId: "project-1",
    })).resolves.toMatchObject({ result: "deny", errorCode: "PERMISSION_DENIED" });
  });
});
