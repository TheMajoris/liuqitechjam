import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { canvasSupported } from "./pixi/canvas-support";
import { useReducedMotion } from "./pixi/use-reduced-motion";
import { useDepartures } from "./use-departures";
import { useAgentDrag } from "./use-agent-drag";
import type { WorkspaceCrew } from "./pixi/art/avatar-look";
import type { PerkId } from "./pixi/art/perks";
import type { DropTarget, WorldPoint } from "./workspace-layout";
import {
  MAX_SEATS,
  POST_STATIONS,
  POST_ZONES,
  ZONES,
  officeSeats,
  stageTransform,
  worldToScreen,
  WORLD,
} from "./workspace-layout";
import {
  AREA_LABEL,
  dropTargetLabel,
  placeAgents,
  seatingOf,
  type AgentPlacement,
} from "./workspace-placement";
import {
  WORKSPACE_ACTIVITY,
  type WorkspaceViewModel,
} from "./workspace-view-model";
import {
  modelResourceCapacityLabel,
  modelResourceObservedLabel,
  modelResourceQuotaLabel,
  modelResourceQuotaPercent,
  modelResourceQuotaTone,
  modelResourceStatusGlyph,
} from "../model-resource-format";

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
  /** Optional office furniture; cosmetic, owned by the view. */
  perks?: ReadonlySet<PerkId>;
  /** People or robots, for the whole room. */
  crew?: WorkspaceCrew;
  /** How this browser has arranged the room. Cosmetic, like the furniture. */
  placement?: AgentPlacement;
  /** Called when an Agent is put down somewhere new. */
  onPlaceAgent?: (
    seating: ReadonlyMap<string, number>,
    agentId: string,
    target: DropTarget,
    at: WorldPoint,
  ) => void;
  onSelectAgent: (agentId: string) => void;
  onOpenConversation: () => void;
  onOpenPreview: () => void;
}

const NO_PLACEMENT: AgentPlacement = { seats: {}, posts: {} };

/**
 * The stage owns everything the canvas must not: size, focus, and words.
 *
 * Each seated Agent gets a real HTML button positioned over its desk, so the
 * room is operable by keyboard and readable by a screen reader even though the
 * picture behind it is a canvas. If the renderer is unavailable the same
 * information is still here — the buttons simply stand on their own.
 *
 * It also owns picking Agents up. The drag is deliberately not the canvas's
 * job: the pointer arrives in stage pixels, the areas are HTML-labelled, and
 * the keyboard equivalent runs on the same name plates that already carry
 * focus. The canvas is told who is in the air and draws it.
 */
export function WorkspaceStage({
  viewModel,
  replies,
  perks,
  crew = "people",
  placement = NO_PLACEMENT,
  onPlaceAgent,
  onSelectAgent,
  onOpenConversation,
  onOpenPreview,
}: WorkspaceStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  /**
   * The last plate that was pointed at, kept after the pointer leaves.
   *
   * Desks are closer together than a plate is wide, so plates overlap and the
   * one underneath is unreadable. Raising on hover fixed reading it and broke
   * comparing them: the plate dropped back the instant the pointer moved, so
   * you could never look at a raised plate and something else at once. This
   * holds the raise until another plate takes it — the room only ever has one
   * plate on top, and it is the one you last showed interest in.
   */
  const [raised, setRaised] = useState<string | null>(null);
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
  /*
   * Every workstation, not only the taken ones.
   *
   * The room draws six desks whether or not anyone sits at them, so two Agents
   * in a six-desk office may sit at any two of them. Capping the seats at the
   * roster size would have made four of the drawn desks refuse a drop for no
   * reason a viewer could see.
   */
  const seats = useMemo(() => officeSeats(), []);
  const placed = useMemo(
    () => placeAgents(viewModel.agents, seats, placement),
    [placement, seats, viewModel.agents],
  );
  const seating = useMemo(() => seatingOf(placed), [placed]);

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
  const liveRef = useRef({ transform });
  liveRef.current = { transform };

  /**
   * Where each Agent last stood.
   *
   * Written from the ticker, so it is the live position rather than the desk —
   * an Agent that wanders off and is then deleted should start its goodbye
   * from wherever it actually was, and one that is picked up should be lifted
   * from where it was standing rather than from its chair.
   */
  const lastPositions = useRef(new Map<string, WorldPoint>());
  useEffect(() => {
    // Seed from the placement, so an Agent deleted before its first drawn
    // frame still leaves from its own desk rather than from the origin.
    for (const { agent, anchor } of placed) {
      if (!lastPositions.current.has(agent.agentId)) {
        lastPositions.current.set(agent.agentId, { ...anchor });
      }
    }
  }, [placed]);

  const positionOf = useCallback(
    (agentId: string): WorldPoint | null => lastPositions.current.get(agentId) ?? null,
    [],
  );

  const reducedMotion = useReducedMotion();
  const departures = useDepartures({
    scopeId: viewModel.projectId ?? viewModel.id,
    agents: viewModel.agents,
    positionOf,
    // A goodbye is a flourish. Skipping it removes the Agent immediately,
    // which is the same outcome without the motion.
    enabled: !reducedMotion,
  });

  const handleAgentPosition = useCallback((agentId: string, x: number, y: number) => {
    lastPositions.current.set(agentId, { x, y });
    const plate = plateRefs.current.get(agentId);
    if (!plate) return;
    const { transform: live } = liveRef.current;
    plate.style.left = `${Math.round((x + PLATE_OFFSET.x) * live.scale)}px`;
    plate.style.top = `${Math.round((y + PLATE_OFFSET.y) * live.scale)}px`;
  }, []);

  const hover = useCallback((agentId: string | null) => {
    setHovered(agentId);
    if (agentId !== null) setRaised(agentId);
  }, []);

  const onFailure = useCallback(() => setRenderFailed(true), []);
  const canRender = supported && !renderFailed && size.width > 0 && size.height > 0;
  const overflow = viewModel.agents.length - MAX_SEATS;

  /** Which area an Agent occupies now, so a keyboard move starts from home. */
  const areaOf = useCallback(
    (agentId: string): DropTarget | null => {
      const entry = placed.find((candidate) => candidate.agent.agentId === agentId);
      if (!entry) return null;
      return entry.posting
        ? { kind: "station", station: entry.posting.station }
        : { kind: "desk", seatIndex: entry.seat.index };
    },
    [placed],
  );

  const handleDrop = useCallback(
    (agentId: string, target: DropTarget, at: WorldPoint) => {
      onPlaceAgent?.(seating, agentId, target, at);
    },
    [onPlaceAgent, seating],
  );

  const dragging = useAgentDrag({
    transform,
    hostRef,
    seats,
    enabled: canRender && onPlaceAgent !== undefined,
    positionOf,
    areaOf,
    onDrop: handleDrop,
  });
  const { drag, carry, justCarried } = dragging;
  const carriedAgent = drag
    ? placed.find((entry) => entry.agent.agentId === drag.agentId) ?? null
    : null;

  /**
   * What the move is doing, in words.
   *
   * The canvas can show a highlighted zone and a ring on the floor; neither of
   * those reaches anyone using a screen reader, and the zones have no drawn
   * names at all. One polite live region carries the same three facts: who is
   * being moved, where they would land, and how to finish.
   */
  const dragMessage = carriedAgent
    ? drag?.target
      ? `Moving ${carriedAgent.agent.name} to ${dropTargetLabel(drag.target)}.`
      : `Moving ${carriedAgent.agent.name}. No area under the pointer; releasing here puts them back.`
    : "";

  const handlePlateKeyDown = useCallback(
    (agentId: string, event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const carrying = drag?.agentId === agentId;
      if (event.key === " ") {
        // Space would otherwise fire the button's click and open the Agent.
        event.preventDefault();
        if (carrying) dragging.commit();
        else dragging.grabByKeyboard(agentId);
        return;
      }
      if (!carrying) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dragging.cancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        dragging.commit();
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        dragging.step(1);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        dragging.step(-1);
      }
    },
    [drag?.agentId, dragging],
  );

  return (
    <div className="ws-stage" ref={hostRef}>
      {canRender ? (
        <Suspense fallback={<div className="ws-stage-loading" role="status" aria-label="Loading the room" />}>
          <WorkspaceCanvas
            onFailure={onFailure}
            viewModel={viewModel}
            placed={placed}
            transform={transform}
            hoveredAgentId={hovered}
            replies={replies}
            perks={perks}
            crew={crew}
            departures={departures}
            carriedAgentId={drag?.agentId ?? null}
            carriedTarget={drag?.target ?? null}
            carry={carry}
            onGrabAgent={dragging.grab}
            onSelectAgent={onSelectAgent}
            onHoverAgent={hover}
            onOpenConversation={onOpenConversation}
            onOpenPreview={onOpenPreview}
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
        className={
          "ws-overlay " +
          (canRender ? "is-mapped" : "is-listed") +
          // While one plate is open it is the subject; the rest step back so
          // the overlap reads as depth rather than as two broken cards.
          (hovered === null ? "" : " is-focusing") +
          // Nothing in the overlay may swallow the pointer mid-carry: the
          // plates sit directly over the room the Agent is being moved across.
          (drag?.via === "pointer" ? " is-carrying" : "")
        }
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
        {/* The zones have no drawn names, so a move names them — and only
            during a move, when knowing what each partitioned room is called is
            suddenly the question. */}
        {canRender &&
          drag !== null &&
          POST_STATIONS.map((station) => {
            const zone = ZONES[POST_ZONES[station]];
            const point = worldToScreen(transform, {
              x: zone.x + zone.width / 2,
              y: zone.y + 7,
            });
            const active = drag.target?.kind === "station" && drag.target.station === station;
            return (
              <span
                key={station}
                className={"ws-drop-label" + (active ? " is-active" : "")}
                aria-hidden="true"
                style={{
                  left: point.x - transform.offsetX,
                  top: point.y - transform.offsetY,
                }}
              >
                {AREA_LABEL[station]}
              </span>
            );
          })}

        {placed.map(({ agent, anchor }) => {
          const descriptor = WORKSPACE_ACTIVITY[agent.activity];
          const point = worldToScreen(transform, {
            x: anchor.x + PLATE_OFFSET.x,
            y: anchor.y + PLATE_OFFSET.y,
          });
          const capacityLabel = agent.modelResource
            ? modelResourceCapacityLabel(agent.modelResource)
            : agent.modelAssigned
              ? "Quota unavailable"
              : "Model assignment required";
          const capacityCardId = `ws-capacity-${agent.agentId}`;
          const showCapacity = hovered === agent.agentId;
          const capacityPercent = modelResourceQuotaPercent(agent.modelResource);
          const capacityTone = modelResourceQuotaTone(agent.modelResource);
          const carrying = drag?.agentId === agent.agentId;
          // Desks sit closer together than a fully-written plate is wide, so a
          // plate states only its name at rest and opens its detail while it is
          // being pointed at or focused — and only then. Selection and the
          // current turn are persistent states, so letting either hold a plate
          // open would park a card permanently over its neighbour. They read
          // instead through the plate's own border. Everything stays in the
          // accessibility tree either way; only the drawn width changes.
          const expanded = showCapacity;
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
                (agent.isCurrentParticipant ? " is-active" : "") +
                (expanded ? " is-expanded" : "") +
                (carrying ? " is-carrying" : "") +
                (raised === agent.agentId ? " is-raised" : "")
              }
              data-tone={descriptor.tone}
              style={
                canRender
                  ? { left: point.x - transform.offsetX, top: point.y - transform.offsetY }
                  : undefined
              }
              aria-pressed={agent.isSelected}
              aria-describedby={showCapacity ? capacityCardId : undefined}
              aria-grabbed={carrying || undefined}
              title={capacityLabel}
              onPointerDown={
                onPlaceAgent
                  ? (event) => dragging.grab(agent.agentId, event)
                  : undefined
              }
              onKeyDown={
                onPlaceAgent ? (event) => handlePlateKeyDown(agent.agentId, event) : undefined
              }
              onClick={() => {
                // The press that just ended was a move, and a move is not also
                // a request to open the Agent's details.
                if (justCarried.current) {
                  justCarried.current = false;
                  return;
                }
                setRaised(agent.agentId);
                onSelectAgent(agent.agentId);
              }}
              onMouseEnter={() => hover(agent.agentId)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => hover(agent.agentId)}
              onBlur={() => {
                setHovered(null);
                // Focus is the only thing holding a keyboard move together.
                if (drag?.agentId === agent.agentId && drag.via === "keyboard") {
                  dragging.cancel();
                }
              }}
            >
              <span className="ws-plate-heading">
                <span className="ws-plate-dot" aria-hidden="true" />
                <span className="ws-plate-name">{agent.name}</span>
              </span>
              <span className={"ws-plate-state" + (expanded ? "" : " is-quiet")}>
                <span className="ws-plate-glyph" aria-hidden="true">{descriptor.glyph}</span>
                {descriptor.label}
                {agent.isCurrentParticipant ? " · this turn" : ""}
              </span>
              <span
                className={"ws-plate-resource" + (expanded ? "" : " is-quiet")}
                data-resource-tone={agent.modelResource?.endpointStatus ?? "unknown"}
                data-resource-freshness={agent.modelResource?.freshness ?? "unavailable"}
                data-resource-capacity-tone={capacityTone}
              >
                <span className="ws-plate-resource-glyph" aria-hidden="true">
                  {agent.modelResource
                    ? modelResourceStatusGlyph(agent.modelResource.endpointStatus)
                    : "?"}
                </span>
                {capacityLabel}
              </span>
              {capacityPercent !== null && expanded && (
                <span
                  className="ws-plate-capacity-bar"
                  data-resource-capacity-tone={capacityTone}
                  aria-hidden="true"
                >
                  <span
                    className="ws-plate-capacity-fill"
                    style={{ width: `${capacityPercent}%` }}
                  />
                </span>
              )}
              {showCapacity && (
                <span
                  className="ws-resource-capacity-card"
                  data-resource-capacity-tone={capacityTone}
                  role="tooltip"
                  id={capacityCardId}
                >
                  <span className="ws-resource-capacity-headline">{capacityLabel}</span>
                  {agent.modelResource && (
                    <>
                      <span className="ws-resource-capacity-detail">
                        {modelResourceQuotaLabel(agent.modelResource)}
                      </span>
                      {/* When the number was last confirmed matters more than
                          the number itself: the provider's free-pack counters
                          settle behind the run, so a percentage alone reads as
                          a live meter it is not. */}
                      <span className="ws-resource-capacity-detail">
                        {modelResourceObservedLabel(agent.modelResource)}
                      </span>
                    </>
                  )}
                </span>
              )}
            </button>
          );
        })}

      </div>

      {canRender && onPlaceAgent && (
        <p
          className={"ws-drag-hint" + (drag !== null ? " is-carrying" : "")}
          role="status"
          aria-live="polite"
        >
          {drag !== null
            ? dragMessage
            : "Drag an Agent to move them. With a name plate focused, press Space to pick up, arrows to choose an area, Space again to drop."}
        </p>
      )}

      {overflow > 0 && (
        <p className="ws-overflow" role="note">
          {overflow} more {overflow === 1 ? "Agent is" : "Agents are"} on this Workspace than the
          room seats. They are listed in the sidebar.
        </p>
      )}
    </div>
  );
}
