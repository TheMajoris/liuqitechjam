import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import {
  DEFAULT_SUPERVISOR_MAX_ERROR_BODY_BYTES,
  ArkResponsesSupervisorProvider,
  SupervisorError,
  SupervisorSelector,
  buildSupervisorPrompt,
  createOrchestrationParticipantSelector,
  parseSupervisorRoutingDecision,
  parseSupervisorRoutingText,
  sanitizeSupervisorSelectionContext,
  type SupervisorProvider,
  type SupervisorSelectionContext,
} from "./index.js";
import type { OrchestrationParticipant } from "../types.js";

const agentIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

const participants: OrchestrationParticipant[] = [
  { id: "planner", agentId: agentIds[0]!, role: "Planner", position: 0 },
  { id: "reviewer", agentId: agentIds[0]!, role: "Reviewer", position: 1 },
  { id: "builder", agentId: agentIds[1]!, role: "Builder", position: 2 },
];

const context: SupervisorSelectionContext = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  originalPrompt: "Improve the launch checklist.",
  participants,
  stepIndex: 1,
  maxSteps: 10,
  previousHandoff: {
    sourceParticipantId: "planner",
    sourceAgentId: agentIds[0]!,
    sourceRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    content: "Plan ready.",
    truncated: false,
  },
};

describe("supervisor routing core", () => {
  it("accepts only strict invoke/complete JSON decisions", () => {
    expect(parseSupervisorRoutingDecision({
      kind: "invoke",
      participantId: "reviewer",
    })).toEqual({ kind: "invoke", participantId: "reviewer" });
    expect(parseSupervisorRoutingText('{"kind":"complete"}')).toEqual({
      kind: "complete",
    });
    expect(() => parseSupervisorRoutingText("```json\n{\"kind\":\"complete\"}\n```"))
      .toThrow(SupervisorError);
    expect(() => parseSupervisorRoutingDecision({
      kind: "invoke",
      participantId: "reviewer",
      agentId: agentIds[1],
    })).toThrow(/invalid routing decision/i);
  });

  it("bounds and redacts task/handoff context while preserving occurrence IDs", () => {
    const prompt = buildSupervisorPrompt({
      ...context,
      originalPrompt: "API_KEY=super-secret /Users/darren/private-workspace",
      previousHandoff: {
        ...context.previousHandoff!,
        content: "token=another-secret /Users/darren/workspaces/agent",
      },
    });

    expect(prompt.length).toBeLessThanOrEqual(20_000);
    expect(prompt).toContain('occurrence_id="planner"');
    expect(prompt).not.toContain("super-secret");
    expect(prompt).not.toContain("another-secret");
    expect(prompt).not.toContain("/Users/darren");
    expect(prompt).toContain("untrusted");
  });

  it("includes bounded agent profiles and recent turns as untrusted data", async () => {
    const captured: SupervisorSelectionContext[] = [];
    const provider: SupervisorProvider = {
      decide: async (safeContext) => {
        captured.push(safeContext);
        return {
          kind: "invoke",
          participantId: "reviewer",
          reason: "The review occurrence is next.",
        };
      },
    };
    const enriched: SupervisorSelectionContext = {
      ...context,
      participantProfiles: participants.map((participant, index) => ({
        ...participant,
        name: `Agent ${index}`,
        description: "description secret=remove /Users/darren/private",
      })),
      recentTurns: Array.from({ length: 20 }, (_, index) => ({
        participantId: participants[index % participants.length]!.id,
        agentId: participants[index % participants.length]!.agentId,
        position: index % participants.length,
        stepIndex: index,
        output: `token=secret-${index} /Users/darren/private output ${index}`,
        outputTruncated: false,
      })),
    };
    const selection = await new SupervisorSelector(provider).selectNextParticipant(enriched);
    expect(selection).toMatchObject({
      kind: "invoke",
      reason: "The review occurrence is next.",
    });
    const safeContext = captured[0]!;
    expect(safeContext.participantProfiles).toHaveLength(participants.length);
    expect(safeContext.participantProfiles?.[0]?.name).toBe("Agent 0");
    expect(JSON.stringify(safeContext)).not.toContain("secret-0");
    expect(JSON.stringify(safeContext)).not.toContain("/Users/darren");
    expect(safeContext.recentTurns?.length).toBeLessThanOrEqual(8);
    expect(safeContext.recentTurns?.at(-1)?.participantId).toBe("reviewer");
    expect(buildSupervisorPrompt(enriched)).toContain("recent_turns");
    expect(sanitizeSupervisorSelectionContext(enriched).recentTurns?.length).toBeLessThanOrEqual(8);
  });

  it("resolves a provider choice to the exact configured occurrence", async () => {
    const provider: SupervisorProvider = {
      decide: async () => ({ kind: "invoke", participantId: "reviewer" }),
    };
    const selector = new SupervisorSelector(provider);
    await expect(selector.selectNextParticipant(context)).resolves.toEqual({
      kind: "invoke",
      participant: participants[1],
      stepIndex: 1,
    });

    const completion = new SupervisorSelector({
      decide: async () => ({ kind: "complete" }),
    });
    await expect(completion.selectNextParticipant({ ...context, stepIndex: 0 }))
      .resolves.toEqual({
        kind: "complete",
        completionReason: "supervisor_completed",
        stepIndex: 0,
      });
  });

  it("rejects an unconfigured occurrence and maps it to the orchestration error", async () => {
    const selector = new SupervisorSelector({
      decide: async () => ({ kind: "invoke", participantId: "unconfigured" }),
    });

    await expect(selector.selectNextParticipant(context)).rejects.toMatchObject({
      code: "SUPERVISOR_INVALID_ROUTE",
      orchestrationErrorCode: "SUPERVISOR_INVALID_SELECTION",
    });
  });

  it("adapts the supervisor result to the existing orchestration selector contract", async () => {
    const selector = createOrchestrationParticipantSelector({
      decide: async () => ({ kind: "invoke", participantId: "builder" }),
    });
    const result = await selector({
      ...context,
      mode: "supervisor",
      turns: [],
      lastRunId: null,
      lastOutput: null,
      status: "running",
    });
    expect(result).toEqual({
      kind: "invoke",
      participant: participants[2],
      stepIndex: 1,
    });
  });
});

describe("Ark Responses supervisor provider", () => {
  it("sends one JSON-only Responses request and parses message output_text", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    let calls = 0;
    const provider = new ArkResponsesSupervisorProvider({
      apiKey: "test-api-key",
      baseUrl: "https://ark.example/api/v3/",
      model: "ep-supervisor",
      timeoutMs: 1_000,
      fetchImpl: async (url, init) => {
        calls += 1;
        requestUrl = String(url);
        requestInit = init;
        return new Response(JSON.stringify({
          output: [
            {
              type: "message",
              content: [{
                type: "output_text",
                text: '{"kind":"invoke","participantId":"reviewer"}',
              }],
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await expect(provider.decide(context)).resolves.toEqual({
      kind: "invoke",
      participantId: "reviewer",
    });
    expect(calls).toBe(1);
    expect(requestUrl).toBe("https://ark.example/api/v3/responses");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    expect(body.model).toBe("ep-supervisor");
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(String(body.input)).toContain("configured_participants");
  });

  it("does not retry and bounds an oversized error response", async () => {
    let calls = 0;
    const provider = new ArkResponsesSupervisorProvider({
      apiKey: "test-api-key",
      baseUrl: "https://ark.example/api/v3",
      model: "ep-supervisor",
      fetchImpl: async () => {
        calls += 1;
        return new Response("secret=" + "x".repeat(DEFAULT_SUPERVISOR_MAX_ERROR_BODY_BYTES * 4), {
          status: 502,
        });
      },
    });

    await expect(provider.decide(context)).rejects.toMatchObject({
      code: "SUPERVISOR_REQUEST_FAILED",
      orchestrationErrorCode: "SUPERVISOR_FAILED",
    });
    expect(calls).toBe(1);
  });

  it("preserves external AbortError and classifies its own timeout", async () => {
    const pending = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) {
          rejectAbort();
          return;
        }
        signal?.addEventListener("abort", rejectAbort, { once: true });
      });

    const timeoutProvider = new ArkResponsesSupervisorProvider({
      apiKey: "test-api-key",
      baseUrl: "https://ark.example/api/v3",
      model: "ep-supervisor",
      timeoutMs: 1_000,
      fetchImpl: pending,
    });
    await expect(timeoutProvider.decide(context, { timeoutMs: 5 })).rejects.toMatchObject({
      code: "SUPERVISOR_TIMED_OUT",
      orchestrationErrorCode: "SUPERVISOR_TIMED_OUT",
    });

    const controller = new AbortController();
    const abortProvider = new ArkResponsesSupervisorProvider({
      apiKey: "test-api-key",
      baseUrl: "https://ark.example/api/v3",
      model: "ep-supervisor",
      timeoutMs: 1_000,
      fetchImpl: pending,
    });
    const request = abortProvider.decide(context, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("supervisor configuration", () => {
  it("resolves SUPERVISOR_MODEL from its override or ARK_MODEL and keeps a separate timeout", () => {
    const fallback = loadConfig({
      NODE_ENV: "test",
      ARK_MODEL: "ep-agent",
      SUPERVISOR_TIMEOUT_MS: "4321",
    });
    expect(fallback.supervisorModel).toBe("ep-agent");
    expect(fallback.supervisorTimeoutMs).toBe(4_321);

    const override = loadConfig({
      NODE_ENV: "test",
      ARK_MODEL: "ep-agent",
      SUPERVISOR_MODEL: "ep-supervisor",
    });
    expect(override.supervisorModel).toBe("ep-supervisor");
    expect(override.supervisorTimeoutMs).toBe(120_000);
  });
});
