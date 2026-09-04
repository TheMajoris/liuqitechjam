import { describe, expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import type { AgentService } from "../../apps/server/src/agent-service.js";
import type {
  OrchestrationServiceContract,
  PreviewServiceContract,
  ProjectServiceContract,
} from "../../apps/server/src/app.js";
import type { PreviewView } from "../../apps/server/src/preview/preview-types.js";
import type { OrchestrationSession } from "../../apps/server/src/orchestration/types.js";
import type { ProjectView } from "../../apps/server/src/projects/project-types.js";
import type { AuditEvent, AuditEventInput } from "../../apps/server/src/audit/audit-types.js";
import type { McpRouteDependencies } from "../../apps/server/src/mcp-server.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("exposes the primary preview start/get/logs/stop flow", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const timestamps = {
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:01.000Z",
    };
    const preview: PreviewView = {
      id: "22222222-2222-4222-8222-222222222222",
      agentId,
      status: "running",
      host: "127.0.0.1",
      hostPort: 41_231,
      url: "http://127.0.0.1:41231",
      errorCode: null,
      errorMessage: null,
      ...timestamps,
      startedAt: timestamps.createdAt,
      stoppedAt: null,
    };
    const previewService: PreviewServiceContract = {
      start: async () => preview,
      get: async () => preview,
      restart: async () => preview,
      stop: async () => ({ ...preview, status: "stopped", url: null }),
      logs: async () => ({ preview, logs: ["ready"], truncated: false }),
    };
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      previewService,
    );

    const started = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/preview/start",
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ preview: { status: "running" } });

    const inspected = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId + "/preview",
    });
    expect(inspected.statusCode).toBe(200);

    const logs = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId + "/preview/logs?tail=1",
    });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().logs).toEqual(["ready"]);

    const stopped = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/preview/stop",
    });
    expect(stopped.statusCode).toBe(202);
    expect(stopped.json()).toMatchObject({ preview: { status: "stopped" } });
    await app.close();
  });

  function fakeAudit(): McpRouteDependencies["auditService"] & { events: AuditEvent[] } {
    const events: AuditEvent[] = [];
    return {
      events,
      query: () => events,
      record: async (input: AuditEventInput) => {
        const event: AuditEvent = {
          id: String(events.length + 1),
          type: input.type,
          status: input.status,
          summary: input.summary,
          createdAt: new Date().toISOString(),
          principal: input.principal,
          metadata: (input.metadata ?? {}) as AuditEvent["metadata"],
          traceId: input.span?.traceId ?? "trace",
          spanId: input.span?.spanId ?? "span",
          sequence: events.length + 1,
          actorType: input.actorType ?? input.principal.kind,
          category: "orchestration",
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.orchestrationId === undefined ? {} : { orchestrationId: input.orchestrationId }),
        };
        events.push(event);
        return event;
      },
    };
  }

  it("records a human-attributed audit event when an orchestration is started via HTTP", async () => {
    const orchestrationId = "33333333-3333-4333-8333-333333333333";
    const session: OrchestrationSession = {
      id: orchestrationId,
      name: "Wave",
      originalPrompt: "Do the thing",
      participants: [],
      status: "running",
      currentParticipantId: null,
      currentRunId: null,
      stepIndex: 0,
      maxSteps: 10,
      perAgentTimeoutMs: 60_000,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const orchestrationService: OrchestrationServiceContract = {
      createSession: async () => session,
      listSessions: async () => [session],
      getSession: async () => ({ ...session, turns: [], events: [] }) as never,
      startSession: async () => session,
      stopSession: async () => session,
      continueSession: async () => session,
      deleteSession: async () => ({ deleted: true }),
    };
    const audit = fakeAudit();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      orchestrationService,
      undefined,
      undefined,
      undefined,
      { auditService: audit } as McpRouteDependencies,
    );

    const started = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/start`,
    });
    expect(started.statusCode).toBe(202);

    const recorded = audit.events.find((event) => event.type === "orchestration_started");
    expect(recorded).toBeDefined();
    expect(recorded?.actorType).toBe("human");
    expect(recorded?.principal.kind).toBe("human");
    expect(recorded?.orchestrationId).toBe(orchestrationId);
    await app.close();
  });

  it("records a human-attributed audit event when an agent is stopped via HTTP", async () => {
    const agentId = "44444444-4444-4444-8444-444444444444";
    const stoppableAgentService = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      stopAgent: async () => ({ id: agentId, status: "ready" }),
    } as unknown as AgentService;
    const audit = fakeAudit();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      stoppableAgentService,
      undefined,
      undefined,
      undefined,
      undefined,
      { auditService: audit } as McpRouteDependencies,
    );

    const stopped = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/stop`,
    });
    expect(stopped.statusCode).toBe(200);

    const recorded = audit.events.find((event) => event.type === "agent_stopped");
    expect(recorded).toBeDefined();
    expect(recorded?.actorType).toBe("human");
    expect(recorded?.agentId).toBe(agentId);
    await app.close();
  });

  it("records a human-attributed audit event when a Project Agent role is changed via HTTP", async () => {
    const projectId = "55555555-5555-4555-8555-555555555555";
    const agentId = "66666666-6666-4666-8666-666666666666";
    const baseProject: ProjectView = {
      id: projectId,
      name: "Demo Project",
      description: "",
      teamId: null,
      agentIds: [agentId],
      memberships: [{ agentId, role: "viewer" }],
      status: "active",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const projectService: ProjectServiceContract = {
      create: async () => baseProject,
      list: async () => [baseProject],
      get: async () => baseProject,
      update: async () => baseProject,
      archive: async () => ({ archivedWorkspace: null }),
      deletePermanently: async () => ({ deleted: true }),
      attachAgent: async () => baseProject,
      updateAgentRole: async () => ({
        ...baseProject,
        memberships: [{ agentId, role: "editor" }],
      }),
      detachAgent: async () => baseProject,
      attachTeam: async () => baseProject,
      detachTeam: async () => baseProject,
    };
    const audit = fakeAudit();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      undefined,
      projectService,
      { auditService: audit } as McpRouteDependencies,
    );

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/agents/${agentId}`,
      payload: { role: "editor" },
    });
    expect(updated.statusCode).toBe(200);

    const recorded = audit.events.find((event) => event.type === "project_role_changed");
    expect(recorded).toBeDefined();
    expect(recorded?.actorType).toBe("human");
    expect(recorded?.metadata.toRole).toBe("editor");
    await app.close();
  });

  it("exposes the audit chain verification projection", async () => {
    const audit = {
      ...fakeAudit(),
      verify: () => ({ ok: true, checked: 3 }),
    };
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      { auditService: audit } as McpRouteDependencies,
    );

    const verified = await app.inject({ method: "GET", url: "/api/audit/verify" });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ ok: true, checked: 3 });
    await app.close();
  });
});
