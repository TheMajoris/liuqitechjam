import { useCallback, useMemo, type CSSProperties } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { agentHue, formatDuration, turnStatusLabel } from "./orchestration-utils";
import {
  FLOW_NODE_WIDTH,
  type FlowElements,
  type FlowMarkerData,
  type FlowTurnData,
  type GraphNode,
} from "./orchestration-graph";

export interface OrchestrationFlowCanvasProps {
  elements: FlowElements;
  selectedId: string | null;
  onSelect: (turnId: string | null) => void;
}

type TurnFlowNode = Node<FlowTurnData, "turn">;
type CycleFlowNode = Node<FlowMarkerData, "cycle">;

/** Stable per-Agent accent, so a lane keeps one colour across every view. */
function hueStyle(agentId: string): CSSProperties {
  return { "--orch-graph-hue": agentHue(agentId) } as CSSProperties;
}

function statusModifier(status: GraphNode["turn"]["status"]): string {
  switch (status) {
    case "completed":
      return "is-completed";
    case "dispatched":
      return "is-running";
    case "cancelled":
      return "is-cancelled";
    default:
      return "is-failed";
  }
}

/**
 * One dispatched turn.
 *
 * The card is a real button so it is reachable and announced without the
 * canvas having to fake either. Selection rides the click bubbling up to the
 * flow, which covers keyboard activation too.
 */
function TurnNode({ data, selected }: NodeProps<TurnFlowNode>) {
  const { node, label } = data;
  const { turn } = node;
  return (
    <div className="orch-flow-node" style={hueStyle(turn.agentId)}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <button
        type="button"
        className={
          "orch-flow-card " +
          statusModifier(turn.status) +
          (selected ? " is-selected" : "")
        }
        style={{ width: FLOW_NODE_WIDTH }}
        aria-pressed={selected}
      >
        <span className="orch-flow-card-top">
          <span className="orch-flow-dot" aria-hidden="true" />
          <span className="orch-flow-step">
            {String(node.stepNumber).padStart(2, "0")}
          </span>
          <span className="orch-flow-name">{label}</span>
        </span>
        <span className="orch-flow-card-meta">
          <span className="orch-flow-status">{turnStatusLabel(turn.status)}</span>
          {node.durationMs !== undefined && (
            <span className="orch-flow-duration">{formatDuration(node.durationMs)}</span>
          )}
        </span>
      </button>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

/** A follow-up prompt: the boundary where a fresh execution cycle began. */
function CycleNode({ data }: NodeProps<CycleFlowNode>) {
  const { marker } = data;
  return (
    <div className="orch-flow-marker">
      <span className="orch-flow-marker-tag">Follow-up {marker.cycleIndex}</span>
      <span className="orch-flow-marker-prompt">{marker.prompt}</span>
    </div>
  );
}

const nodeTypes: NodeTypes = { turn: TurnNode, cycle: CycleNode };

/**
 * The flow viewport. Loaded on demand, because the library is large and only
 * the Activity tab needs it.
 *
 * Positions arrive already computed, so nothing here solves a layout: the
 * canvas only paints and reports which card was chosen.
 */
export default function OrchestrationFlowCanvas({
  elements,
  selectedId,
  onSelect,
}: OrchestrationFlowCanvasProps) {
  const nodes = useMemo<Node[]>(
    () =>
      elements.nodes.map((item) => ({
        id: item.id,
        type: item.type,
        position: item.position,
        data: item.data,
        selectable: item.selectable,
        selected: item.id === selectedId,
        draggable: false,
      })),
    [elements.nodes, selectedId],
  );

  const edges = useMemo<Edge[]>(
    () =>
      elements.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        className:
          "orch-flow-edge" +
          (edge.handoff ? " is-handoff" : "") +
          (edge.crossCycle ? " is-cross-cycle" : ""),
      })),
    [elements.edges],
  );

  const handleNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      // Follow-up markers are annotations, not turns: nothing to inspect.
      if (node.type !== "turn") return;
      onSelect(node.id === selectedId ? null : node.id);
    },
    [onSelect, selectedId],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={handleNodeClick}
      onPaneClick={() => onSelect(null)}
      fitView
      fitViewOptions={{ padding: 0.24, maxZoom: 1 }}
      minZoom={0.4}
      maxZoom={1.4}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      // The cards own focus, so the canvas must not add a tab stop per node.
      nodesFocusable={false}
      // The Activity tab scrolls; zooming on wheel would trap the page.
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
    >
      <Background gap={18} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
