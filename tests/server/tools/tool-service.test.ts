import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentPrincipal } from "../../../apps/server/src/access/access-types.js";
import { RepositoryAuthorizationService } from "../../../apps/server/src/access/repository-authorization-service.js";
import type { PermissionId } from "../../../apps/server/src/access/permission-types.js";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRecorder,
} from "../../../apps/server/src/audit/audit-types.js";
import { emptyDatabase, type Storage } from "../../../apps/server/src/store.js";
import type { Agent } from "../../../apps/server/src/types.js";
import type { AgentRole } from "../../../apps/server/src/roles/role-types.js";
import type { Project, ProjectAgentAttachment } from "../../../apps/server/src/projects/project-types.js";
import { ToolRegistry } from "../../../apps/server/src/tools/tool-registry.js";
import { ToolService } from "../../../apps/server/src/tools/tool-service.js";
import type { ToolDefinition, ToolExecutionContext } from "../../../apps/server/src/tools/tool-types.js";

const timestamp = "2026-09-07T00:00:00.000Z";

class RecordingAudit implements AuditRecorder {
  readonly inputs: AuditEventInput[] = [];

  async record(input: AuditEventInput): Promise<AuditEvent> {
    this.inputs.push(input);
    return {} as AuditEvent;
  }

  ofType(type: AuditEventInput["type"]): AuditEventInput[] {
    return this.inputs.filter((input) => input.type === type);
  }
}

function makeStore(): Storage {
  let data = emptyDatabase();
  return {
    auditRetention: "bounded",
    async initialize() {},
    snapshot: () => structuredClone(data),
    async mutate<T>(mutation: (database: ReturnType<typeof emptyDatabase>) => T | Promise<T>) {
      const next = structuredClone(data);
      const result = await mutation(next);
      data = next;
      return result;
    },
    async close() {},
  };
}

function makeAgent(globalRoleId?: string): Agent {
  return {
    id: "agent-1",
    name: "Researcher",
    description: "",
    instructions: "",
    ...(globalRoleId === undefined ? {} : { globalRoleId }),
    status: "ready",
    workspacePath: "/tmp/agent-1",
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeRole(
  toolIds: string[],
  permissionIds: PermissionId[],
): AgentRole {
  return {
    id: "researcher",
    name: "Researcher",
    description: "",
    skillIds: [],
    toolIds,
    permissionIds,
    source: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeProject(): Project {
  return {
    id: "project-1",
    name: "Demo",
    description: "",
    workspacePath: "/tmp/project-1",
    teamId: null,
    ownerPrincipalId: "demo-owner",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeAttachment(): ProjectAgentAttachment {
  return {
    projectId: "project-1",
    agentId: "agent-1",
    codexThreadId: null,
    attachedAt: timestamp,
    role: "editor",
    toolGrants: [],
    updatedAt: timestamp,
  };
}

type ToolCalls = { search: number; fetch: number };

function webTools(calls: ToolCalls): ToolDefinition<unknown, unknown>[] {
  return [
    {
      id: "web.search",
      title: "Search",
      description: "Test search",
      risk: "network",
      requiredPermission: "tool.execute:web.search",
      inputSchema: z.object({ query: z.string().min(1) }),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute() {
        calls.search += 1;
        return { ok: true };
      },
    },
    {
      id: "web.fetch",
      title: "Fetch",
      description: "Test fetch",
      risk: "network",
      requiredPermission: "tool.execute:web.fetch",
      inputSchema: z.object({ url: z.string().url() }),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute() {
        calls.fetch += 1;
        return { ok: true };
      },
    },
  ];
}

function context(projectId?: string): ToolExecutionContext {
  return {
    principal: agentPrincipal("agent-1"),
    agentId: "agent-1",
    ...(projectId === undefined ? {} : { projectId }),
    runId: projectId === undefined ? "run-direct" : "run-project",
  };
}

async function seed(
  store: Storage,
  options: { globalRole?: AgentRole; project?: boolean } = {},
): Promise<void> {
  await store.mutate((database) => {
    database.agents.push(makeAgent(options.globalRole?.id));
    if (options.globalRole) database.roles.push(options.globalRole);
    if (options.project) {
      database.projects.push(makeProject());
      database.projectAgents.push(makeAttachment());
    }
  });
}

const toolCases = [
  {
    id: "web.search",
    permission: "tool.execute:web.search" as const,
    input: { query: "launchpad" },
  },
  {
    id: "web.fetch",
    permission: "tool.execute:web.fetch" as const,
    input: { url: "https://example.com" },
  },
] as const;

const roots: Storage[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((store) => store.close()));
});

describe("ToolService Agent web permissions", () => {
  it("does not let workspace membership grant roleless web tools", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, { project: true });
    const audit = new RecordingAudit();
    const calls = { search: 0, fetch: 0 };
    const service = new ToolService(
      new ToolRegistry(webTools(calls)),
      new RepositoryAuthorizationService(store),
      store,
      audit,
    );

    const capabilities = await service.listCapabilities("agent-1", "project-1");
    for (const tool of toolCases) {
      expect(capabilities.tools.find((item) => item.tool.id === tool.id)).toMatchObject({
        availability: "denied",
      });
      await expect(service.execute(context("project-1"), tool.id, tool.input)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }

    expect(calls).toEqual({ search: 0, fetch: 0 });
    expect(audit.ofType("tool_failed")).toHaveLength(2);
    expect(audit.ofType("tool_failed")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "project-1",
          permission: "tool.execute:web.search",
          metadata: expect.objectContaining({ phase: "authorization", decision: "agent_role" }),
        }),
        expect.objectContaining({
          projectId: "project-1",
          permission: "tool.execute:web.fetch",
          metadata: expect.objectContaining({ phase: "authorization", decision: "agent_role" }),
        }),
      ]),
    );
  });

  it("requires both the matching tool and permission in direct and project scopes", async () => {
    for (const scope of [undefined, "project-1"] as const) {
      for (const tool of toolCases) {
        for (const missing of ["tool", "permission"] as const) {
          const store = makeStore();
          roots.push(store);
          const role = makeRole(
            missing === "tool" ? [] : [tool.id],
            missing === "permission" ? [] : [tool.permission],
          );
          await seed(store, { globalRole: role, project: scope !== undefined });
          const calls = { search: 0, fetch: 0 };
          const service = new ToolService(
            new ToolRegistry(webTools(calls)),
            new RepositoryAuthorizationService(store),
            store,
          );

          const capabilities = await service.listCapabilities("agent-1", scope);
          expect(capabilities.tools.find((item) => item.tool.id === tool.id)).toMatchObject({
            availability: "denied",
          });
          await expect(service.execute(context(scope), tool.id, tool.input)).rejects.toMatchObject({
            code: "PERMISSION_DENIED",
          });
          expect(calls).toEqual({ search: 0, fetch: 0 });
        }
      }
    }
  });

  it("allows a complete global grant only while Project membership also allows it", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, {
      globalRole: makeRole(
        ["web.search", "web.fetch"],
        ["tool.execute:web.search", "tool.execute:web.fetch"],
      ),
      project: true,
    });
    const calls = { search: 0, fetch: 0 };
    const service = new ToolService(
      new ToolRegistry(webTools(calls)),
      new RepositoryAuthorizationService(store),
      store,
    );

    const available = await service.listCapabilities("agent-1", "project-1");
    for (const tool of toolCases) {
      expect(available.tools.find((item) => item.tool.id === tool.id)).toMatchObject({
        availability: "available",
      });
      await expect(service.execute(context("project-1"), tool.id, tool.input)).resolves.toEqual({ ok: true });
    }
    await expect(service.execute(context(), "web.search", { query: "direct" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual({ search: 2, fetch: 1 });

    await store.mutate((database) => {
      database.projectAgents = [];
    });
    const denied = await service.listCapabilities("agent-1", "project-1");
    for (const tool of toolCases) {
      expect(denied.tools.find((item) => item.tool.id === tool.id)).toMatchObject({
        availability: "denied",
      });
    }
    await expect(service.execute(context("project-1"), "web.search", { query: "blocked" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(calls).toEqual({ search: 2, fetch: 1 });
  });
});
