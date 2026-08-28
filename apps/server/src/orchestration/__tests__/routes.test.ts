import { describe, expect, it, vi } from "vitest";
import { createApp, type OrchestrationServiceContract } from "../../app.js";
import { loadConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { AgentService } from "../../agent-service.js";
import type {
  CreateOrchestrationInput,
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "../types.js";

const agentService = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const session: OrchestrationSession = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Implementation pipeline",
  originalPrompt: "Implement the requested feature.",
  participants: [
    {
      id: "planner",
      agentId: "11111111-1111-4111-8111-111111111111",
      role: "Planner",
      position: 0,
    },
    {
      id: "builder",
      agentId: "22222222-2222-4222-8222-222222222222",
      role: "Builder",
      position: 1,
    },
  ],
  status: "draft",
  currentParticipantId: null,
  currentRunId: null,
  stepIndex: 0,
  maxSteps: 2,
  perAgentTimeoutMs: 30_000,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

const queuedSession: OrchestrationSession = {
  ...session,
  status: "queued",
  startedAt: "2026-08-28T00:00:01.000Z",
  updatedAt: "2026-08-28T00:00:01.000Z",
};

const stoppingSession: OrchestrationSession = {
  ...queuedSession,
  status: "stopping",
  updatedAt: "2026-08-28T00:00:02.000Z",
};

const turn: OrchestrationTurn = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sessionId: session.id,
  participantId: "planner",
  agentId: session.participants[0]!.agentId,
  runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  position: 0,
  status: "completed",
  safeInputSummary: session.originalPrompt,
  safeOutput: "Plan ready.",
  outputTruncated: false,
  errorCode: null,
  createdAt: "2026-08-28T00:00:03.000Z",
  completedAt: "2026-08-28T00:00:04.000Z",
};

const event: OrchestrationEvent = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  sessionId: session.id,
  sequence: 0,
  type: "orchestration_created",
  status: "draft",
  safeSummary: "Orchestration created",
  createdAt: session.createdAt,
};

const detail: OrchestrationSessionDetail = {
  session,
  turns: [turn],
  events: [event],
};

function makeOrchestrationService() {
  return {
    createSession: vi.fn(
      async (_input: CreateOrchestrationInput): Promise<OrchestrationSession> =>
        session,
    ),
    listSessions: vi.fn(async (): Promise<OrchestrationSession[]> => [session]),
    getSession: vi.fn(
      async (_id: string): Promise<OrchestrationSessionDetail> => detail,
    ),
    startSession: vi.fn(
      async (_id: string): Promise<OrchestrationSession> => queuedSession,
    ),
    stopSession: vi.fn(
      async (_id: string): Promise<OrchestrationSession> => stoppingSession,
    ),
  } satisfies OrchestrationServiceContract;
}

describe("orchestration HTTP routes", () => {
  it("maps create, list, detail, start, and stop to the service contract", async () => {
    const orchestration = makeOrchestrationService();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      orchestration,
    );
    const input: CreateOrchestrationInput = {
      name: session.name,
      originalPrompt: session.originalPrompt,
      participants: session.participants,
      maxSteps: session.maxSteps,
      perAgentTimeoutMs: session.perAgentTimeoutMs,
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/orchestrations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(input),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ session });
    expect(orchestration.createSession).toHaveBeenCalledWith(input);

    const listed = await app.inject({
      method: "GET",
      url: "/api/orchestrations",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ sessions: [session] });

    const fetched = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${session.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(detail);

    const started = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${session.id}/start`,
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ session: queuedSession });

    const stopped = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${session.id}/stop`,
    });
    expect(stopped.statusCode).toBe(202);
    expect(stopped.json()).toEqual({ session: stoppingSession });

    expect(orchestration.getSession).toHaveBeenCalledWith(session.id);
    expect(orchestration.startSession).toHaveBeenCalledWith(session.id);
    expect(orchestration.stopSession).toHaveBeenCalledWith(session.id);
    await app.close();
  });

  it("returns 422 for semantic body and route validation failures", async () => {
    const orchestration = makeOrchestrationService();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      orchestration,
    );

    const invalidBody = await app.inject({
      method: "POST",
      url: "/api/orchestrations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        name: "",
        originalPrompt: "",
        participants: [],
        maxSteps: 0,
        perAgentTimeoutMs: 0,
      }),
    });
    expect(invalidBody.statusCode).toBe(422);
    expect(invalidBody.json().details).toBeInstanceOf(Array);
    expect(orchestration.createSession).not.toHaveBeenCalled();

    const invalidParams = await app.inject({
      method: "GET",
      url: "/api/orchestrations/not-a-uuid",
    });
    expect(invalidParams.statusCode).toBe(422);
    await app.close();
  });

  it("passes automatic turn taking through the create route", async () => {
    const orchestration = makeOrchestrationService();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      orchestration,
    );
    const input: CreateOrchestrationInput = {
      name: session.name,
      originalPrompt: session.originalPrompt,
      participants: session.participants,
      mode: "supervisor",
      maxSteps: session.maxSteps,
      perAgentTimeoutMs: session.perAgentTimeoutMs,
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/orchestrations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(input),
    });

    expect(response.statusCode).toBe(201);
    expect(orchestration.createSession).toHaveBeenCalledWith(input);
    await app.close();
  });

  it("returns 503 when orchestration is not wired", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), agentService);
    const response = await app.inject({
      method: "GET",
      url: "/api/orchestrations",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Orchestration is not configured",
    });
    await app.close();
  });

  it("retains API auth protection for orchestration routes", async () => {
    const orchestration = makeOrchestrationService();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      agentService,
      orchestration,
    );

    const denied = await app.inject({
      method: "GET",
      url: "/api/orchestrations",
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/orchestrations",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves structured service errors", async () => {
    const orchestration = makeOrchestrationService();
    orchestration.getSession.mockRejectedValue(
      new HttpError(409, "Orchestration is already active"),
    );
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      orchestration,
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${session.id}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Orchestration is already active",
    });
    await app.close();
  });

  it("does not expose arbitrary service error details", async () => {
    const orchestration = makeOrchestrationService();
    orchestration.getSession.mockRejectedValue(
      Object.assign(new Error("Unexpected orchestration failure"), {
        details: { secret: "internal-only" },
      }),
    );
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      orchestration,
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${session.id}`,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "Unexpected orchestration failure",
    });
    await app.close();
  });
});
