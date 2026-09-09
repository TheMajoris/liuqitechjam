import { describe, expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import type { AgentService } from "../../apps/server/src/agent-service.js";
import type {
  OrchestrationServiceContract,
  ProjectServiceContract,
} from "../../apps/server/src/app.js";
import type { OrchestrationSession } from "../../apps/server/src/orchestration/types.js";
import type { AuditEvent, AuditEventInput } from "../../apps/server/src/audit/audit-types.js";
import type { McpRouteDependencies } from "../../apps/server/src/mcp-server.js";
import {
  WorkspaceCheckpointError,
  type WorkspaceRecoveryView,
} from "../../apps/server/src/projects/workspace-checkpoint-types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const orchestrationId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const checkpointId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
const operationId = "77777777-7777-4777-8777-777777777777";

const session: OrchestrationSession = {
  id: orchestrationId,
  name: "Wave",
  originalPrompt: "Do the thing",
  projectId,
  participants: [],
  status: "failed",
  currentParticipantId: null,
  currentRunId: null,
  stepIndex: 3,
  maxSteps: 10,
  perAgentTimeoutMs: 60_000,
  errorCode: "RUN_FAILED",
  errorMessage: "boom",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

function recoveryView(stage: WorkspaceRecoveryView["stage"]): WorkspaceRecoveryView {
  return {
    operationId,
    projectId,
    orchestrationId,
    kind: "recovery",
    checkpointId,
    safetyCheckpointId: null,
    stage,
    resumeCycleId: null,
    errorCode: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

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
        category: "workspace",
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.orchestrationId === undefined ? {} : { orchestrationId: input.orchestrationId }),
      };
      events.push(event);
      return event;
    },
  };
}

function orchestrationFixture(overrides: Partial<OrchestrationServiceContract> = {}): OrchestrationServiceContract & {
  recoverCalls: unknown[];
} {
  const recoverCalls: unknown[] = [];
  return {
    recoverCalls,
    createSession: async () => session,
    listSessions: async () => [session],
    getSession: async () => ({ session, turns: [], events: [] }),
    startSession: async () => session,
    stopSession: async () => session,
    continueSession: async () => session,
    retryFromStep: async () => session,
    deleteSession: async () => ({ deleted: true }),
    recoverFromCheckpoint: async (_id, input) => {
      recoverCalls.push(input);
      return { recovery: recoveryView("reserved"), duplicate: false };
    },
    getRecovery: async () => recoveryView("restoring"),
    resumeRecovery: async () => recoveryView("restoring"),
    restoreSafety: async () => recoveryView("restoring"),
    ...overrides,
  };
}

describe("Workspace recovery HTTP boundary", () => {
  it("accepts a strict restore request, records the human action, and returns 202", async () => {
    const orchestration = orchestrationFixture();
    const audit = fakeAudit();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      orchestration,
      undefined,
      undefined,
      undefined,
      { auditService: audit } as unknown as McpRouteDependencies,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/orchestrations/" + orchestrationId + "/recover",
      payload: { checkpointId, requestId, acknowledgeSourceRestore: true },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ recovery: recoveryView("reserved") });
    expect(orchestration.recoverCalls).toEqual([{ checkpointId, requestId, acknowledgeSourceRestore: true }]);
    const human = audit.events.find((event) => event.type === "workspace_checkpoint_restore_started");
    expect(human).toMatchObject({ actorType: "human", projectId, orchestrationId });
    expect(human?.metadata).toMatchObject({ checkpointId, operationId, requestId, trigger: "http" });

    const status = await app.inject({
      method: "GET",
      url: "/api/orchestrations/" + orchestrationId + "/recoveries/" + operationId,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().recovery.stage).toBe("restoring");
    await app.close();
  });

  it("rejects bodies that try to supply private fields or skip the acknowledgement", async () => {
    const orchestration = orchestrationFixture();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, orchestration);
    for (const payload of [
      { checkpointId, requestId, acknowledgeSourceRestore: true, gitSha: "abc" },
      { checkpointId, requestId, acknowledgeSourceRestore: true, workspacePath: "/tmp/x" },
      { checkpointId, requestId, acknowledgeSourceRestore: true, operationId },
      { checkpointId, requestId, acknowledgeSourceRestore: true, principal: { kind: "human", id: "x" } },
      { checkpointId, requestId, acknowledgeSourceRestore: false },
      { checkpointId, requestId },
      { requestId, acknowledgeSourceRestore: true },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/orchestrations/" + orchestrationId + "/recover",
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(orchestration.recoverCalls).toHaveLength(0);
    await app.close();
  });

  it("maps typed checkpoint errors to safe codes and statuses", async () => {
    const cases: [WorkspaceCheckpointError, number][] = [
      [new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Checkpoint not found"), 404],
      [new WorkspaceCheckpointError("CHECKPOINT_IDEMPOTENCY_CONFLICT", "Reused request"), 409],
      [new WorkspaceCheckpointError("CHECKPOINT_NO_REMAINING_STEPS", "Nothing to resume"), 409],
      [new WorkspaceCheckpointError("CHECKPOINT_SECRET_DETECTED", "Credential-like content"), 422],
      [new WorkspaceCheckpointError("CHECKPOINT_UNAVAILABLE", "Git unavailable"), 503],
      [new WorkspaceCheckpointError("CHECKPOINT_RESTORE_FAILED", "Apply failed"), 500],
    ];
    for (const [error, status] of cases) {
      const orchestration = orchestrationFixture({
        recoverFromCheckpoint: async () => {
          throw error;
        },
      });
      const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, orchestration);
      const response = await app.inject({
        method: "POST",
        url: "/api/orchestrations/" + orchestrationId + "/recover",
        payload: { checkpointId, requestId, acknowledgeSourceRestore: true },
      });
      expect(response.statusCode, error.code).toBe(status);
      expect(response.json()).toEqual({ error: error.message, errorCode: error.code });
      await app.close();
    }
  });

  it("returns 200 for a duplicate request whose operation already settled", async () => {
    const orchestration = orchestrationFixture({
      recoverFromCheckpoint: async () => ({ recovery: recoveryView("settled"), duplicate: true }),
    });
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, orchestration);
    const response = await app.inject({
      method: "POST",
      url: "/api/orchestrations/" + orchestrationId + "/recover",
      payload: { checkpointId, requestId, acknowledgeSourceRestore: true },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("exposes resume and safety-restore as strict operator actions", async () => {
    const orchestration = orchestrationFixture();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, orchestration);
    const resume = await app.inject({
      method: "POST",
      url: "/api/orchestrations/" + orchestrationId + "/recoveries/" + operationId + "/resume",
      payload: { requestId },
    });
    expect(resume.statusCode).toBe(202);
    const badResume = await app.inject({
      method: "POST",
      url: "/api/orchestrations/" + orchestrationId + "/recoveries/" + operationId + "/resume",
      payload: { requestId, checkpointId },
    });
    expect(badResume.statusCode).toBe(422);
    const safety = await app.inject({
      method: "POST",
      url: "/api/orchestrations/" + orchestrationId + "/recoveries/" + operationId + "/restore-safety",
      payload: { requestId, acknowledgeSourceRestore: true },
    });
    expect(safety.statusCode).toBe(202);
    await app.close();
  });

  it("answers 503 when the server has no checkpoint support, and lists checkpoints when it does", async () => {
    const legacy = orchestrationFixture({
      recoverFromCheckpoint: undefined,
      getRecovery: undefined,
      resumeRecovery: undefined,
      restoreSafety: undefined,
    });
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, legacy);
    const response = await app.inject({
      method: "POST",
      url: "/api/orchestrations/" + orchestrationId + "/recover",
      payload: { checkpointId, requestId, acknowledgeSourceRestore: true },
    });
    expect(response.statusCode).toBe(503);
    await app.close();

    const projects = {
      listWorkspaceCheckpoints: async (id: string, query: { limit?: number | undefined }) => ({
        checkpoints: [
          {
            checkpointId,
            projectId: id,
            ordinal: 3,
            kind: "turn_success",
            state: "ready",
            orchestrationId,
            turnId: "turn-1",
            runId: "run-1",
            stepIndex: 1,
            createdAt: "2026-08-29T00:00:00.000Z",
            fileCount: 12,
            byteCount: 34_000,
            excludedFileCount: 5,
            recoverable: true,
            unavailableReason: null,
          },
        ].slice(0, query.limit ?? 50),
        nextBeforeOrdinal: null,
        status: {
          enabled: true,
          available: true,
          scope: "source-v1" as const,
          busy: false,
          recoveryRequired: false,
          errorCode: null,
        },
      }),
    } as unknown as ProjectServiceContract;
    const withProjects = await createApp(loadConfig({ NODE_ENV: "test" }), service, undefined, undefined, undefined, projects);
    const listed = await withProjects.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/checkpoints?limit=10",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().checkpoints[0]).toMatchObject({ ordinal: 3, recoverable: true });
    expect(listed.body).not.toMatch(/gitSha|treeSha|manifestHash|resume|workspacePath/u);
    await withProjects.close();
  });
});
