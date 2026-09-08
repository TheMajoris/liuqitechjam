import { useEffect, useRef, useState } from "react";
import { DEPARTURE_MS, type DepartingAgentModel } from "./departure";
import type { WorldPoint } from "./workspace-layout";
import type { WorkspaceAgentViewModel } from "./workspace-view-model";

interface DeparturesOptions {
  /**
   * Identifies which room this roster belongs to. Changing rooms replaces the
   * whole roster at once, which is not five people quitting.
   */
  scopeId: string | null;
  agents: readonly WorkspaceAgentViewModel[];
  /** Where an Agent was last standing; the desk is used when it is unknown. */
  positionOf: (agentId: string) => WorldPoint | null;
  /** False under reduced motion, or when the room is not being drawn. */
  enabled: boolean;
}

interface RememberedAgent {
  name: string;
  appearance: WorkspaceAgentViewModel["appearance"];
  seatAnchor: WorldPoint;
}

/**
 * Keeps an Agent on screen just long enough to leave.
 *
 * The room is a projection of server state, so the instant an Agent is deleted
 * it is simply absent from the next view model — it would vanish between two
 * frames. This holds a copy of whoever disappeared for the length of the
 * goodbye and then drops it.
 *
 * It is deliberately one-way and lossy. Nothing here can bring an Agent back,
 * nothing downstream reads it, and a departure that is interrupted by a
 * refresh, a tab switch, or a second delete just ends early. The record was
 * already written before this ran.
 */
export function useDepartures({
  scopeId,
  agents,
  positionOf,
  enabled,
}: DeparturesOptions): DepartingAgentModel[] {
  const [departures, setDepartures] = useState<DepartingAgentModel[]>([]);
  const rememberedRef = useRef(new Map<string, RememberedAgent>());
  const scopeRef = useRef<string | null>(scopeId);
  // Read inside the effect rather than depended on: the roster array is rebuilt
  // on every poll, and only its membership is a reason to run this.
  const latestRef = useRef({ agents, positionOf });
  latestRef.current = { agents, positionOf };

  const rosterKey = agents.map((agent) => agent.agentId).join("|");

  useEffect(() => {
    const { agents: current, positionOf: locate } = latestRef.current;
    const next = new Map<string, RememberedAgent>(
      current.map((agent) => [
        agent.agentId,
        {
          name: agent.name,
          appearance: agent.appearance,
          seatAnchor: locate(agent.agentId) ?? { x: 0, y: 0 },
        },
      ]),
    );

    if (scopeRef.current !== scopeId) {
      scopeRef.current = scopeId;
      rememberedRef.current = next;
      setDepartures([]);
      return;
    }

    const gone: DepartingAgentModel[] = [];
    for (const [agentId, remembered] of rememberedRef.current) {
      if (next.has(agentId)) continue;
      gone.push({
        agentId,
        name: remembered.name,
        appearance: remembered.appearance,
        from: remembered.seatAnchor,
        startedAt: performance.now(),
      });
    }
    rememberedRef.current = next;
    if (!enabled || gone.length === 0) return;
    setDepartures((currentDepartures) => [...currentDepartures, ...gone]);
  }, [enabled, rosterKey, scopeId]);

  // One timer per departure, cleared on unmount so a closed room stops drawing.
  useEffect(() => {
    if (departures.length === 0) return;
    const timers = departures.map((departure) =>
      window.setTimeout(
        () =>
          setDepartures((current) =>
            current.filter((item) => item.startedAt !== departure.startedAt ||
              item.agentId !== departure.agentId),
          ),
        Math.max(0, departure.startedAt + DEPARTURE_MS - performance.now()),
      ),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [departures]);

  return departures;
}
