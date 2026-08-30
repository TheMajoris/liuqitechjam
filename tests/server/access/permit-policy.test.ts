import { describe, expect, it } from "vitest";
import { mapAuthorizationRequestToPermitCheck } from "../../../apps/server/src/access/permit-policy.js";

describe("Permit authorization mapping", () => {
  it("maps a trusted principal, project resource, tenant, and bounded context", () => {
    expect(
      mapAuthorizationRequestToPermitCheck(
        {
          principal: { kind: "human", id: "demo-owner" },
          permission: "project.write",
          resource: { kind: "project", id: "project-1" },
          context: { projectId: "project-1", runId: "run-1" },
        },
        { tenantKey: "demo" },
      ),
    ).toEqual({
      user: "human:demo-owner",
      action: "project.write",
      resource: { type: "project", key: "project:project-1", tenant: "demo" },
      context: { projectId: "project-1", runId: "run-1" },
    });
  });

  it("maps project-scoped tools to the reconciled Project resource", () => {
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "agent", id: "agent-1" },
        permission: "tool.execute:project.preview.inspect",
        resource: { kind: "tool", id: "project.preview.inspect" },
        context: {
          projectId: "project-1",
          agentId: "agent-1",
          toolId: "project.preview.inspect",
        },
      }),
    ).toEqual({
      user: "agent:agent-1",
      action: "tool.execute.preview_inspect",
      resource: { type: "project", key: "project:project-1" },
      context: {
        projectId: "project-1",
        agentId: "agent-1",
        toolId: "project.preview.inspect",
      },
    });
  });

  it("keeps an unscoped tool check on its tool resource with a stable action", () => {
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "human", id: "demo-owner" },
        permission: "tool.execute:web.search",
        resource: { kind: "tool", id: "web.search" },
      }),
    ).toMatchObject({
      action: "tool.execute.web_search",
      resource: { type: "tool", key: "tool:web.search" },
    });
  });

  it("keeps Project execution and private Agent checks on their respective resources", () => {
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "agent", id: "agent-1" },
        permission: "agent.invoke",
        resource: { kind: "project", id: "project-1" },
        context: { projectId: "project-1", agentId: "agent-1" },
      }),
    ).toMatchObject({
      action: "agent.invoke",
      resource: { type: "project", key: "project:project-1" },
    });
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "agent", id: "agent-1" },
        permission: "agent.invoke",
        resource: { kind: "agent", id: "agent-1" },
        context: { agentId: "agent-1" },
      }),
    ).toMatchObject({
      action: "agent.invoke",
      resource: { type: "agent", key: "agent:agent-1" },
    });
  });

  it("rejects untrusted, malformed, and cross-resource requests", () => {
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "human", id: "someone-else" } as never,
        permission: "project.read",
        projectId: "project-1",
      }),
    ).toBeNull();
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "agent", id: "agent-1" },
        permission: "project.read",
        resource: { kind: "project", id: "project-1" },
        context: { projectId: "project-2" },
      }),
    ).toBeNull();
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "agent", id: "agent-1" },
        permission: "project.read",
        context: { agentId: "agent-1\nsecret" },
      }),
    ).toBeNull();
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "human", id: "demo-owner" },
        permission: "preview.inspect",
        resource: { kind: "preview", owner: null } as never,
      }),
    ).toBeNull();
    expect(
      mapAuthorizationRequestToPermitCheck({
        principal: { kind: "human", id: "demo-owner" },
        permission: "project.read",
        context: { unknown: "must-not-be-forwarded" } as never,
      }),
    ).toBeNull();
  });
});
