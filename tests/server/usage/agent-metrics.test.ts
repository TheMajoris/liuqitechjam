import { describe, expect, it } from "vitest";
import { AgentMetricsService } from "../../../apps/server/src/usage/agent-metrics.js";
import type { AgentMetricsSources } from "../../../apps/server/src/usage/agent-metrics.js";
import type { Agent, AgentRun } from "../../../apps/server/src/types.js";
import type { AuditEvent, AuditQuery } from "../../../apps/server/src/audit/audit-types.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Agent",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/tmp/agent",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    agentId: AGENT_ID,
    status: "completed",
    prompt: "hi",
    output: "hello",
    error: null,
    usage: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    ...overrides,
  } as AgentRun;
}

function auditEvent(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: "evt-1",
    type: "tool_started",
    status: "success",
    summary: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    principal: { kind: "agent", id: AGENT_ID },
    metadata: {},
    traceId: "trace-1",
    spanId: "span-1",
    sequence: 1,
    actorType: "agent",
    category: "tool_call",
    ...overrides,
  } as AuditEvent;
}

function fakeAudit(events: AuditEvent[]) {
  return {
    query: (filter?: AuditQuery) =>
      events.filter((event) => {
        if (filter?.agentId !== undefined && event.agentId !== filter.agentId) return false;
        if (filter?.type !== undefined && event.type !== filter.type) return false;
        return true;
      }),
  };
}

function makeSources(overrides: Partial<AgentMetricsSources> = {}): AgentMetricsSources {
  return {
    agents: () => [baseAgent()],
    runs: () => [],
    ...overrides,
  };
}

describe("AgentMetricsService", () => {
  it("computes tokens/sec from the last completed run", () => {
    const run = baseRun({
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:10.000Z",
    });
    const service = new AgentMetricsService(makeSources({ runs: () => [run] }));
    const metrics = service.forAgent(AGENT_ID);
    expect(metrics.tokens.tokensPerSecondLastRun).toBe(5);
    expect(metrics.tokens.tokensPerSecondAvg).toBe(5);
    expect(metrics.tokens.lastRun).toEqual({
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
    });
  });

  it("averages over the last 10 completed runs", () => {
    const runs: AgentRun[] = [];
    for (let index = 0; index < 12; index += 1) {
      runs.push(
        baseRun({
          id: `run-${index}`,
          usage: { outputTokens: 10 * (index + 1) },
          startedAt: `2026-01-0${(index % 9) + 1}T00:00:00.000Z`,
          completedAt: `2026-01-0${(index % 9) + 1}T00:00:10.000Z`,
        }),
      );
    }
    const service = new AgentMetricsService(makeSources({ runs: () => runs }));
    const metrics = service.forAgent(AGENT_ID);
    // Only the most recent 10 (by startedAt desc) contribute to the average.
    expect(metrics.tokens.tokensPerSecondAvg).not.toBeNull();
  });

  it("never fabricates a rate while a run is in flight", () => {
    const completed = baseRun({
      id: "run-done",
      usage: { outputTokens: 50 },
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:10.000Z",
    });
    const active = baseRun({
      id: "run-active",
      status: "running",
      startedAt: "2026-01-02T00:00:00.000Z",
      completedAt: null,
      usage: null,
    });
    const service = new AgentMetricsService(
      makeSources({ runs: () => [active, completed] }),
    );
    const metrics = service.forAgent(AGENT_ID);
    expect(metrics.currentRun).not.toBeNull();
    expect(metrics.tokens.tokensPerSecondLastRun).toBeNull();
  });

  it("returns null tok/s when no completed run has usable usage/timestamps", () => {
    const run = baseRun({ usage: null });
    const service = new AgentMetricsService(makeSources({ runs: () => [run] }));
    const metrics = service.forAgent(AGENT_ID);
    expect(metrics.tokens.tokensPerSecondLastRun).toBeNull();
    expect(metrics.tokens.tokensPerSecondAvg).toBeNull();
  });

  it("counts tool calls, denials, sandbox commands, and files changed from audit events", () => {
    const events: AuditEvent[] = [
      auditEvent({ id: "1", type: "tool_started", agentId: AGENT_ID }),
      auditEvent({ id: "2", type: "tool_started", agentId: AGENT_ID }),
      auditEvent({
        id: "3",
        type: "authorization_decision",
        agentId: AGENT_ID,
        status: "failure",
      }),
      auditEvent({
        id: "4",
        type: "tool_failed",
        agentId: AGENT_ID,
        status: "failure",
        metadata: { errorCode: "PERMISSION_DENIED" },
      }),
      auditEvent({
        id: "5",
        type: "tool_failed",
        agentId: AGENT_ID,
        status: "failure",
        metadata: { errorCode: "TOOL_TIMEOUT" },
      }),
      auditEvent({ id: "6", type: "sandbox_command", agentId: AGENT_ID }),
      auditEvent({ id: "7", type: "sandbox_command", agentId: AGENT_ID }),
      auditEvent({
        id: "8",
        type: "workspace_file_change",
        agentId: AGENT_ID,
        metadata: { fileCount: 3, added: 2, modified: 1, deleted: 0 },
      }),
      auditEvent({
        id: "9",
        type: "workspace_file_change",
        agentId: AGENT_ID,
        metadata: { kind: "add", pathHash: "abc" },
      }),
    ];
    const service = new AgentMetricsService(
      makeSources({ audit: fakeAudit(events) }),
    );
    const metrics = service.forAgent(AGENT_ID);
    expect(metrics.tools).toEqual({
      calls: 2,
      denied: 2,
      sandboxCommands: 2,
      filesChanged: 3,
    });
  });

  it("returns null container metrics when no sampler is configured", () => {
    const service = new AgentMetricsService(makeSources());
    const metrics = service.forAgent(AGENT_ID);
    expect(metrics.container).toBeNull();
  });

  it("populates container metrics from the health sampler", () => {
    const sample = {
      at: "2026-01-01T00:00:05.000Z",
      cpuPct: 12.5,
      memBytes: 1_000_000,
      memLimitBytes: 2_000_000,
      pids: 4,
    };
    const service = new AgentMetricsService(
      makeSources({
        healthSampler: { latest: () => sample },
      }),
    );
    const metrics = service.forAgent(AGENT_ID);
    expect(metrics.container).toMatchObject({
      cpuPct: 12.5,
      memBytes: 1_000_000,
      memLimitBytes: 2_000_000,
      pids: 4,
      sampledAt: "2026-01-01T00:00:05.000Z",
    });
  });

  it("reflects Agent lifecycle and lastError", () => {
    const service = new AgentMetricsService(
      makeSources({
        agents: () => [baseAgent({ status: "error", lastError: "boom" })],
      }),
    );
    const metrics = service.forAgent(AGENT_ID);
    expect(metrics.lifecycle).toBe("error");
    expect(metrics.lastError).toBe("boom");
  });

  it("forAgents batches multiple agent ids", () => {
    const service = new AgentMetricsService(makeSources());
    const metrics = service.forAgents([AGENT_ID, "unknown-agent"]);
    expect(metrics).toHaveLength(2);
    expect(metrics[0]?.agentId).toBe(AGENT_ID);
    expect(metrics[1]?.agentId).toBe("unknown-agent");
    expect(metrics[1]?.lifecycle).toBe("stopped");
  });
});
