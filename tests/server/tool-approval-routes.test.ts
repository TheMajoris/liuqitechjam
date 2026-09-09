import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { loadConfig } from "../../apps/server/src/config.js";
import { createApp } from "../../apps/server/src/app.js";
import { HttpError } from "../../apps/server/src/errors.js";
import { RepositoryAuthorizationService } from "../../apps/server/src/access/repository-authorization-service.js";
import { emptyDatabase, type Storage } from "../../apps/server/src/store.js";
import type { AgentService } from "../../apps/server/src/agent-service.js";
import type { McpRouteDependencies } from "../../apps/server/src/mcp-server.js";
import {
  registerToolApprovalRoutes,
  type ToolApprovalRouteDependencies,
} from "../../apps/server/src/http/tool-approval-routes.js";
import {
  ToolApprovalStore,
  type ToolApprovalDecisionInput,
} from "../../apps/server/src/tools/tool-approval-store.js";
import type { ToolApprovalService } from "../../apps/server/src/tools/tool-approval-service.js";
import { McpSessionService } from "../../apps/server/src/tools/mcp-session-service.js";
import { ToolRegistry } from "../../apps/server/src/tools/tool-registry.js";
import { ToolService } from "../../apps/server/src/tools/tool-service.js";

const PROJECT_ID = "project-1";
const AGENT_ID = "agent-1";
const RUN_ID = "run-1";
const DIRECT_RUN_ID = "run-direct-1";

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

async function makeFixture(): Promise<{
  app: FastifyInstance;
  store: Storage;
  approvals: ToolApprovalStore;
  sessions: McpSessionService;
  dependencies: ToolApprovalRouteDependencies;
  decideCalls: () => number;
  setPending: (pending: boolean) => void;
  setAgentAuthorized: (authorized: boolean) => void;
  setBridgeAvailable: (available: boolean) => void;
  revokeSession: () => boolean;
}> {
  const store = makeStore();
  await store.mutate((database) => {
    database.projects.push({
      id: PROJECT_ID,
      name: "Demo Project",
      description: "",
      workspacePath: "/tmp/project-1",
      teamId: null,
      ownerPrincipalId: "demo-owner",
      status: "active",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    });
    database.runs.push({
      id: RUN_ID,
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      status: "running",
      prompt: "restart",
      output: null,
      error: null,
      usage: null,
    });
    // A direct Agent chat has no Project. Its approvals are decided by the
    // local human who owns the Agent.
    database.runs.push({
      id: DIRECT_RUN_ID,
      agentId: AGENT_ID,
      status: "running",
      prompt: "search",
      output: null,
      error: null,
      usage: null,
    });
  });
  const approvals = new ToolApprovalStore(store, {
    ownerEpoch: 1,
    now: () => Date.parse("2026-09-09T00:00:00.000Z"),
  });
  const sessions = new McpSessionService(60_000, {
    now: () => Date.parse("2026-09-09T00:00:00.000Z"),
  });
  const mintedSession = sessions.mint({
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    sessionId: "session-1",
  });
  sessions.mint({
    agentId: AGENT_ID,
    runId: DIRECT_RUN_ID,
    sessionId: "session-direct",
  });
  await approvals.createInvocation({
    approvalId: "approval-1",
    invocationId: "invocation-1",
    workflowRunId: "workflow-1",
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    sessionId: "session-1",
    toolId: "project.preview.restart",
    policyVersion: "tool-approval-v1",
    inputBinding: "object{}",
    privateInput: { value: "restart" },
    safeSummary: "Approval required for Restart preview",
    deadlineAt: "2099-01-01T00:00:00.000Z",
    initialStatus: "waiting",
  });
  const authorization = new RepositoryAuthorizationService(store);
  let decideCount = 0;
  let pending = true;
  let agentAuthorized = true;
  let bridgeAvailable = true;
  const service = {
    approvalStore: approvals,
    hasPending: () => pending,
    isAvailable: () => bridgeAvailable,
    isAdmissionEnabled: () => bridgeAvailable,
    cancel: async (invocationRef: string, reason?: string) => {
      const current = approvals.getByInvocationId(invocationRef);
      if (current === null || ["cancelled", "expired", "revoked"].includes(current.status)) return;
      await approvals.cancel({
        approvalId: current.approvalId,
        expectedVersion: current.version,
        ...(reason === undefined ? {} : { reason }),
      });
    },
    expire: async (invocationRef: string, reason?: string) => {
      const current = approvals.getByInvocationId(invocationRef);
      if (current === null || current.status === "expired") return;
      await approvals.expire({
        approvalId: current.approvalId,
        expectedVersion: current.version,
        ...(reason === undefined ? {} : { reason }),
      });
    },
    decide: async (input: ToolApprovalDecisionInput) => {
      decideCount += 1;
      await approvals.claimDecision(input);
      return {
        status: "success" as const,
        result: {
          status: input.approved ? "executed" as const : "rejected" as const,
          invocationRef: input.approvalId,
          ...(input.approved ? { result: { ok: true } } : { reason: "Rejected" }),
        },
      };
    },
  } as unknown as Pick<ToolApprovalService, "approvalStore" | "decide" | "cancel" | "expire" | "hasPending">;
  const dependencies: ToolApprovalRouteDependencies = {
    approvalService: service,
    authorization,
    getRun: async (runId) => store.snapshot().runs.find((run) => run.id === runId) ?? null,
    isSessionLive: (sessionId, record) => sessions.isLive(sessionId, record),
    authorizeAgent: async () => {
      if (!agentAuthorized) throw new Error("Agent revoked");
    },
    now: () => Date.parse("2026-09-09T00:00:00.000Z"),
  };
  const app = Fastify();
  // Mirror the application's safe validation mapping for this focused route
  // fixture without pulling in the full composition graph.
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError
      ? 400
      : error instanceof HttpError
        ? error.statusCode
        : 500;
    return reply.code(status).send({ error: error.message });
  });
  registerToolApprovalRoutes(app, dependencies);
  return {
    app,
    store,
    approvals,
    sessions,
    dependencies,
    decideCalls: () => decideCount,
    setPending: (value) => {
      pending = value;
    },
    setAgentAuthorized: (value) => {
      agentAuthorized = value;
    },
    setBridgeAvailable: (value) => {
      bridgeAvailable = value;
    },
    revokeSession: () => sessions.revoke(mintedSession.token),
  };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("tool approval HTTP routes", () => {
  it("returns a safe owner-scoped projection", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);

    const response = await fixture.app.inject({
      method: "GET",
      url: "/api/approvals/approval-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      approval: {
        approvalId: "approval-1",
        projectId: PROJECT_ID,
        status: "waiting",
        safeSummary: "Approval required for Restart preview",
      },
    });
    expect(response.body).not.toContain("privateInputHandle");
    expect(response.body).not.toContain("inputBinding");
  });

  it("computes canDecide from current bridge availability", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);

    const available = await fixture.app.inject({ method: "GET", url: "/api/approvals" });
    expect(available.json().approvals[0].canDecide).toBe(true);

    fixture.setBridgeAvailable(false);
    const unavailable = await fixture.app.inject({ method: "GET", url: "/api/approvals" });
    expect(unavailable.json().approvals[0].canDecide).toBe(false);
  });

  it("rejects forged actor/context fields before the decision service", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: {
        expectedVersion: 1,
        approved: true,
        actor: { kind: "human", id: "attacker" },
        context: { projectId: "foreign-project" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(fixture.decideCalls()).toBe(0);
  });

  it("keeps stale decisions safe and makes the same decision idempotent", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);

    const stale = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 2, approved: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(fixture.decideCalls()).toBe(0);

    const approved = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ approval: { decision: "approved" } });
    expect(fixture.decideCalls()).toBe(1);

    const duplicate = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ approval: { decision: "approved" } });
    expect(fixture.decideCalls()).toBe(1);

    const conflict = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: false },
    });
    expect(conflict.statusCode).toBe(409);
    expect(fixture.decideCalls()).toBe(1);
  });

  it("fences an approval when its originating Run is no longer live", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);
    await fixture.store.mutate((database) => {
      database.runs[0]!.status = "completed";
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });

    expect(response.statusCode).toBe(409);
    expect(fixture.approvals.get("approval-1")?.status).toBe("cancelled");
    expect(fixture.decideCalls()).toBe(0);
  });

  it("fails closed when any decision liveness witness is missing", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);
    delete (fixture.dependencies as { isSessionLive?: unknown }).isSessionLive;

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });

    expect(response.statusCode).toBe(503);
    expect(fixture.decideCalls()).toBe(0);
    expect(fixture.approvals.get("approval-1")?.status).toBe("waiting");
  });

  it("does not let a foreign Project authority decide or read an approval", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);
    await fixture.store.mutate((database) => {
      database.projects[0]!.ownerPrincipalId = "another-human";
    });

    const decision = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(decision.statusCode).toBe(403);
    expect(fixture.decideCalls()).toBe(0);

    const detail = await fixture.app.inject({
      method: "GET",
      url: "/api/approvals/approval-1",
    });
    expect(detail.statusCode).toBe(404);
  });

  it("fences expired, lost-handle, revoked-session, revoked-Agent and old-epoch decisions", async () => {
    const expired = await makeFixture();
    apps.push(expired.app);
    await expired.store.mutate((database) => {
      database.toolApprovalInvocations[0]!.deadlineAt = "2020-01-01T00:00:00.000Z";
    });
    const expiredResponse = await expired.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(expiredResponse.statusCode).toBe(409);
    expect(expired.approvals.get("approval-1")?.status).toBe("expired");

    const lost = await makeFixture();
    apps.push(lost.app);
    lost.setPending(false);
    const lostResponse = await lost.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(lostResponse.statusCode).toBe(409);
    expect(lost.approvals.get("approval-1")?.status).toBe("cancelled");

    const revokedSession = await makeFixture();
    apps.push(revokedSession.app);
    expect(revokedSession.revokeSession()).toBe(true);
    const sessionResponse = await revokedSession.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(sessionResponse.statusCode).toBe(409);
    expect(revokedSession.approvals.get("approval-1")?.status).toBe("cancelled");

    const revokedAgent = await makeFixture();
    apps.push(revokedAgent.app);
    revokedAgent.setAgentAuthorized(false);
    const agentResponse = await revokedAgent.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(agentResponse.statusCode).toBe(409);
    expect(revokedAgent.approvals.get("approval-1")?.status).toBe("cancelled");

    const oldEpoch = await makeFixture();
    apps.push(oldEpoch.app);
    await oldEpoch.approvals.rotateOwnerEpoch(2);
    const oldEpochResponse = await oldEpoch.app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(oldEpochResponse.statusCode).toBe(409);
    expect(oldEpoch.approvals.get("approval-1")?.status).toBe("cancelled");
  });

  it("fences a decision when the current Agent role no longer includes the tool", async () => {
    const fixture = await makeFixture();
    const toolId = "project.preview.restart";
    let roleIncludesTool = true;
    const toolService = new ToolService(
      new ToolRegistry([{
        id: toolId,
        title: "Restart Project Preview",
        description: "Restart the shared Project preview server.",
        risk: "write",
        requiredPermission: "tool.execute:project.preview.restart",
        approvalPolicy: { mode: "required", version: "tool-approval-v1" },
        inputSchema: z.object({}),
        outputSchema: z.unknown(),
        execute: async () => null,
      }]),
      fixture.dependencies.authorization!,
      fixture.store,
    );
    toolService.setProjectRoleToolResolver({
      getEffectiveRole: () => ({
        toolIds: roleIncludesTool ? [toolId] : [],
      }),
    });
    roleIncludesTool = false;

    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      getRun: () => fixture.store.snapshot().runs[0],
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sessions: fixture.sessions,
        toolService,
        approvalService: fixture.dependencies.approvalService,
        authorizationService: fixture.dependencies.authorization,
      },
    );
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(response.statusCode).toBe(409);
    expect(fixture.approvals.get("approval-1")?.status).toBe("cancelled");
    expect(fixture.decideCalls()).toBe(0);
  });

  it("uses the server-owned web.search authority for approve/reject and denies Project-less records", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);
    for (const [approvalId, invocationId, approved] of [
      ["approval-search-approve", "invocation-search-approve", true],
      ["approval-search-reject", "invocation-search-reject", false],
    ] as const) {
      await fixture.approvals.createInvocation({
        approvalId,
        invocationId,
        workflowRunId: `workflow-${invocationId}`,
        agentId: AGENT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        sessionId: "session-1",
        toolId: "web.search",
        policyVersion: "tool-approval-v2",
        inputBinding: "object{query:string:\"launchpad\";};",
        privateInput: { query: "launchpad" },
        safeSummary: "Approval required for Web Search",
        deadlineAt: "2099-01-01T00:00:00.000Z",
        initialStatus: "waiting",
      });
      const response = await fixture.app.inject({
        method: "POST",
        url: `/api/approvals/${approvalId}/decision`,
        payload: { expectedVersion: 1, approved },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().approval.decision).toBe(approved ? "approved" : "rejected");
    }
    expect(fixture.decideCalls()).toBe(2);

    await fixture.approvals.createInvocation({
      approvalId: "approval-search-projectless",
      invocationId: "invocation-search-projectless",
      workflowRunId: "workflow-search-projectless",
      agentId: AGENT_ID,
      projectId: null,
      runId: RUN_ID,
      sessionId: null,
      toolId: "web.search",
      policyVersion: "tool-approval-v2",
      inputBinding: "object{}",
      privateInput: {},
      safeSummary: "Approval required for Web Search",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      initialStatus: "waiting",
    });
    // A Project-less record is no longer refused by decision authority; it is
    // refused here only because it carries no live MCP session.
    const projectless = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-search-projectless/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(projectless.statusCode).toBe(409);
    expect(fixture.decideCalls()).toBe(2);
  });

  it("lets the local human decide a direct Agent run's approval", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);
    await fixture.approvals.createInvocation({
      approvalId: "approval-direct-search",
      invocationId: "invocation-direct-search",
      workflowRunId: "workflow-direct-search",
      agentId: AGENT_ID,
      projectId: null,
      runId: DIRECT_RUN_ID,
      sessionId: "session-direct",
      toolId: "web.search",
      policyVersion: "tool-approval-v2",
      inputBinding: "object{query:string:\"launchpad\";};",
      privateInput: { query: "launchpad" },
      safeSummary: "Approval required for Web Search",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      initialStatus: "waiting",
    });

    const listed = await fixture.app.inject({
      method: "GET",
      url: "/api/approvals?runId=" + DIRECT_RUN_ID,
    });
    expect(listed.statusCode).toBe(200);
    const visible = listed.json().approvals as { approvalId: string; canDecide: boolean }[];
    expect(visible.map((item) => item.approvalId)).toContain("approval-direct-search");
    expect(visible.find((item) => item.approvalId === "approval-direct-search")?.canDecide).toBe(true);

    const decision = await fixture.app.inject({
      method: "POST",
      url: "/api/approvals/approval-direct-search/decision",
      payload: { expectedVersion: 1, approved: true },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json().approval.decision).toBe("approved");
  });

  it("filters and authorizes the whole collection before sorting and limiting", async () => {
    const fixture = await makeFixture();
    apps.push(fixture.app);
    for (const [suffix, createdAt] of [
      ["old", "2026-09-09T00:00:01.000Z"],
      ["middle", "2026-09-09T00:00:02.000Z"],
      ["new", "2026-09-09T00:00:03.000Z"],
    ] as const) {
      await fixture.approvals.createInvocation({
        approvalId: `approval-${suffix}`,
        invocationId: `invocation-${suffix}`,
        workflowRunId: `workflow-${suffix}`,
        agentId: AGENT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        sessionId: "session-1",
        toolId: "project.preview.restart",
        policyVersion: "tool-approval-v1",
        inputBinding: "object{}",
        privateInput: {},
        safeSummary: `Approval ${suffix}`,
        deadlineAt: "2099-01-01T00:00:00.000Z",
        createdAt,
        initialStatus: "waiting",
      });
    }

    const response = await fixture.app.inject({
      method: "GET",
      url: "/api/approvals?status=waiting&limit=2",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().approvals.map((item: { approvalId: string }) => item.approvalId)).toEqual([
      "approval-new",
      "approval-middle",
    ]);
  });

  it("honors the app's configured HTTP authentication token", async () => {
    const fixture = await makeFixture();
    const service = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      getRun: () => fixture.store.snapshot().runs[0],
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "approval-route-token" }),
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sessions: {} as McpRouteDependencies["sessions"],
        toolService: {} as McpRouteDependencies["toolService"],
        approvalService: fixture.dependencies.approvalService,
        authorizationService: fixture.dependencies.authorization,
      },
    );
    apps.push(app);

    await expect(app.inject({ method: "GET", url: "/api/approvals" })).resolves.toMatchObject({
      statusCode: 401,
    });
    const allowed = await app.inject({
      method: "GET",
      url: "/api/approvals",
      headers: { authorization: "Bearer approval-route-token" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().approvals).toHaveLength(1);
  });
});
