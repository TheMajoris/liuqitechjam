import { describe, expect, it } from "vitest";
import type { AgentMetrics } from "../../../apps/web/src/types";
import {
  appendSample,
  type MetricsHistoryState,
} from "../../../apps/web/src/workspace/use-metrics-history";

const EMPTY: MetricsHistoryState = { cpu: [], mem: [], lastSampledAt: null };

function metricsWithContainer(
  sampledAt: string,
  cpuPct: number,
  memBytes: number,
): AgentMetrics {
  return {
    agentId: "a1",
    lifecycle: "busy",
    currentRun: null,
    tokens: {
      lastRun: null,
      session: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      tokensPerSecondLastRun: null,
      tokensPerSecondAvg: null,
    },
    tools: { calls: 0, denied: 0, sandboxCommands: 0, filesChanged: 0 },
    container: {
      cpuPct,
      memBytes,
      memLimitBytes: null,
      pids: null,
      sampledAt,
      oomKilled: null,
      uptimeMs: null,
    },
    lastError: null,
    model: null,
    fallbackUsed: false,
  };
}

function metricsWithoutContainer(): AgentMetrics {
  return { ...metricsWithContainer("2026-09-05T00:00:00.000Z", 0, 0), container: null };
}

describe("appendSample", () => {
  it("appends a new sample", () => {
    const next = appendSample(EMPTY, metricsWithContainer("t1", 10, 100), 20);
    expect(next.cpu).toEqual([10]);
    expect(next.mem).toEqual([100]);
    expect(next.lastSampledAt).toBe("t1");
  });

  it("dedupes a repeated sampledAt", () => {
    const first = appendSample(EMPTY, metricsWithContainer("t1", 10, 100), 20);
    const second = appendSample(first, metricsWithContainer("t1", 999, 999), 20);
    expect(second).toBe(first);
    expect(second.cpu).toEqual([10]);
  });

  it("caps the ring at size", () => {
    let state = EMPTY;
    for (let index = 0; index < 25; index += 1) {
      state = appendSample(state, metricsWithContainer("t" + index, index, index * 10), 20);
    }
    expect(state.cpu).toHaveLength(20);
    expect(state.mem).toHaveLength(20);
    // The oldest five samples (0-4) fell off the ring.
    expect(state.cpu[0]).toBe(5);
    expect(state.cpu.at(-1)).toBe(24);
  });

  it("leaves history unchanged when container is null", () => {
    const seeded = appendSample(EMPTY, metricsWithContainer("t1", 10, 100), 20);
    const next = appendSample(seeded, metricsWithoutContainer(), 20);
    expect(next).toBe(seeded);
  });

  it("leaves history unchanged when metrics is null", () => {
    const seeded = appendSample(EMPTY, metricsWithContainer("t1", 10, 100), 20);
    const next = appendSample(seeded, null, 20);
    expect(next).toBe(seeded);
  });
});
