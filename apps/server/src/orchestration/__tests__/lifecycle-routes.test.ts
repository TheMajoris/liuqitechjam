import { describe, expect, it, vi } from "vitest";
import { createApp, type OrchestrationServiceContract } from "../../app.js";
import { loadConfig } from "../../config.js";
import type { AgentService } from "../../agent-service.js";
import type {
  CreateOrchestrationInput,
  OrchestrationSession,
  OrchestrationSessionDetail,
} from "../types.js";

const agentService = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const session: OrchestrationSession = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Team chat",
  originalPrompt: "Plan the release.",
  participants: [
    {
      id: "worker",
      agentId: "11111111-1111-4111-8111-111111111111",
      role: "Worker",
      position: 0,
    },
  ],
  mode: "sequential",
  completionReason: "roster_exhausted",
  status: "completed",
  currentParticipantId: null,
  currentRunId: null,
  stepIndex: 1,
  maxSteps: 1,
  perAgentTimeoutMs: 1_000,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:01.000Z",
  startedAt: "2026-08-29T00:00:00.000Z",
  completedAt: "2026-08-29T00:00:01.000Z",
};

const detail: OrchestrationSessionDetail = {
  session,
  turns: [],
  events: [],
  continuationPrompts: [],
};

function makeService() {
  return {
    createSession: vi.fn(
      async (_input: CreateOrchestrationInput): Promise<OrchestrationSession> =>
        session,
    ),
    listSessions: vi.fn(async (): Promise<OrchestrationSession[]> => [session]),
    getSession: vi.fn(async (_id: string): Promise<OrchestrationSessionDetail> => detail),
    startSession: vi.fn(async (_id: string): Promise<OrchestrationSession> => session),
    stopSession: vi.fn(async (_id: string): Promise<OrchestrationSession> => session),
    continueSession: vi.fn(
      async (_id: string, _prompt: string): Promise<OrchestrationSession> => session,
    ),
    deleteSession: vi.fn(async (_id: string): Promise<{ deleted: true }> => ({ deleted: true })),
  } satisfies OrchestrationServiceContract;
}

describe("conversation lifecycle HTTP routes", () => {
  it("accepts a follow-up on the same session and permanently deletes it", async () => {
    const orchestration = makeService();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      orchestration,
    );

    const continued = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${session.id}/continue`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ prompt: "Now implement the plan." }),
    });
    expect(continued.statusCode).toBe(202);
    expect(continued.json()).toEqual({ session });
    expect(orchestration.continueSession).toHaveBeenCalledWith(
      session.id,
      "Now implement the plan.",
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/orchestrations/${session.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect(orchestration.deleteSession).toHaveBeenCalledWith(session.id);
    await app.close();
  });

  it("validates follow-up payload and route IDs before invoking the service", async () => {
    const orchestration = makeService();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      agentService,
      orchestration,
    );

    const invalidBody = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${session.id}/continue`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ prompt: "   " }),
    });
    expect(invalidBody.statusCode).toBe(422);
    expect(orchestration.continueSession).not.toHaveBeenCalled();

    const invalidId = await app.inject({
      method: "DELETE",
      url: "/api/orchestrations/not-a-uuid",
    });
    expect(invalidId.statusCode).toBe(422);
    expect(orchestration.deleteSession).not.toHaveBeenCalled();
    await app.close();
  });
});
