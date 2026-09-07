import type {
  OrchestrationContinuationPrompt,
  OrchestrationEvent,
  OrchestrationParticipant,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "../../types";
import { turnStepNumber } from "./orchestration-utils";

/** One vertical track, held by a single roster occurrence for the whole run. */
export interface GraphLane {
  participantId: string;
  agentId: string;
  role: string;
  column: number;
}

/** A dispatched turn: one dot on the graph. */
export interface GraphNode {
  kind: "turn";
  id: string;
  row: number;
  column: number;
  turn: OrchestrationTurn;
  /** One-based execution step, matching the Activity log numbering. */
  stepNumber: number;
  runId: string;
  durationMs: number | undefined;
  /** Zero identifies the initial task; each follow-up increments it. */
  cycleIndex: number;
  /** Raw routing reason recorded when automatic turn taking chose this turn. */
  reason: string | undefined;
  /**
   * The journal entries recorded against this turn's Run, in sequence order.
   * Decision and handoff events carry no Run ID and are summarized onto the
   * node instead, so they are deliberately absent here.
   */
  events: OrchestrationEvent[];
  /**
   * The turn did not produce a usable result, so resuming from it is the
   * action a reader is most likely to want.
   */
  failed: boolean;
}

/** A follow-up prompt, which starts a fresh execution cycle. */
export interface GraphMarker {
  kind: "cycle";
  id: string;
  row: number;
  cycleIndex: number;
  prompt: string;
  createdAt: string;
}

export type GraphRow = GraphNode | GraphMarker;

export interface GraphEdge {
  id: string;
  /** Turn IDs, so a consumer never has to parse the edge ID. */
  fromId: string;
  toId: string;
  fromRow: number;
  fromColumn: number;
  toRow: number;
  toColumn: number;
  /** A recorded handoff carried the previous result into this turn. */
  handoff: boolean;
  /** Spans a follow-up boundary, where only bounded context crossed. */
  crossCycle: boolean;
}

export interface OrchestrationGraphModel {
  lanes: GraphLane[];
  nodes: GraphNode[];
  markers: GraphMarker[];
  edges: GraphEdge[];
  /** Nodes and markers together, in the order they are drawn top to bottom. */
  rows: GraphRow[];
  rowCount: number;
}

const EMPTY_MODEL: OrchestrationGraphModel = {
  lanes: [],
  nodes: [],
  markers: [],
  edges: [],
  rows: [],
  rowCount: 0,
};

/**
 * Mirrors the server turn ordering so the graph and the Activity log agree.
 * The detail response already arrives sorted; sorting again keeps this a pure
 * function of its input rather than of the transport.
 */
function compareTurns(left: OrchestrationTurn, right: OrchestrationTurn): number {
  if (left.stepIndex !== undefined && right.stepIndex !== undefined) {
    const byStep = left.stepIndex - right.stepIndex;
    if (byStep !== 0) return byStep;
  }
  if (left.stepIndex !== undefined && right.stepIndex === undefined) return -1;
  if (left.stepIndex === undefined && right.stepIndex !== undefined) return 1;
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.position - right.position ||
    left.id.localeCompare(right.id)
  );
}

function comparePrompts(
  left: OrchestrationContinuationPrompt,
  right: OrchestrationContinuationPrompt,
): number {
  return (
    left.cycleIndex - right.cycleIndex ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * One lane per roster occurrence, ordered by declared position.
 *
 * A turn whose participant is no longer on the roster still has to land
 * somewhere, so unknown occurrences take trailing lanes in first-seen order.
 * Dropping a lane would silently hide evidence about work that did happen.
 */
function buildLanes(
  participants: readonly OrchestrationParticipant[],
  turns: readonly OrchestrationTurn[],
): GraphLane[] {
  const lanes: GraphLane[] = [...participants]
    .sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    )
    .map((participant, column) => ({
      participantId: participant.id,
      agentId: participant.agentId,
      role: participant.role,
      column,
    }));
  const known = new Set(lanes.map((lane) => lane.participantId));
  for (const turn of turns) {
    if (known.has(turn.participantId)) continue;
    known.add(turn.participantId);
    lanes.push({
      participantId: turn.participantId,
      agentId: turn.agentId,
      role: "",
      column: lanes.length,
    });
  }
  return lanes;
}

interface DispatchFacts {
  durations: Map<string, number>;
  reasons: Map<string, string>;
  handoffs: Set<string>;
  /** Every Run-scoped journal entry, keyed by Run and kept in sequence order. */
  byRun: Map<string, OrchestrationEvent[]>;
}

/**
 * Replay the journal in recorded order to attach per-run facts.
 *
 * The engine writes a decision, then a handoff, then the dispatch that carries
 * the run ID, so one ordered pass binds both to the run they belong to.
 * Neither event carries a run ID of its own, and matching them by sequence
 * ranges afterwards would be guesswork.
 */
function collectDispatchFacts(events: readonly OrchestrationEvent[]): DispatchFacts {
  const durations = new Map<string, number>();
  const reasons = new Map<string, string>();
  const handoffs = new Set<string>();
  const byRun = new Map<string, OrchestrationEvent[]>();
  let pendingReason: string | undefined;
  let pendingHandoff: string | undefined;

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.runId !== undefined) {
      const existing = byRun.get(event.runId);
      if (existing) existing.push(event);
      else byRun.set(event.runId, [event]);
    }
    switch (event.type) {
      case "supervisor_decision":
        // A completion decision selects nobody, so it annotates no turn.
        if (event.completionReason !== "supervisor_completed") {
          pendingReason = event.safeSummary;
        }
        break;
      case "handoff_applied":
        pendingHandoff = event.participantId;
        break;
      case "participant_dispatched":
        if (event.runId !== undefined) {
          if (pendingReason !== undefined) reasons.set(event.runId, pendingReason);
          if (pendingHandoff !== undefined && pendingHandoff === event.participantId) {
            handoffs.add(event.runId);
          }
        }
        pendingReason = undefined;
        pendingHandoff = undefined;
        break;
      case "run_completed":
        if (event.runId !== undefined && event.durationMs !== undefined) {
          durations.set(event.runId, event.durationMs);
        }
        break;
      default:
        // Any other record means the dispatch those pendings were waiting for
        // never happened: a failed or stopped turn leaves a decision and a
        // handoff behind, and they must not attach to a later cycle.
        pendingReason = undefined;
        pendingHandoff = undefined;
        break;
    }
  }

  return { durations, reasons, handoffs, byRun };
}

/**
 * Project one session detail into lanes, dots, and edges.
 *
 * Pure and read-only: the graph is a second view of the same journal the
 * Activity log renders, never a separate source of truth about the run.
 */
export function buildOrchestrationGraph(
  detail: OrchestrationSessionDetail | null,
): OrchestrationGraphModel {
  if (!detail) return EMPTY_MODEL;

  const turns = [...detail.turns].sort(compareTurns);
  const prompts = [...(detail.continuationPrompts ?? [])].sort(comparePrompts);
  // A run that failed before its first dispatch has no turns, but a follow-up
  // accepted afterwards is still recorded work and still belongs on the graph.
  if (turns.length === 0 && prompts.length === 0) return EMPTY_MODEL;

  const lanes = buildLanes(detail.session.participants, turns);
  const columns = new Map(lanes.map((lane) => [lane.participantId, lane.column]));
  const facts = collectDispatchFacts(detail.events);

  const nodes: GraphNode[] = [];
  const markers: GraphMarker[] = [];
  const rows: GraphRow[] = [];
  let promptIndex = 0;
  let cycleIndex = 0;

  const emitMarker = (prompt: OrchestrationContinuationPrompt) => {
    const marker: GraphMarker = {
      kind: "cycle",
      id: prompt.id,
      row: rows.length,
      cycleIndex: prompt.cycleIndex,
      prompt: prompt.prompt,
      createdAt: prompt.createdAt,
    };
    markers.push(marker);
    rows.push(marker);
    cycleIndex = prompt.cycleIndex;
  };

  for (const turn of turns) {
    // A follow-up is recorded before the cycle it starts, so every prompt at
    // or before this turn creation time belongs above it.
    while (
      promptIndex < prompts.length &&
      prompts[promptIndex]!.createdAt <= turn.createdAt
    ) {
      emitMarker(prompts[promptIndex]!);
      promptIndex += 1;
    }
    const node: GraphNode = {
      kind: "turn",
      id: turn.id,
      row: rows.length,
      column: columns.get(turn.participantId) ?? 0,
      turn,
      // Shared with the Activity log so the two views cannot number differently.
      stepNumber: turnStepNumber(turn, nodes.length),
      runId: turn.runId,
      durationMs: facts.durations.get(turn.runId),
      cycleIndex,
      reason: facts.reasons.get(turn.runId),
      events: facts.byRun.get(turn.runId) ?? [],
      failed: turn.status === "failed" || turn.status === "timed_out",
    };
    nodes.push(node);
    rows.push(node);
  }

  // A follow-up accepted but not yet dispatched still belongs on the graph.
  while (promptIndex < prompts.length) {
    emitMarker(prompts[promptIndex]!);
    promptIndex += 1;
  }

  const edges: GraphEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes[index - 1]!;
    const to = nodes[index]!;
    edges.push({
      id: from.id + "->" + to.id,
      fromId: from.id,
      toId: to.id,
      fromRow: from.row,
      fromColumn: from.column,
      toRow: to.row,
      toColumn: to.column,
      handoff: facts.handoffs.has(to.runId),
      crossCycle: from.cycleIndex !== to.cycleIndex,
    });
  }

  return { lanes, nodes, markers, edges, rows, rowCount: rows.length };
}

/**
 * Canvas geometry. Lanes are columns and execution steps are rows, so the
 * drawing keeps a git-graph reading even though a flow library owns the
 * viewport. Positions are absolute because the layout is computed, not solved.
 */
export const FLOW_LANE_GAP = 208;
export const FLOW_ROW_GAP = 86;
export const FLOW_NODE_WIDTH = 176;

export interface FlowTurnData extends Record<string, unknown> {
  node: GraphNode;
  /** Resolved Agent name. Injected so the model stays free of naming policy. */
  label: string;
}

export interface FlowMarkerData extends Record<string, unknown> {
  marker: GraphMarker;
}

export interface FlowNode {
  id: string;
  type: "turn" | "cycle";
  position: { x: number; y: number };
  data: FlowTurnData | FlowMarkerData;
  selectable: boolean;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  handoff: boolean;
  crossCycle: boolean;
}

export interface FlowElements {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/**
 * Place the model on a canvas.
 *
 * Kept separate from rendering so the geometry is testable without a DOM: the
 * flow library only consumes the arrays this returns. `resolveLabel` is
 * injected because a custom node receives only its own data, and naming an
 * Agent is the caller's concern rather than the layout's.
 */
export function toFlowElements(
  model: OrchestrationGraphModel,
  resolveLabel: (agentId: string) => string = (agentId) => agentId,
): FlowElements {
  const nodes: FlowNode[] = model.rows.map((row) =>
    row.kind === "turn"
      ? {
          id: row.id,
          type: "turn" as const,
          position: { x: row.column * FLOW_LANE_GAP, y: row.row * FLOW_ROW_GAP },
          data: { node: row, label: resolveLabel(row.turn.agentId) },
          selectable: true,
        }
      : {
          // A follow-up spans the whole run rather than belonging to a lane.
          id: row.id,
          type: "cycle" as const,
          position: { x: 0, y: row.row * FLOW_ROW_GAP },
          data: { marker: row },
          selectable: false,
        },
  );

  return {
    nodes,
    edges: model.edges.map((edge) => ({
      id: edge.id,
      source: edge.fromId,
      target: edge.toId,
      handoff: edge.handoff,
      crossCycle: edge.crossCycle,
    })),
  };
}
