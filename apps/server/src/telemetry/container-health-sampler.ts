export interface ContainerHealthSample {
  at: string;
  cpuPct: number;
  memBytes: number;
  memLimitBytes: number | null;
  pids: number | null;
}

export interface ContainerHealthSamplerOptions {
  execEngine: (args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
  /** Sampling cadence; clamped to [1000, 30000]. Defaults to 4000. */
  intervalMs?: number;
  /** Ring buffer size per Agent. Defaults to 20. */
  ringSize?: number;
  now?: () => Date;
  setTimer?: (callback: () => void, intervalMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface RunKey {
  agentId: string;
  runId: string;
}

interface SamplerEntry {
  agentId: string;
  runId: string;
  containerName: string;
  timer: unknown;
  inFlight: boolean;
}

const DEFAULT_INTERVAL_MS = 4_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 30_000;
const DEFAULT_RING_SIZE = 20;
const STATS_TIMEOUT_MS = 3_000;

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_024 ** 2,
  gib: 1_024 ** 3,
  tib: 1_024 ** 4,
};

function parseBytes(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^([0-9]*\.?[0-9]+)\s*([a-zA-Z]+)?$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = BYTE_UNITS[unit];
  if (multiplier === undefined) return null;
  return Math.round(value * multiplier);
}

function parseMemUsage(
  memUsage: unknown,
): { memBytes: number; memLimitBytes: number | null } | null {
  if (typeof memUsage !== "string") return null;
  const parts = memUsage.split("/");
  const usedRaw = parts[0]?.trim();
  if (!usedRaw) return null;
  const memBytes = parseBytes(usedRaw);
  if (memBytes === null) return null;
  const limitRaw = parts[1]?.trim();
  const memLimitBytes = limitRaw ? parseBytes(limitRaw) : null;
  return { memBytes, memLimitBytes: memLimitBytes ?? null };
}

function parsePercent(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = /^([0-9]*\.?[0-9]+)%?$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parsePids(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Normalises one `docker/podman stats --format {{json .}}` line. Docker uses
 * `CPUPerc`/`MemUsage`/`PIDs`; Podman uses `CPU`/`MemUsage`/`PIDs` (or a
 * numeric `PIDS`). Returns null when the shape cannot be parsed at all.
 */
export function parseContainerStats(
  stdout: string,
): Omit<ContainerHealthSample, "at"> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // `stats` can print one JSON object per line; the last line is the latest.
  const line = trimmed.split("\n").at(-1)?.trim();
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const cpuRaw = record.CPUPerc ?? record.CPU;
  const cpuPct = parsePercent(cpuRaw);
  if (cpuPct === null) return null;
  const mem = parseMemUsage(record.MemUsage);
  if (mem === null) return null;
  const pids = parsePids(record.PIDs ?? record.PIDS ?? record.Pids);
  return {
    cpuPct,
    memBytes: mem.memBytes,
    memLimitBytes: mem.memLimitBytes,
    pids,
  };
}

export class ContainerHealthSampler {
  private readonly execEngine: (
    args: string[],
    timeoutMs: number,
  ) => Promise<{ stdout: string }>;
  private readonly intervalMs: number;
  private readonly ringSize: number;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, intervalMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly entries = new Map<string, SamplerEntry>();
  private readonly rings = new Map<string, ContainerHealthSample[]>();
  private readonly peaks = new Map<
    string,
    { peakCpuPct: number; peakMemBytes: number }
  >();

  constructor(options: ContainerHealthSamplerOptions) {
    this.execEngine = options.execEngine;
    this.intervalMs = Math.min(
      MAX_INTERVAL_MS,
      Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS),
    );
    this.ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
    this.now = options.now ?? (() => new Date());
    this.setTimer =
      options.setTimer ??
      ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle as any));
  }

  start(containerName: string, key: RunKey): void {
    const existing = this.entries.get(key.agentId);
    if (existing) {
      this.clearTimer(existing.timer);
      this.entries.delete(key.agentId);
      // A new run for this Agent supersedes the previous run's peak.
      if (existing.runId !== key.runId) this.peaks.delete(existing.runId);
    }
    const entry: SamplerEntry = {
      agentId: key.agentId,
      runId: key.runId,
      containerName,
      timer: undefined,
      inFlight: false,
    };
    entry.timer = this.setTimer(() => {
      void this.sampleOnce(entry);
    }, this.intervalMs);
    this.entries.set(key.agentId, entry);
  }

  stop(runId: string): void {
    for (const [agentId, entry] of this.entries) {
      if (entry.runId === runId) {
        this.clearTimer(entry.timer);
        this.entries.delete(agentId);
        break;
      }
    }
  }

  latest(agentId: string): ContainerHealthSample | null {
    const ring = this.rings.get(agentId);
    return ring && ring.length > 0 ? ring[ring.length - 1]! : null;
  }

  history(agentId: string): ContainerHealthSample[] {
    return [...(this.rings.get(agentId) ?? [])];
  }

  peak(runId: string): { peakCpuPct: number; peakMemBytes: number } | null {
    return this.peaks.get(runId) ?? null;
  }

  private async sampleOnce(entry: SamplerEntry): Promise<void> {
    if (entry.inFlight) return;
    entry.inFlight = true;
    try {
      const result = await this.execEngine(
        ["stats", "--no-stream", "--format", "{{json .}}", entry.containerName],
        STATS_TIMEOUT_MS,
      );
      const parsed = parseContainerStats(result.stdout);
      if (!parsed) return;
      const sample: ContainerHealthSample = { at: this.now().toISOString(), ...parsed };
      const ring = this.rings.get(entry.agentId) ?? [];
      ring.push(sample);
      while (ring.length > this.ringSize) ring.shift();
      this.rings.set(entry.agentId, ring);
      const previousPeak = this.peaks.get(entry.runId);
      this.peaks.set(entry.runId, {
        peakCpuPct: Math.max(previousPeak?.peakCpuPct ?? 0, sample.cpuPct),
        peakMemBytes: Math.max(previousPeak?.peakMemBytes ?? 0, sample.memBytes),
      });
    } catch (error) {
      console.warn("container health sample failed", error);
    } finally {
      entry.inFlight = false;
    }
  }
}
