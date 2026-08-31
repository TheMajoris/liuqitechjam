import { describe, expect, it, vi } from "vitest";
import { RoleTemplateAuthorizationService } from "../../../apps/server/src/access/role-template-authorization-service.js";
import type { AuthorizationService } from "../../../apps/server/src/access/authorization-service.js";
import type { JsonStore } from "../../../apps/server/src/store.js";

describe("RoleTemplateAuthorizationService", () => {
  it("makes a reusable role a ceiling over the configured policy authority", async () => {
    const delegate: AuthorizationService = {
      decide: vi.fn(async () => ({ result: "allow", reason: "delegate allows" })),
      require: vi.fn(async () => undefined),
    };
    const store = {
      snapshot: () => ({
        projectAgents: [{ projectId: "project-1", agentId: "agent-1", roleId: "researcher" }],
        roles: [{ id: "researcher", permissionIds: ["project.read", "tool.execute:web.search"] }],
      }),
    } as unknown as JsonStore;
    const service = new RoleTemplateAuthorizationService(store, delegate);
    const base = {
      principal: { kind: "agent" as const, id: "agent-1" },
      projectId: "project-1",
      resource: { kind: "project" as const, id: "project-1" },
    };

    await expect(service.decide({ ...base, permission: "project.read" })).resolves.toMatchObject({ result: "allow" });
    await expect(service.decide({ ...base, permission: "project.write" })).resolves.toMatchObject({
      result: "deny",
      reason: expect.stringContaining("does not include project.write"),
    });
    await expect(service.require({ ...base, permission: "project.write" })).rejects.toMatchObject({ statusCode: 403 });
    expect(delegate.require).not.toHaveBeenCalled();
  });
});
