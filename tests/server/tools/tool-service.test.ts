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
import type {
  PreparedToolInvocation,
  ToolDefinition,
  ToolExecutionContext,
} from "../../../apps/server/src/tools/tool-types.js";
import {
  ToolError,
} from "../../../apps/server/src/tools/tool-errors.js";
import { ToolExecutionClaim } from "../../../apps/server/src/tools/tool-service.js";

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

function restartTool(calls: { restart: number }): ToolDefinition<unknown, unknown> {
  return {
    id: "project.preview.restart",
    title: "Restart preview",
    description: "Test restart",
    risk: "write",
    requiredPermission: "tool.execute:project.preview.restart",
    approvalPolicy: { mode: "required", version: "test-policy-v1" },
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute() {
      calls.restart += 1;
      return { ok: true };
    },
  };
}

function transformedProjectTool(): ToolDefinition<unknown, unknown> {
  return {
    id: "project.preview.inspect",
    title: "Inspect preview",
    description: "Test transformed project input",
    risk: "read",
    requiredPermission: "tool.execute:project.preview.inspect",
    inputSchema: z.object({ target: z.string() }).transform(() => ({ projectId: "project-other" })),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute() {
      return { ok: true };
    },
  };
}

function transformedRestartTool(calls: { inputs: unknown[] }): ToolDefinition<unknown, unknown> {
  return {
    id: "project.preview.restart",
    title: "Restart preview",
    description: "Test one-way transformed input",
    risk: "write",
    requiredPermission: "tool.execute:project.preview.restart",
    approvalPolicy: { mode: "required", version: "test-policy-v1" },
    inputSchema: z
      .object({ target: z.string().min(1) })
      .transform(({ target }) => ({
        normalized: target.trim().toUpperCase(),
      })),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute(_context, input) {
      calls.inputs.push(input);
      return { ok: true };
    },
  };
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

  it("rechecks live authorization after a tool was advertised and the Project grant is revoked", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, {
      globalRole: makeRole(
        ["web.search"],
        ["tool.execute:web.search"],
      ),
      project: true,
    });
    const calls = { search: 0, fetch: 0 };
    const service = new ToolService(
      new ToolRegistry(webTools(calls)),
      new RepositoryAuthorizationService(store),
      store,
    );

    await expect(service.execute(context("project-1"), "web.search", { query: "before-revoke" }))
      .resolves.toEqual({ ok: true });
    await store.mutate((database) => {
      database.projectAgents = [];
    });

    await expect(service.execute(context("project-1"), "web.search", { query: "after-revoke" }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(calls).toEqual({ search: 1, fetch: 0 });
  });
});

describe("ToolService approval preparation and guarded execution", () => {
  it("prepares restart without executing, rejects forged claims, and allows the trusted human path", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, { project: true });
    await store.mutate((database) => {
      const attachment = database.projectAgents[0];
      if (attachment) attachment.role = "owner";
    });
    const calls = { restart: 0 };
    const service = new ToolService(
      new ToolRegistry([restartTool(calls)]),
      new RepositoryAuthorizationService(store),
      store,
    );

    const prepared = await service.prepareInvocation(context("project-1"), "project.preview.restart", {});
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.context)).toBe(true);
    expect("input" in prepared).toBe(false);
    expect(prepared.policy).toMatchObject({ mode: "required", version: "test-policy-v1" });
    expect(calls.restart).toBe(0);

    await expect(service.execute(context("project-1"), "project.preview.restart", {})).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    await expect(service.executePrepared(prepared)).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    expect(calls.restart).toBe(0);

    const forged = { ...prepared } as PreparedToolInvocation;
    await expect(
      service.executePrepared(forged, Object.create(ToolExecutionClaim.prototype) as ToolExecutionClaim),
    ).rejects.toMatchObject({ code: "TOOL_INVOCATION_INVALIDATED" });
    expect(calls.restart).toBe(0);

    const claim = service.issueExecutionClaim(prepared);
    await expect(service.executePrepared(prepared, claim)).resolves.toEqual({ ok: true });
    expect(calls.restart).toBe(1);

    await expect(service.executePrepared(prepared, claim)).rejects.toMatchObject({
      code: "TOOL_EXECUTION_CLAIM_FAILED",
    });

    await expect(
      service.execute(
        {
          principal: { kind: "human", id: "demo-owner" },
          agentId: "agent-1",
          projectId: "project-1",
          runId: "human-tool-test",
        },
        "project.preview.restart",
        {},
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls.restart).toBe(2);
  });

  it("invalidates a prepared invocation after live authorization or policy changes", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, { project: true });
    await store.mutate((database) => {
      const attachment = database.projectAgents[0];
      if (attachment) attachment.role = "owner";
    });
    const calls = { restart: 0 };
    const definition = restartTool(calls);
    const service = new ToolService(
      new ToolRegistry([definition]),
      new RepositoryAuthorizationService(store),
      store,
    );
    const prepared = await service.prepareInvocation(context("project-1"), "project.preview.restart", {});

    await store.mutate((database) => {
      database.projectAgents = [];
    });
    await expect(
      service.executePrepared(prepared, service.issueExecutionClaim(prepared)),
    ).rejects.toMatchObject({ code: "TOOL_INVOCATION_INVALIDATED" });
    expect(calls.restart).toBe(0);

    await store.mutate((database) => {
      database.projectAgents.push(makeAttachment());
      const attachment = database.projectAgents[0];
      if (attachment) attachment.role = "owner";
    });
    const second = await service.prepareInvocation(context("project-1"), "project.preview.restart", {});
    definition.approvalPolicy = { mode: "required", version: "test-policy-v2" };
    await expect(
      service.executePrepared(second, service.issueExecutionClaim(second)),
    ).rejects.toMatchObject({ code: "TOOL_INVOCATION_INVALIDATED" });
    expect(calls.restart).toBe(0);
  });

  it("rejects Project smuggling before and after schema parsing", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, { project: true });
    const service = new ToolService(
      new ToolRegistry([transformedProjectTool()]),
      new RepositoryAuthorizationService(store),
      store,
    );

    await expect(
      service.execute(context("project-1"), "project.preview.inspect", { projectId: "project-other" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      service.execute(context("project-1"), "project.preview.inspect", { target: "other" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("revalidates the raw request while retaining the original one-way transform", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, { project: true });
    await store.mutate((database) => {
      const attachment = database.projectAgents[0];
      if (attachment) attachment.role = "owner";
    });
    const calls = { inputs: [] as unknown[] };
    const service = new ToolService(
      new ToolRegistry([transformedRestartTool(calls)]),
      new RepositoryAuthorizationService(store),
      store,
    );

    const prepared = await service.prepareInvocation(
      context("project-1"),
      "project.preview.restart",
      { target: "  first  " },
    );
    expect("input" in prepared).toBe(false);
    expect("rawInput" in prepared).toBe(false);

    const claim = service.issueExecutionClaim(prepared);
    await expect(service.executePrepared(prepared, claim)).resolves.toEqual({ ok: true });
    expect(calls.inputs).toEqual([{ normalized: "FIRST" }]);
  });

  it("snapshots input without freezing or mutating the caller object", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, { project: true });
    await store.mutate((database) => {
      const attachment = database.projectAgents[0];
      if (attachment) attachment.role = "owner";
    });
    const calls = { inputs: [] as unknown[] };
    const service = new ToolService(
      new ToolRegistry([transformedRestartTool(calls)]),
      new RepositoryAuthorizationService(store),
      store,
    );
    const input = { target: "original" };
    const prepared = await service.prepareInvocation(
      context("project-1"),
      "project.preview.restart",
      input,
    );

    expect(Object.isFrozen(input)).toBe(false);
    input.target = "mutated-after-preparation";
    const claim = service.issueExecutionClaim(prepared);
    await expect(service.executePrepared(prepared, claim)).resolves.toEqual({ ok: true });
    expect(calls.inputs).toEqual([{ normalized: "ORIGINAL" }]);
  });

  it("records guard rejection as authorization without a phantom tool failure", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, { project: true });
    await store.mutate((database) => {
      const attachment = database.projectAgents[0];
      if (attachment) attachment.role = "owner";
    });
    const audit = new RecordingAudit();
    const calls = { restart: 0 };
    const service = new ToolService(
      new ToolRegistry([restartTool(calls)]),
      new RepositoryAuthorizationService(store),
      store,
      audit,
    );
    const prepared = await service.prepareInvocation(context("project-1"), "project.preview.restart", {});
    await expect(service.executePrepared(prepared)).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });

    expect(audit.ofType("tool_started")).toHaveLength(0);
    expect(audit.ofType("tool_succeeded")).toHaveLength(0);
    expect(audit.ofType("tool_failed")).toHaveLength(0);
    expect(audit.ofType("authorization_decision")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failure",
          metadata: expect.objectContaining({
            phase: "execution_guard",
            errorCode: "APPROVAL_REQUIRED",
          }),
        }),
      ]),
    );
    expect(calls.restart).toBe(0);
  });

  it("does not invoke the executor or approval path for denied identity and scope", async () => {
    const store = makeStore();
    roots.push(store);
    await seed(store, { project: true });
    const calls = { restart: 0 };
    const audit = new RecordingAudit();
    const service = new ToolService(
      new ToolRegistry([restartTool(calls)]),
      new RepositoryAuthorizationService(store),
      store,
      audit,
    );

    const deniedContexts: ToolExecutionContext[] = [
      {
        principal: { kind: "agent", id: "agent-other" },
        agentId: "agent-1",
        projectId: "project-1",
        runId: "run-identity-mismatch",
      },
      {
        principal: { kind: "agent", id: "agent-1" },
        agentId: "agent-1",
        runId: "run-missing-project",
      },
    ];
    for (const deniedContext of deniedContexts) {
      await expect(
        service.execute(deniedContext, "project.preview.restart", {}),
      ).rejects.toBeInstanceOf(ToolError);
    }
    const failedBeforeDirectPreparation = audit.ofType("tool_failed").length;
    await expect(
      service.prepareInvocation(deniedContexts[0]!, "project.preview.restart", {}),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(calls.restart).toBe(0);
    expect(audit.ofType("tool_failed")).toHaveLength(failedBeforeDirectPreparation + 1);
    expect(audit.ofType("tool_failed").at(-1)).toMatchObject({
      metadata: expect.objectContaining({
        phase: "authorization",
        decision: "identity_mismatch",
        errorCode: "PERMISSION_DENIED",
      }),
    });
    expect(audit.ofType("tool_approval_required")).toHaveLength(0);
  });
});
