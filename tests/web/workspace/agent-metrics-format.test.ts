import { describe, expect, it } from "vitest";
import type { AgentMetrics } from "../../../apps/web/src/types";
import {
  formatBytes,
  formatElapsed,
  formatMemory,
  formatPct,
  formatTokensPerSecond,
  metricsRows,
} from "../../../apps/web/src/workspace/agent-metrics-format";

const NOW = "2026-08-30T10:00:00.000Z";

function baseMetrics(overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    agentId: "a1",
    lifecycle: "busy",
    currentRun: { id: "run-1", elapsedMs: 65_000, model: "gpt" },
    tokens: {
      lastRun: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 },
      session: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200 },
      tokensPerSecondLastRun: 12.34,
      tokensPerSecondAvg: null,
    },
    tools: { calls: 3, denied: 1, sandboxCommands: 2, filesChanged: 4 },
    container: {
      cpuPct: 12.5,
      memBytes: 125_829_120,
      memLimitBytes: 2_147_483_648,
      pids: 7,
      sampledAt: NOW,
      oomKilled: false,
      uptimeMs: 60_000,
    },
    lastError: null,
    model: "gpt-5",
    fallbackUsed: false,
    ...overrides,
  };
}

describe("agent-metrics-format", () => {
  it("formats elapsed time as minutes and seconds", () => {
    expect(formatElapsed(65_000)).toBe("1m 05s");
  });

  it("formats tokens per second, or an em-dash when unknown", () => {
    expect(formatTokensPerSecond(12.34)).toBe("12.3 tok/s");
    expect(formatTokensPerSecond(null)).toBe("—");
  });

  it("formats bytes with a scaled unit", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(125_829_120)).toBe("120 MB");
  });

  it("formats memory with and without a limit", () => {
    expect(formatMemory(125_829_120, 2_147_483_648)).toBe("120 MB / 2.0 GB");
    expect(formatMemory(125_829_120, null)).toBe("120 MB");
  });

  it("formats a percentage", () => {
    expect(formatPct(9.5)).toBe("9.5%");
    expect(formatPct(87)).toBe("87%");
  });

  it("returns no rows for a null snapshot", () => {
    expect(metricsRows(null)).toEqual([]);
  });

  it("suffixes the model row with (fallback) when a fallback model is in use", () => {
    const rows = metricsRows(baseMetrics({ fallbackUsed: true }));
    const modelRow = rows.find((row) => row.label === "Model");
    expect(modelRow?.value).toBe("gpt-5 (fallback)");
  });

  it("omits the container rows when container is null", () => {
    const rows = metricsRows(baseMetrics({ container: null }));
    expect(rows.some((row) => row.label === "CPU")).toBe(false);
    expect(rows.some((row) => row.label === "Mem")).toBe(false);
    expect(rows.some((row) => row.label === "PIDs")).toBe(false);
  });

  it("includes the container rows when container is present", () => {
    const rows = metricsRows(baseMetrics());
    expect(rows.some((row) => row.label === "CPU")).toBe(true);
    expect(rows.some((row) => row.label === "Mem")).toBe(true);
    expect(rows.some((row) => row.label === "PIDs")).toBe(true);
  });

  it("omits the last error row when there is none, and shows it when present", () => {
    expect(metricsRows(baseMetrics()).some((row) => row.label === "Last error")).toBe(false);
    const rows = metricsRows(baseMetrics({ lastError: "boom" }));
    const errorRow = rows.find((row) => row.label === "Last error");
    expect(errorRow?.value).toBe("boom");
  });

  it("shows an em-dash for elapsed when there is no current run", () => {
    const rows = metricsRows(baseMetrics({ currentRun: null }));
    const elapsedRow = rows.find((row) => row.label === "Elapsed");
    expect(elapsedRow?.value).toBe("—");
  });
});
