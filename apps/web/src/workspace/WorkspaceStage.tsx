import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canvasSupported } from "./pixi/canvas-support";
import {
  MAX_SEATS,
  seatLayout,
  stageTransform,
  worldToScreen,
  WORLD,
} from "./workspace-layout";
import {
  WORKSPACE_ACTIVITY,
  type WorkspaceViewModel,
} from "./workspace-view-model";

/**
 * Pixi is only fetched when a room is actually shown, so opening the product
 * never pays for the renderer up front.
 */
const WorkspaceCanvas = lazy(() => import("./pixi/WorkspaceCanvas"));

/**
 * Where a name plate hangs, relative to the Agent's feet.
 *
 * Centred on the Agent and just below the shoes, so the plate reads as
 * belonging to whoever it names wherever they wander. It used to hang under
 * the *desk*, which is far below an Agent standing anywhere else.
 */
const PLATE_OFFSET = { x: 0, y: 5 } as const;

interface WorkspaceStageProps {
  viewModel: WorkspaceViewModel;
  replies: number;
  onSelectAgent: (agentId: string) => void;
  onOpenConversation: () => void;
  onOpenPreview: () => void;
  onOpenApprovals: () => void;
}

/**
 * The stage owns everything the canvas must not: size, focus, and words.
 *
 * Each seated Agent gets a real HTML button positioned over its desk, so the
 * room is operable by keyboard and readable by a screen reader even though the
 * picture behind it is a canvas. If the renderer is unavailable the same
 * information is still here — the buttons simply stand on their own.
 */
export function WorkspaceStage({
  viewModel,
  replies,
  onSelectAgent,
  onOpenConversation,
  onOpenPreview,
  onOpenApprovals,
}: WorkspaceStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const [supported] = useState(canvasSupported);

  // Measure once on mount and then track changes. The first measurement is
  // taken directly rather than waiting for an observer callback, so the room
  // is never stuck at zero size if that first notification is missed.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  const transform = useMemo(
    () => stageTransform(size.width, size.height),
    [size.height, size.width],
  );
  const seatCount = Math.min(viewModel.agents.length, MAX_SEATS);
  const seats = useMemo(() => seatLayout(seatCount), [seatCount]);
  const seated = useMemo(
    () => viewModel.agents.slice(0, seats.length).map((agent, index) => ({
      agent,
      seat: seats[index]!,
    })),
    [seats, viewModel.agents],
  );

  /*
   * The plates follow the sprites.
   *
   * An idle Agent drifts around its pod and eventually walks off to doze, so a
   * plate pinned to the seat would drift away from the Agent it names. The
   * canvas owns the animation, so it reports each position and the plate is
   * moved by hand — through a ref rather than state, because this happens on
   * the Pixi ticker and must never cost a React render.
   */
  const plateRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const liveRef = useRef({ transform, seated });
  liveRef.current = { transform, seated };

  const handleAgentPosition = useCallback((agentId: string, x: number, y: number) => {
    const plate = plateRefs.current.get(agentId);
    if (!plate) return;
    const { transform: live } = liveRef.current;
    plate.style.left = `${Math.round((x + PLATE_OFFSET.x) * live.scale)}px`;
    plate.style.top = `${Math.round((y + PLATE_OFFSET.y) * live.scale)}px`;
  }, []);

  const onFailure = useCallback(() => setRenderFailed(true), []);
  const canRender = supported && !renderFailed && size.width > 0 && size.height > 0;
  const overflow = viewModel.agents.length - seats.length;

  return (
    <div className="ws-stage" ref={hostRef}>
      {canRender ? (
        <Suspense fallback={<div className="ws-stage-loading" role="status" aria-label="Loading the room" />}>
          <WorkspaceCanvas
            onFailure={onFailure}
            viewModel={viewModel}
            seats={seats}
            transform={transform}
            hoveredAgentId={hovered}
            replies={replies}
            onSelectAgent={onSelectAgent}
            onHoverAgent={setHovered}
            onOpenConversation={onOpenConversation}
            onOpenPreview={onOpenPreview}
            onOpenApprovals={onOpenApprovals}
            onAgentPosition={handleAgentPosition}
          />
        </Suspense>
      ) : (
        <div className="ws-stage-fallback" role="note">
          <strong>Room view unavailable</strong>
          <span>
            {!supported
              ? "This browser has no WebGL context, so the room cannot be drawn."
              : renderFailed
                ? "The workspace renderer stopped. Everything below still works."
                : "Preparing the room…"}
          </span>
        </div>
      )}

      <div
        className={"ws-overlay " + (canRender ? "is-mapped" : "is-listed")}
        style={
          canRender
            ? {
                width: WORLD.width * transform.scale,
                height: WORLD.height * transform.scale,
                left: transform.offsetX,
                top: transform.offsetY,
              }
            : undefined
        }
      >
        {seated.map(({ agent, seat }) => {
          const descriptor = WORKSPACE_ACTIVITY[agent.activity];
          const point = worldToScreen(transform, {
            x: seat.anchor.x + PLATE_OFFSET.x,
            y: seat.anchor.y + PLATE_OFFSET.y,
          });
          return (
            <button
              key={agent.agentId}
              ref={(node) => {
                if (node) plateRefs.current.set(agent.agentId, node);
                else plateRefs.current.delete(agent.agentId);
              }}
              type="button"
              className={
                "ws-plate" +
                (agent.isSelected ? " is-selected" : "") +
                (agent.isCurrentParticipant ? " is-active" : "")
              }
              data-tone={descriptor.tone}
              style={
                canRender
                  ? { left: point.x - transform.offsetX, top: point.y - transform.offsetY }
                  : undefined
              }
              aria-pressed={agent.isSelected}
              onClick={() => onSelectAgent(agent.agentId)}
              onMouseEnter={() => setHovered(agent.agentId)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(agent.agentId)}
              onBlur={() => setHovered(null)}
            >
              <span className="ws-plate-name">{agent.name}</span>
              <span className="ws-plate-state">
                <span className="ws-plate-glyph" aria-hidden="true">{descriptor.glyph}</span>
                {descriptor.label}
                {agent.isCurrentParticipant ? " · this turn" : ""}
              </span>
            </button>
          );
        })}

      </div>

      {overflow > 0 && (
        <p className="ws-overflow" role="note">
          {overflow} more {overflow === 1 ? "Agent is" : "Agents are"} on this Workspace than the
          room seats. They are listed in the sidebar.
        </p>
      )}
    </div>
  );
}
