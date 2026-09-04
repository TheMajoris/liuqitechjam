import { useEffect, useState } from "react";
import { api } from "../api";
import type { AgentMetrics } from "../types";

/** Fast enough to feel live in the hover card; slow enough to stay cheap. */
const POLL_MS = 3000;

/**
 * Per-Agent runtime telemetry for the workspace.
 *
 * Read-only and best-effort, same contract as `useWorkspaceActivity`: a
 * failed poll leaves the last good map in place rather than throwing, since
 * a metrics snapshot is evidence about the runtime, never a control input.
 * Polling only runs while `active` (something busy, or a viewer actually
 * looking at an Agent); otherwise the room fetches once and stays idle.
 */
export function useAgentMetrics({
  projectId,
  agentIds,
  active,
}: {
  projectId: string | null;
  agentIds: string[];
  active: boolean;
}): Map<string, AgentMetrics> {
  const [metrics, setMetrics] = useState<Map<string, AgentMetrics>>(new Map());
  const idsKey = agentIds.join(",");
  const hasAgents = agentIds.length > 0;

  useEffect(() => {
    if (!projectId || !hasAgents) {
      setMetrics(new Map());
      return;
    }
    let cancelled = false;
    const load = () => {
      void api
        .projectAgentMetrics(projectId)
        .then((result) => {
          if (cancelled) return;
          setMetrics(new Map(result.agents.map((entry) => [entry.agentId, entry])));
        })
        .catch(() => undefined);
    };
    load();
    if (!active) return () => {
      cancelled = true;
    };
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, idsKey, hasAgents, active]);

  return metrics;
}
