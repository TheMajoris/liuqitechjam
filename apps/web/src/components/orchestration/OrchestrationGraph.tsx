import { Suspense, lazy, useCallback, useMemo, useState, type CSSProperties } from "react";
import type { Agent, OrchestrationSessionDetail } from "../../types";
import { agentHue, agentName } from "./orchestration-utils";
import { buildOrchestrationGraph, toFlowElements } from "./orchestration-graph";
import { OrchestrationTurnInspector } from "./OrchestrationTurnInspector";

/**
 * The flow library is large and only this tab uses it, so it is fetched when
 * a graph is actually shown rather than on first paint.
 */
const OrchestrationFlowCanvas = lazy(() => import("./OrchestrationFlowCanvas"));

interface OrchestrationGraphProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  /** Omitted when the caller has no way to resume, which hides the action. */
  onRetry?: ((fromStepIndex: number) => void) | undefined;
  retryPending?: boolean;
  retryBlocked?: boolean;
}

/** Stable per-Agent accent, so a lane keeps one colour across every view. */
function hueStyle(agentId: string): CSSProperties {
  return { "--orch-graph-hue": agentHue(agentId) } as CSSProperties;
}

/**
 * The run as a branching graph: one lane per roster occurrence, one card per
 * dispatched turn, one strand following the work as it moves between Agents.
 *
 * Selecting a card opens the journal recorded against that turn, and a failed
 * turn is where a resume can be started. The graph reads the same journal the
 * Activity log reads and never becomes a second source of truth about a run.
 */
export function OrchestrationGraph({
  detail,
  agents,
  onRetry,
  retryPending = false,
  retryBlocked = false,
}: OrchestrationGraphProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const graph = useMemo(() => buildOrchestrationGraph(detail), [detail]);
  const elements = useMemo(
    () => toFlowElements(graph, (agentId) => agentName(agents, agentId)),
    [graph, agents],
  );

  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );

  const clearSelection = useCallback(() => setSelectedId(null), []);

  return (
    <section className="orch-graph" aria-labelledby="orch-graph-heading">
      <div className="orch-graph-head">
        <div>
          <span className="orch-eyebrow">Workflow</span>
          <h2 id="orch-graph-heading">Execution graph</h2>
        </div>
        <span className="orch-timeline-count">
          {graph.nodes.length} {graph.nodes.length === 1 ? "turn" : "turns"}
          {graph.lanes.length > 0 &&
            ` · ${graph.lanes.length} ${graph.lanes.length === 1 ? "lane" : "lanes"}`}
        </span>
      </div>

      {graph.rowCount === 0 ? (
        <div className="orch-timeline-empty" role="status">
          <span className="orch-empty-glyph" aria-hidden="true">—</span>
          <strong>No turns to graph yet</strong>
          <span>
            Once Agents start taking turns, each one appears here as a card in its own
            lane. Select a card to see what it recorded.
          </span>
        </div>
      ) : (
        <>
          <ol className="orch-graph-legend">
            {graph.lanes.map((lane) => (
              <li key={lane.participantId} style={hueStyle(lane.agentId)}>
                <span className="orch-graph-legend-dot" aria-hidden="true" />
                <span className="orch-graph-legend-name">
                  {agentName(agents, lane.agentId)}
                </span>
                {lane.role && <span className="orch-graph-legend-role">{lane.role}</span>}
              </li>
            ))}
          </ol>

          <div className={"orch-graph-stage " + (selected ? "has-inspector" : "")}>
            <div className="orch-graph-flow">
              <Suspense
                fallback={
                  <div
                    className="orch-graph-flow-loading"
                    role="status"
                    aria-label="Loading the execution graph"
                  />
                }
              >
                <OrchestrationFlowCanvas
                  elements={elements}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </Suspense>
            </div>

            {selected && (
              <OrchestrationTurnInspector
                node={selected}
                agents={agents}
                onRetry={onRetry}
                retryPending={retryPending}
                retryBlocked={retryBlocked}
                onClose={clearSelection}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
