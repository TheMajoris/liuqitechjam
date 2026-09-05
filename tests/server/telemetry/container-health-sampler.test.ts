import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContainerHealthSampler,
  parseContainerStats,
} from "../../../apps/server/src/telemetry/container-health-sampler.js";

describe("parseContainerStats", () => {
  it("parses Docker's stats shape", () => {
    const sample = parseContainerStats(
      '{"CPUPerc":"12.34%","MemUsage":"120MiB / 2GiB","PIDs":"14"}',
    );
    expect(sample).toEqual({
      cpuPct: 12.34,
      memBytes: 120 * 1024 ** 2,
      memLimitBytes: 2 * 1024 ** 3,
      pids: 14,
    });
  });

  it("parses Podman's stats shape with string and numeric PIDs fields", () => {
    const sample = parseContainerStats(
      '{"CPU":"5.00%","MemUsage":"120MB / 2GB","PIDs":"14"}',
    );
    expect(sample).toEqual({
      cpuPct: 5,
      memBytes: 120_000_000,
      memLimitBytes: 2_000_000_000,
      pids: 14,
    });
    const numericPids = parseContainerStats(
      '{"CPU":"5.00%","MemUsage":"120MB / 2GB","PIDS":14}',
    );
    expect(numericPids?.pids).toBe(14);
  });

  it("supports plain byte units without a limit", () => {
    const sample = parseContainerStats(
      '{"CPUPerc":"0.00%","MemUsage":"512B"}',
    );
    expect(sample).toEqual({
      cpuPct: 0,
      memBytes: 512,
      memLimitBytes: null,
      pids: null,
    });
  });

  it("returns null for unparseable input", () => {
    expect(parseContainerStats("")).toBeNull();
    expect(parseContainerStats("not json")).toBeNull();
    expect(parseContainerStats('{"foo":"bar"}')).toBeNull();
    expect(parseContainerStats('{"CPUPerc":"1%","MemUsage":"nonsense"}')).toBeNull();
  });
});

describe("ContainerHealthSampler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeExecEngine(
    responses: () => Promise<{ stdout: string }>,
  ): { execEngine: (args: string[], timeoutMs: number) => Promise<{ stdout: string }>; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      execEngine: async (args: string[]) => {
        calls.push(args);
        return responses();
      },
    };
  }

  it("samples on an interval and updates latest/history", async () => {
    let cpu = 10;
    const { execEngine, calls } = makeExecEngine(async () => {
      cpu += 1;
      return {
        stdout: JSON.stringify({
          CPUPerc: cpu + "%",
          MemUsage: "100MiB / 1GiB",
          PIDs: "3",
        }),
      };
    });
    const sampler = new ContainerHealthSampler({ execEngine, intervalMs: 1000, ringSize: 3 });

    sampler.start("container-a", { agentId: "agent-1", runId: "run-1" });
    expect(calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls[0]).toEqual([
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      "container-a",
    ]);
    expect(sampler.latest("agent-1")?.cpuPct).toBe(11);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sampler.latest("agent-1")?.cpuPct).toBe(13);
    expect(sampler.history("agent-1")).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1000);
    // Ring caps at ringSize, oldest evicted first.
    expect(sampler.history("agent-1")).toHaveLength(3);
    expect(sampler.history("agent-1").map((s) => s.cpuPct)).toEqual([12, 13, 14]);
  });

  it("clamps intervalMs into [1000, 30000]", async () => {
    const { execEngine, calls } = makeExecEngine(async () => ({
      stdout: '{"CPUPerc":"1%","MemUsage":"1MiB / 1GiB"}',
    }));
    const sampler = new ContainerHealthSampler({ execEngine, intervalMs: 10 });
    sampler.start("c", { agentId: "a", runId: "r" });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(1);
  });

  it("tracks the peak cpu/mem for a run", async () => {
    const values = [
      { CPUPerc: "5%", MemUsage: "10MiB / 1GiB" },
      { CPUPerc: "50%", MemUsage: "5MiB / 1GiB" },
      { CPUPerc: "20%", MemUsage: "80MiB / 1GiB" },
    ];
    let i = 0;
    const { execEngine } = makeExecEngine(async () => ({
      stdout: JSON.stringify(values[i++ % values.length]),
    }));
    const sampler = new ContainerHealthSampler({ execEngine, intervalMs: 1000 });
    sampler.start("c", { agentId: "agent-x", runId: "run-x" });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    const peak = sampler.peak("run-x");
    expect(peak?.peakCpuPct).toBe(50);
    expect(peak?.peakMemBytes).toBe(80 * 1024 ** 2);
  });

  it("stops sampling after stop() is called", async () => {
    const { execEngine, calls } = makeExecEngine(async () => ({
      stdout: '{"CPUPerc":"1%","MemUsage":"1MiB / 1GiB"}',
    }));
    const sampler = new ContainerHealthSampler({ execEngine, intervalMs: 1000 });
    sampler.start("c", { agentId: "a", runId: "r1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length).toBe(1);

    sampler.stop("r1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(1);
  });

  it("skips a tick while a sample is already in flight", async () => {
    let resolveFirst!: (value: { stdout: string }) => void;
    let callCount = 0;
    const execEngine = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<{ stdout: string }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { stdout: '{"CPUPerc":"1%","MemUsage":"1MiB / 1GiB"}' };
    };
    const sampler = new ContainerHealthSampler({ execEngine, intervalMs: 1000 });
    sampler.start("c", { agentId: "a", runId: "r" });

    await vi.advanceTimersByTimeAsync(1000);
    // Second tick fires while the first call is still pending; it must be skipped.
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);

    resolveFirst({ stdout: '{"CPUPerc":"9%","MemUsage":"1MiB / 1GiB"}' });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(2);
  });

  it("does not throw when execEngine rejects", async () => {
    const execEngine = async () => {
      throw new Error("engine unavailable");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sampler = new ContainerHealthSampler({ execEngine, intervalMs: 1000 });
    sampler.start("c", { agentId: "a", runId: "r" });

    await vi.advanceTimersByTimeAsync(1000);
    expect(sampler.latest("a")).toBeNull();
    warn.mockRestore();
  });
});
