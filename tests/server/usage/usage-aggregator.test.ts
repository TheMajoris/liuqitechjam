import { describe, expect, it } from "vitest";
import {
  buildUsageReport,
  type UsageSource,
} from "../../../apps/server/src/usage/usage-aggregator.js";
import type { AuditEvent } from "../../../apps/server/src/audit/audit-types.js";
import type { Agent, AgentRun, Message } from "../../../apps/server/src/types.js";
import type {
  OrchestrationSession,
  OrchestrationTurn,
} from "../../../apps/server/src/orchestration/types.js";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    modelRef: { providerId: "ark", modelId: "ep-test" },
    workspacePath: "/workspaces/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function run(overrides: Partial<AgentRun> & Pick<AgentRun, "id" | "agentId">): AgentRun {
  return {
    status: "completed",
    prompt: "p",
    output: "o",
    error: null,
    usage: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

function auditEvent(overrides: Partial<AuditEvent> & Pick<AuditEvent, "id" | "type">): AuditEvent {
  return {
    status: "success",
    summary: "s",
    createdAt: "2026-08-30T00:00:00.000Z",
    principal: { kind: "human", id: "user-1" },
    metadata: {},
    ...overrides,
  } as AuditEvent;
}

function source(overrides: Partial<UsageSource> = {}): UsageSource {
  return {
    agents: [],
    runs: [],
    messages: [],
    orchestrations: [],
    orchestrationTurns: [],
    projects: [],
    auditEvents: [],
    ...overrides,
  };
}

describe("buildUsageReport", () => {
  it("sums token counters per Agent and reports run outcomes", () => {
    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE"), agent("a2", "Bob")],
        runs: [
          run({
            id: "r1",
            agentId: "a1",
            usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 50 },
          }),
          run({
            id: "r2",
            agentId: "a1",
            status: "failed",
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          }),
          run({
            id: "r3",
            agentId: "a2",
            usage: { inputTokens: 7, cachedInputTokens: 1, outputTokens: 3 },
          }),
        ],
      }),
      {},
      NOW,
    );

    expect(report.totals.runs).toEqual({
      total: 3,
      completed: 2,
      failed: 1,
      cancelled: 0,
      active: 0,
    });
    expect(report.totals.tokens.inputTokens).toBe(117);
    expect(report.totals.tokens.outputTokens).toBe(58);
    expect(report.totals.tokens.totalTokens).toBe(175);
    expect(report.totals.tokens.availability).toBe("available");

    // Busiest first, so the breakdown reads as a ranking without re-sorting.
    expect(report.agents.map((row) => row.agentId)).toEqual(["a1", "a2"]);
    expect(report.agents[0]?.name).toBe("ALICE");
    expect(report.agents[0]?.tokens.totalTokens).toBe(165);
  });

  it("never fabricates counters when a provider reported no usage", () => {
    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE")],
        runs: [
          run({ id: "r1", agentId: "a1", usage: null }),
          run({
            id: "r2",
            agentId: "a1",
            usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 },
          }),
        ],
      }),
      {},
      NOW,
    );

    expect(report.totals.tokens.availability).toBe("partial");
    expect(report.totals.tokens.runsReporting).toBe(1);
    expect(report.totals.tokens.totalTokens).toBe(14);
  });

  it("reports unavailable rather than zero when nothing reported usage", () => {
    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE")],
        runs: [run({ id: "r1", agentId: "a1", usage: null })],
      }),
      {},
      NOW,
    );

    expect(report.totals.tokens.availability).toBe("unavailable");
    expect(report.totals.tokens.runsReporting).toBe(0);
    expect(report.totals.tokens.totalTokens).toBe(0);
  });

  it("attributes Team runs to the workspace that dispatched them", () => {
    const session: OrchestrationSession = {
      id: "s1",
      name: "take turns to count",
      originalPrompt: "count",
      projectId: "p1",
      participants: [
        { id: "pt1", agentId: "a1", position: 0 },
        { id: "pt2", agentId: "a2", position: 1 },
      ] as OrchestrationSession["participants"],
      status: "completed",
      currentParticipantId: null,
      currentRunId: null,
      stepIndex: 2,
      maxSteps: 8,
      perAgentTimeoutMs: 60_000,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:01:00.000Z",
    };
    const turn = (id: string, runId: string, agentId: string): OrchestrationTurn => ({
      id,
      sessionId: "s1",
      participantId: "pt-" + id,
      agentId,
      runId,
      position: 0,
      status: "completed",
      safeInputSummary: "",
      safeOutput: null,
      outputTruncated: false,
      errorCode: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:00:30.000Z",
    });

    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE"), agent("a2", "Bob")],
        orchestrations: [session],
        orchestrationTurns: [turn("t1", "r1", "a1"), turn("t2", "r2", "a2")],
        projects: [
          { id: "p1", name: "Shared", description: "", workspacePath: "/p1" },
        ] as UsageSource["projects"],
        runs: [
          run({
            id: "r1",
            agentId: "a1",
            usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 10 },
          }),
          run({
            id: "r2",
            agentId: "a2",
            usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 5 },
          }),
          // A direct run outside the Team must not land in the workspace row.
          run({
            id: "r3",
            agentId: "a1",
            usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 1000 },
          }),
        ],
      }),
      {},
      NOW,
    );

    expect(report.workspaces).toHaveLength(1);
    const workspace = report.workspaces[0];
    expect(workspace?.orchestrationId).toBe("s1");
    expect(workspace?.name).toBe("take turns to count");
    expect(workspace?.participants).toBe(2);
    expect(workspace?.runs.total).toBe(2);
    expect(workspace?.tokens.totalTokens).toBe(75);

    // The Team's Project inherits the same two runs, not the direct one.
    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]?.projectId).toBe("p1");
    expect(report.projects[0]?.runs.total).toBe(2);
  });

  it("attributes a Team's tool calls to the Project its runs landed on", () => {
    const session = {
      id: "s1",
      name: "team",
      originalPrompt: "go",
      projectId: "p1",
      participants: [{ id: "pt1", agentId: "a1", position: 0 }],
      status: "completed",
      currentParticipantId: null,
      currentRunId: null,
      stepIndex: 1,
      maxSteps: 8,
      perAgentTimeoutMs: 60_000,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:01:00.000Z",
    } as unknown as OrchestrationSession;

    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE")],
        orchestrations: [session],
        orchestrationTurns: [
          {
            id: "t1",
            sessionId: "s1",
            participantId: "pt1",
            agentId: "a1",
            runId: "r1",
            position: 0,
            status: "completed",
            safeInputSummary: "",
            safeOutput: null,
            outputTruncated: false,
            errorCode: null,
            createdAt: "2026-08-30T00:00:00.000Z",
            completedAt: "2026-08-30T00:00:30.000Z",
          },
        ],
        projects: [
          { id: "p1", name: "Shared", description: "", workspacePath: "/p1" },
        ] as UsageSource["projects"],
        runs: [run({ id: "r1", agentId: "a1" })],
        // The tool event knows its run but was never tagged with a Project.
        auditEvents: [
          auditEvent({ id: "e1", type: "tool_started", agentId: "a1", runId: "r1" }),
        ],
      }),
      {},
      NOW,
    );

    expect(report.workspaces[0]?.activity.toolCalls).toBe(1);
    // The run reached the Project transitively, so its tool call must too.
    expect(report.projects[0]?.activity.toolCalls).toBe(1);
    expect(report.projects[0]?.runs.total).toBe(1);
  });

  it("counts tool calls once and separates failures and approvals", () => {
    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE")],
        auditEvents: [
          auditEvent({ id: "e1", type: "tool_started", agentId: "a1" }),
          auditEvent({ id: "e2", type: "tool_succeeded", agentId: "a1" }),
          auditEvent({ id: "e3", type: "tool_started", agentId: "a1" }),
          auditEvent({
            id: "e4",
            type: "tool_failed",
            status: "failure",
            agentId: "a1",
          }),
          auditEvent({ id: "e5", type: "tool_approval_required", agentId: "a1" }),
          auditEvent({ id: "e6", type: "skill_invoked", agentId: "a1" }),
          auditEvent({
            id: "e7",
            type: "authorization_decision",
            status: "failure",
            agentId: "a1",
          }),
        ],
      }),
      {},
      NOW,
    );

    expect(report.totals.activity).toEqual({
      toolCalls: 2,
      toolFailures: 1,
      approvalsRequired: 1,
      skillInvocations: 1,
      authorizationDenials: 1,
    });
    expect(report.agents[0]?.activity.toolCalls).toBe(2);
  });

  it("derives latency only from runs that recorded both ends", () => {
    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE")],
        runs: [
          run({
            id: "r1",
            agentId: "a1",
            startedAt: "2026-08-30T00:00:00.000Z",
            completedAt: "2026-08-30T00:00:10.000Z",
          }),
          run({
            id: "r2",
            agentId: "a1",
            startedAt: "2026-08-30T00:00:00.000Z",
            completedAt: "2026-08-30T00:00:30.000Z",
          }),
          // Never started, so it must not drag the average toward zero.
          run({ id: "r3", agentId: "a1", status: "queued" }),
        ],
      }),
      {},
      NOW,
    );

    expect(report.totals.latency.samples).toBe(2);
    expect(report.totals.latency.averageMs).toBe(20_000);
    expect(report.totals.latency.maxMs).toBe(30_000);
  });

  it("honours the since window", () => {
    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE")],
        runs: [
          run({ id: "old", agentId: "a1", createdAt: "2026-07-01T00:00:00.000Z" }),
          run({ id: "new", agentId: "a1", createdAt: "2026-08-29T00:00:00.000Z" }),
        ],
      }),
      { since: "2026-08-01T00:00:00.000Z" },
      NOW,
    );

    expect(report.totals.runs.total).toBe(1);
    expect(report.since).toBe("2026-08-01T00:00:00.000Z");
  });

  it("emits a zero-filled daily series ending today", () => {
    const report = buildUsageReport(
      source({
        agents: [agent("a1", "ALICE")],
        runs: [
          run({
            id: "r1",
            agentId: "a1",
            createdAt: "2026-08-29T09:00:00.000Z",
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          }),
        ],
        auditEvents: [
          auditEvent({
            id: "e1",
            type: "tool_started",
            agentId: "a1",
            createdAt: "2026-08-29T09:00:00.000Z",
          }),
        ],
      }),
      { days: 3 },
      NOW,
    );

    expect(report.daily.map((point) => point.date)).toEqual([
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
    ]);
    expect(report.daily[0]?.runs).toBe(0);
    expect(report.daily[1]).toMatchObject({ runs: 1, totalTokens: 15, toolCalls: 1 });
    expect(report.daily[2]?.runs).toBe(0);
  });

  it("keeps runs from a deleted Agent instead of dropping the spend", () => {
    const report = buildUsageReport(
      source({ agents: [], runs: [run({ id: "r1", agentId: "gone" })] }),
      {},
      NOW,
    );

    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]?.agentId).toBe("gone");
    expect(report.agents[0]?.name).toBeNull();
  });
});
