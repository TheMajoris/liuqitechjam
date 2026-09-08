import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { Agent, OrchestrationSessionDetail } from "../../types";
import { AgentAvatar } from "./AgentAvatar";
import {
  agentHue,
  agentName,
  formatDateTime,
  formatDuration,
  turnStatusLabel,
} from "./orchestration-utils";
import {
  buildOrchestrationGraph,
  laneExtents,
  type GraphNode,
  type GraphRow,
} from "./orchestration-graph";
import { OrchestrationTurnInspector } from "./OrchestrationTurnInspector";
import { briefLine } from "./turn-narrative";

interface OrchestrationGraphProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  /** Omitted when the caller has no way to retry, which hides the action. */
  onRetry?: ((fromStepIndex: number) => void) | undefined;
  retryPending?: boolean;
  retryBlocked?: boolean;
  /** True while another lifecycle action is in flight. */
  retryDisabled?: boolean;
}

/**
 * Rail geometry.
 *
 * The rail is capped rather than scaled: a run with three lanes and a run with
 * thirty both draw inside `RAIL_WIDTH`, because the pitch tightens instead of
 * the graph growing sideways. Rows are a fixed height whatever they contain,
 * so the track a row draws never depends on how much text landed in it.
 */
const RAIL_WIDTH = 108;
const RAIL_INSET = 13;
const LANE_PITCH_MAX = 17;
const ROW_HEIGHT = 46;

/** Turns shown before the log asks to be opened in full. */
const INITIAL_LIMIT = 40;

type StatusFilter = "all" | "failed";

function lanePitch(laneCount: number): number {
  if (laneCount <= 1) return 0;
  return Math.min(LANE_PITCH_MAX, (RAIL_WIDTH - RAIL_INSET * 2) / (laneCount - 1));
}

function laneX(column: number, pitch: number): number {
  return RAIL_INSET + column * pitch;
}

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

interface RailProps {
  /** Columns whose track passes through this row, already filtered. */
  throughColumns: number[];
  pitch: number;
  /** The lane this row's turn sits on; absent for a follow-up marker. */
  column?: number;
  /** Where the previous turn sat, so the strand can bend into this one. */
  fromColumn?: number;
  /** This lane already held a turn above, so its own track arrives from above. */
  ownAbove?: boolean;
  /** This lane holds a later turn, so its own track continues below. */
  ownBelow?: boolean;
  agentId?: string;
  statusClass?: string;
  handoff?: boolean;
}

/**
 * One row's slice of the graph.
 *
 * Every row paints its own fixed-height strip, so an expanded row cannot
 * stretch the drawing and a long run cannot outgrow one SVG's coordinate
 * space. Together the strips read as continuous tracks, the way a commit
 * graph does.
 */
function Rail({
  throughColumns,
  pitch,
  column,
  fromColumn,
  ownAbove = false,
  ownBelow = false,
  agentId,
  statusClass = "",
  handoff = false,
}: RailProps) {
  const midY = ROW_HEIGHT / 2;
  const nodeX = column === undefined ? 0 : laneX(column, pitch);
  const bendsIn = fromColumn !== undefined && column !== undefined && fromColumn !== column;

  return (
    <svg
      className="orch-log-rail"
      width={RAIL_WIDTH}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${RAIL_WIDTH} ${ROW_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      {throughColumns.map((track) => (
        <line
          key={track}
          className="orch-log-track"
          x1={laneX(track, pitch)}
          y1={0}
          x2={laneX(track, pitch)}
          y2={ROW_HEIGHT}
        />
      ))}
      {column !== undefined && ownAbove && (
        <line
          className="orch-log-track"
          x1={nodeX}
          y1={0}
          x2={nodeX}
          y2={midY}
        />
      )}
      {column !== undefined && ownBelow && (
        <line
          className="orch-log-track"
          x1={nodeX}
          y1={midY}
          x2={nodeX}
          y2={ROW_HEIGHT}
        />
      )}
      {bendsIn && (
        <path
          className={"orch-log-strand" + (handoff ? " is-handoff" : "")}
          d={
            `M ${laneX(fromColumn, pitch)} 0 ` +
            `C ${laneX(fromColumn, pitch)} ${midY * 0.7}, ` +
            `${nodeX} ${midY * 0.4}, ${nodeX} ${midY}`
          }
          fill="none"
        />
      )}
      {column !== undefined && (
        <circle
          className={"orch-log-dot " + statusClass}
          style={agentId ? hueStyle(agentId) : undefined}
          cx={nodeX}
          cy={midY}
          r={5.5}
        />
      )}
    </svg>
  );
}

/**
 * The run as a commit log.
 *
 * One row per dispatched turn, newest work at the bottom, with a lane rail on
 * the left that follows the work as it moves between Agents. A row opens in
 * place to show what that turn was asked, what it replied, and every entry its
 * Run recorded — so the log stays one screen wide and one row tall per turn
 * however long the conversation runs.
 *
 * It reads the same journal the event log reads and never becomes a second
 * source of truth about a run.
 */
export function OrchestrationGraph({
  detail,
  agents,
  onRetry,
  retryPending = false,
  retryBlocked = false,
  retryDisabled = false,
}: OrchestrationGraphProps) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [showAll, setShowAll] = useState(false);

  const graph = useMemo(() => buildOrchestrationGraph(detail), [detail]);
  const extents = useMemo(() => laneExtents(graph), [graph]);
  const pitch = useMemo(() => lanePitch(graph.lanes.length), [graph.lanes.length]);
  const failedCount = useMemo(
    () => graph.nodes.filter((node) => node.failed).length,
    [graph.nodes],
  );

  /** The turn drawn directly above each one, so a strand knows where to bend from. */
  const previousColumn = useMemo(() => {
    const map = new Map<string, number>();
    let last: number | undefined;
    for (const node of graph.nodes) {
      if (last !== undefined) map.set(node.id, last);
      last = node.column;
    }
    return map;
  }, [graph.nodes]);

  const handoffRunIds = useMemo(
    () => new Set(graph.edges.filter((edge) => edge.handoff).map((edge) => edge.toId)),
    [graph.edges],
  );

  /**
   * The one-line answer to "what was this turn for".
   *
   * The stored input is a rendered prompt of several thousand characters, so a
   * row that printed it verbatim said nothing at a glance. A turn's input is
   * written once at dispatch and never rewritten, so the reading is cached by
   * turn ID: a live run replaces `detail` on a sub-second poll, and reparsing
   * every historical prompt on each of those would be steady wasted work.
   */
  const summaryCache = useRef(new Map<string, string>());
  const rowSummary = (node: GraphNode): string => {
    const cached = summaryCache.current.get(node.id);
    if (cached !== undefined) return cached;
    const line = briefLine(node.turn.safeInputSummary);
    summaryCache.current.set(node.id, line);
    return line;
  };

  const visibleRows = useMemo<GraphRow[]>(() => {
    const rows =
      filter === "failed"
        ? graph.rows.filter((row) => row.kind === "turn" && row.failed)
        : graph.rows;
    // Long runs open on their most recent turns, which is where a reader is
    // looking; the whole log stays one click away rather than being paged.
    return showAll || rows.length <= INITIAL_LIMIT ? rows : rows.slice(-INITIAL_LIMIT);
  }, [filter, graph.rows, showAll]);

  const hiddenCount =
    (filter === "failed"
      ? graph.rows.filter((row) => row.kind === "turn" && row.failed).length
      : graph.rows.length) - visibleRows.length;

  const toggleRow = (id: string) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOpen = graph.nodes.length > 0 && graph.nodes.every((node) => openIds.has(node.id));

  return (
    <section className="orch-log" aria-labelledby="orch-graph-heading">
      <div className="orch-log-head">
        <div className="orch-log-head-copy">
          <span className="orch-eyebrow">Workflow</span>
          <h2 id="orch-graph-heading">Run log</h2>
        </div>
        <div className="orch-log-head-tools">
          <span className="orch-timeline-count">
            {graph.nodes.length} {graph.nodes.length === 1 ? "turn" : "turns"}
            {graph.lanes.length > 0 &&
              ` · ${graph.lanes.length} ${graph.lanes.length === 1 ? "lane" : "lanes"}`}
          </span>
          {failedCount > 0 && (
            <div className="orch-log-filter" role="group" aria-label="Filter turns">
              <button
                type="button"
                className={filter === "all" ? "is-active" : ""}
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                className={filter === "failed" ? "is-active" : ""}
                aria-pressed={filter === "failed"}
                onClick={() => setFilter("failed")}
              >
                Failed {failedCount}
              </button>
            </div>
          )}
          {graph.nodes.length > 0 && (
            <button
              type="button"
              className="orch-log-collapse"
              onClick={() =>
                setOpenIds(allOpen ? new Set() : new Set(graph.nodes.map((node) => node.id)))
              }
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>
      </div>

      {graph.rowCount === 0 ? (
        <div className="orch-timeline-empty" role="status">
          <span className="orch-empty-glyph" aria-hidden="true">—</span>
          <strong>No turns to graph yet</strong>
          <span>
            Once Agents start taking turns, each one appears here as a row in its own
            lane. Open a row to see what it recorded.
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

          {hiddenCount > 0 && (
            <button
              type="button"
              className="orch-log-more"
              onClick={() => setShowAll(true)}
            >
              Show {hiddenCount} earlier {hiddenCount === 1 ? "turn" : "turns"}
            </button>
          )}

          <ol className="orch-log-rows">
            {visibleRows.map((row) => {
              if (row.kind === "cycle") {
                return (
                  <li key={row.id} className="orch-log-row is-cycle">
                    <Rail
                      throughColumns={extents
                        .filter(
                          (lane) => lane.firstRow < row.row && lane.lastRow > row.row,
                        )
                        .map((lane) => lane.column)}
                      pitch={pitch}
                    />
                    <div className="orch-log-cycle">
                      <span className="orch-log-cycle-tag">Follow-up {row.cycleIndex}</span>
                      <span className="orch-log-cycle-prompt">{row.prompt}</span>
                      <time dateTime={row.createdAt}>{formatDateTime(row.createdAt)}</time>
                    </div>
                  </li>
                );
              }

              const open = openIds.has(row.id);
              const name = agentName(agents, row.turn.agentId);
              const status = statusModifier(row.turn.status);
              const ownExtent = extents.find((lane) => lane.column === row.column);
              return (
                <li
                  key={row.id}
                  className={"orch-log-row " + status + (open ? " is-open" : "")}
                  style={
                    {
                      ...hueStyle(row.turn.agentId),
                      "--orch-log-x": laneX(row.column, pitch) + "px",
                    } as CSSProperties
                  }
                >
                  <Rail
                    throughColumns={extents
                      .filter(
                        (lane) =>
                          lane.column !== row.column &&
                          lane.firstRow < row.row &&
                          lane.lastRow > row.row,
                      )
                      .map((lane) => lane.column)}
                    pitch={pitch}
                    column={row.column}
                    {...(previousColumn.has(row.id)
                      ? { fromColumn: previousColumn.get(row.id) }
                      : {})}
                    ownAbove={ownExtent ? ownExtent.firstRow < row.row : false}
                    ownBelow={ownExtent ? ownExtent.lastRow > row.row : false}
                    agentId={row.turn.agentId}
                    statusClass={status}
                    handoff={handoffRunIds.has(row.id)}
                  />

                  <button
                    type="button"
                    className="orch-log-entry"
                    aria-expanded={open}
                    aria-controls={`orch-log-detail-${row.id}`}
                    onClick={() => toggleRow(row.id)}
                  >
                    <span className="orch-log-step">
                      {String(row.stepNumber).padStart(2, "0")}
                    </span>
                    <AgentAvatar agentId={row.turn.agentId} name={name} size="sm" />
                    <span className="orch-log-name">{name}</span>
                    <span className="orch-log-summary">
                      {/* An unreadable record is still the record: showing it
                          verbatim beats claiming the turn had no input. */}
                      {rowSummary(row) || row.turn.safeInputSummary}
                    </span>
                    <span className={"orch-log-status " + status}>
                      {turnStatusLabel(row.turn.status)}
                    </span>
                    <span className="orch-log-duration">
                      {formatDuration(row.durationMs)}
                    </span>
                    <code className="orch-log-run">{row.turn.runId.slice(0, 7)}</code>
                    <span className="orch-log-caret" aria-hidden="true">
                      {open ? "▾" : "▸"}
                    </span>
                  </button>

                  {open && (
                    <div className="orch-log-detail" id={`orch-log-detail-${row.id}`}>
                      <OrchestrationTurnInspector
                        node={row}
                        agents={agents}
                        participants={detail?.session.participants ?? []}
                        onRetry={onRetry}
                        retryPending={retryPending}
                        retryBlocked={retryBlocked}
                        retryDisabled={retryDisabled}
                        onClose={() => toggleRow(row.id)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
