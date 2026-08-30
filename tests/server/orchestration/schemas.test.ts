import { describe, expect, it } from "vitest";
import {
  CreateOrchestrationSchema,
  HandoffEnvelopeSchema,
  OrchestrationEventSchema,
  OrchestrationSessionDetailSchema,
  OrchestrationRouteParamsSchema,
} from "../../../apps/server/src/orchestration/schemas.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

const participant = (id: string, position: number, role: string) => ({
  id,
  agentId,
  role,
  position,
});

describe("orchestration contracts", () => {
  it("accepts an arbitrary ordered roster, including a repeated Agent", () => {
    const result = CreateOrchestrationSchema.safeParse({
      name: "  Product pipeline  ",
      originalPrompt: "  Improve the product in stages.  ",
      participants: [
        participant("planner", 0, "Planner"),
        participant("builder", 1, "Builder"),
        participant("reviewer", 2, "Reviewer"),
        participant("polisher", 3, "Polisher"),
        participant("second-review", 4, "Second reviewer"),
      ],
      maxSteps: 5,
      perAgentTimeoutMs: 300_000,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Product pipeline");
      expect(result.data.participants).toHaveLength(5);
    }
  });

  it("accepts automatic turn taking and an explicit completion reason", () => {
    const result = CreateOrchestrationSchema.safeParse({
      name: "Automatic conversation",
      originalPrompt: "Decide who should speak next.",
      participants: [participant("planner", 0, "Planner")],
      mode: "supervisor",
      maxSteps: 4,
      perAgentTimeoutMs: 1_000,
    });

    expect(result.success).toBe(true);
    expect(OrchestrationEventSchema.safeParse({
      id: "44444444-4444-4444-8444-444444444444",
      sessionId: "55555555-5555-4555-8555-555555555555",
      sequence: 1,
      type: "supervisor_decision",
      status: "running",
      completionReason: "supervisor_completed",
      safeSummary: "Conversation completed",
      createdAt: "2026-08-28T00:00:00.000Z",
    }).success).toBe(true);
  });

  it("rejects unknown automatic completion and decision values", () => {
    const invalidMode = CreateOrchestrationSchema.safeParse({
      name: "Automatic conversation",
      originalPrompt: "Decide who should speak next.",
      participants: [participant("planner", 0, "Planner")],
      mode: "model-decides",
      maxSteps: 4,
      perAgentTimeoutMs: 1_000,
    });
    expect(invalidMode.success).toBe(false);

    const invalidReason = OrchestrationEventSchema.safeParse({
      id: "44444444-4444-4444-8444-444444444444",
      sessionId: "55555555-5555-4555-8555-555555555555",
      sequence: 1,
      type: "supervisor_decision",
      status: "running",
      completionReason: "finished_somehow",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect(invalidReason.success).toBe(false);
  });

  it("rejects empty rosters and duplicate occurrence IDs or positions", () => {
    const empty = CreateOrchestrationSchema.safeParse({
      name: "Pipeline",
      originalPrompt: "Do the work",
      participants: [],
      maxSteps: 1,
      perAgentTimeoutMs: 1_000,
    });
    expect(empty.success).toBe(false);

    const duplicate = CreateOrchestrationSchema.safeParse({
      name: "Pipeline",
      originalPrompt: "Do the work",
      participants: [
        participant("same", 0, "First"),
        participant("same", 0, "Second"),
      ],
      maxSteps: 2,
      perAgentTimeoutMs: 1_000,
    });
    expect(duplicate.success).toBe(false);
  });

  it("enforces bounded guardrails and UUID route parameters", () => {
    const invalidGuardrails = CreateOrchestrationSchema.safeParse({
      name: "Pipeline",
      originalPrompt: "Do the work",
      participants: [participant("one", 0, "Worker")],
      maxSteps: 0,
      perAgentTimeoutMs: 999,
    });
    expect(invalidGuardrails.success).toBe(false);

    expect(
      OrchestrationRouteParamsSchema.safeParse({ id: "not-an-id" }).success,
    ).toBe(false);
    expect(
      OrchestrationRouteParamsSchema.safeParse({
        id: "33333333-3333-4333-8333-333333333333",
      }).success,
    ).toBe(true);
  });

  it("keeps handoffs and event summaries bounded as data", () => {
    const handoff = HandoffEnvelopeSchema.safeParse({
      sourceParticipantId: "builder",
      sourceAgentId: agentId,
      sourceRunId: runId,
      content: "A bounded result",
      truncated: false,
    });
    expect(handoff.success).toBe(true);

    const event = OrchestrationEventSchema.safeParse({
      id: "44444444-4444-4444-8444-444444444444",
      sessionId: "55555555-5555-4555-8555-555555555555",
      sequence: 1,
      type: "participant_dispatched",
      participantId: "builder",
      agentId,
      runId,
      status: "running",
      safeSummary: "Builder started",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect(event.success).toBe(true);
  });

  it("accepts cumulative turns from multiple continuation cycles", () => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const firstRunId = "77777777-7777-4777-8777-777777777777";
    const secondRunId = "88888888-8888-4888-8888-888888888888";
    const firstTurnId = "99999999-9999-4999-8999-999999999999";
    const secondTurnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const continuationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const agent = participant("worker", 0, "Worker");
    const timestamp = "2026-08-28T00:00:00.000Z";

    const result = OrchestrationSessionDetailSchema.safeParse({
      session: {
        id: sessionId,
        name: "Continued Team conversation",
        originalPrompt: "Complete the first cycle.",
        participants: [agent],
        mode: "sequential",
        completionReason: "roster_exhausted",
        status: "completed",
        currentParticipantId: null,
        currentRunId: null,
        stepIndex: 2,
        // Two persisted turns exceed this per-cycle budget, but are valid
        // because the detail schema uses the cumulative session bound.
        maxSteps: 1,
        perAgentTimeoutMs: 1_000,
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
      },
      turns: [
        {
          id: firstTurnId,
          sessionId,
          participantId: agent.id,
          agentId,
          runId: firstRunId,
          position: 0,
          stepIndex: 0,
          status: "completed",
          safeInputSummary: "Complete the first cycle.",
          safeOutput: "First cycle completed.",
          outputTruncated: false,
          errorCode: null,
          createdAt: timestamp,
          completedAt: timestamp,
        },
        {
          id: secondTurnId,
          sessionId,
          participantId: agent.id,
          agentId,
          runId: secondRunId,
          position: 0,
          stepIndex: 1,
          status: "completed",
          safeInputSummary: "Continue with the next cycle.",
          safeOutput: "Second cycle completed.",
          outputTruncated: false,
          errorCode: null,
          createdAt: timestamp,
          completedAt: timestamp,
        },
      ],
      events: [],
      continuationPrompts: [
        {
          id: continuationId,
          sessionId,
          cycleIndex: 1,
          prompt: "Continue with the next cycle.",
          createdAt: timestamp,
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});
