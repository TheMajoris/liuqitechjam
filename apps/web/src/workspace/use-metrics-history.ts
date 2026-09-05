import { useEffect, useRef, useState } from "react";
import type { AgentMetrics } from "../types";

export interface MetricsHistoryState {
  cpu: number[];
  mem: number[];
  /** Last sample's `container.sampledAt`, so a repeat poll is a no-op. */
  lastSampledAt: string | null;
}

const EMPTY_STATE: MetricsHistoryState = { cpu: [], mem: [], lastSampledAt: null };

/**
 * Appends one CPU/mem sample to a ring, capped at `size`.
 *
 * Pure so the dedupe/cap rules are testable without React: a metrics
 * snapshot with no container (a local, non-container runner) or the same
 * `sampledAt` as last time leaves the history untouched.
 */
export function appendSample(
  state: MetricsHistoryState,
  metrics: AgentMetrics | null,
  size: number,
): MetricsHistoryState {
  const container = metrics?.container ?? null;
  if (!container) return state;
  if (container.sampledAt === state.lastSampledAt) return state;
  return {
    cpu: [...state.cpu, container.cpuPct].slice(-size),
    mem: [...state.mem, container.memBytes].slice(-size),
    lastSampledAt: container.sampledAt,
  };
}

/**
 * A small client-side ring of an Agent's last `size` container samples.
 *
 * The server only reports the latest sample per poll, so the sparkline
 * history lives here rather than on the wire. The ring resets whenever the
 * inspector switches to a different Agent, so one Agent's memory trace never
 * bleeds into another's.
 */
export function useMetricsHistory(
  agentId: string | null,
  metrics: AgentMetrics | null,
  size = 20,
): { cpu: number[]; mem: number[] } {
  const [state, setState] = useState<MetricsHistoryState>(EMPTY_STATE);
  const lastAgentId = useRef(agentId);

  useEffect(() => {
    if (lastAgentId.current !== agentId) {
      lastAgentId.current = agentId;
      setState(EMPTY_STATE);
    }
  }, [agentId]);

  useEffect(() => {
    setState((prev) => appendSample(prev, metrics, size));
  }, [metrics, size]);

  return { cpu: state.cpu, mem: state.mem };
}
