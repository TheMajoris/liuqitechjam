import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { Container, FederatedPointerEvent } from "pixi.js";
import { useApplication } from "@pixi/react";
import "./pixi-elements";
import { AgentSprite } from "./AgentSprite";
import { Desk, DeskChair } from "./Desk";
import { DropZones } from "./DropZones";
import { HandoffToken } from "./HandoffToken";
import { BoardStation, PreviewStation } from "./Stations";
import { DepartingAgent, type DepartingAgentModel } from "./DepartingAgent";
import { Perks } from "./Perks";
import { Room } from "./Room";
import { avatarLook, type WorkspaceCrew } from "./art/avatar-look";
import type { PerkId } from "./art/perks";
import { agentPresentation } from "./agent-presentation";
import {
  officeSeats,
  type DropTarget,
  type StageTransform,
  type WorldPoint,
} from "../workspace-layout";
import type { PlacedAgent } from "../workspace-placement";
import { PREVIEW_ACTIVITY_LABEL } from "../workspace-view-model";
import type { WorkspaceViewModel } from "../workspace-view-model";

export interface WorkspaceSceneProps {
  viewModel: WorkspaceViewModel;
  /** The seated roster, already placed. The stage decides who sits where. */
  placed: readonly PlacedAgent[];
  transform: StageTransform;
  hoveredAgentId: string | null;
  replies: number;
  /** The Agent currently in the air, if any, and where it would land. */
  carriedAgentId?: string | null;
  carriedTarget?: DropTarget | null;
  carry?: RefObject<WorldPoint>;
  onGrabAgent?: (agentId: string, event: FederatedPointerEvent) => void;
  onSelectAgent: (agentId: string) => void;
  onHoverAgent: (agentId: string | null) => void;
  onOpenConversation: () => void;
  onOpenPreview: () => void;
  /** Optional office furniture. Cosmetic, and never a station. */
  perks?: ReadonlySet<PerkId>;
  /** People or robots. One choice for the whole room. */
  crew?: WorkspaceCrew;
  /** Agents that have already been removed, on their way out the door. */
  departures?: readonly DepartingAgentModel[];
  /** Reports where an Agent currently stands, so its HTML plate can follow. */
  onAgentPosition?: (agentId: string, x: number, y: number) => void;
}

const BUSY_ACTIVITIES = new Set(["working", "reviewing", "testing", "thinking"]);

/**
 * The room's object graph.
 *
 * Everything below this point is a projection: the scene reads a
 * `WorkspaceViewModel` and draws it. It issues no requests, holds no
 * authority, and every control it offers calls back into React, which calls
 * the existing APIs.
 */
export function WorkspaceScene({
  viewModel,
  placed,
  transform,
  hoveredAgentId,
  replies,
  carriedAgentId = null,
  carriedTarget = null,
  carry,
  onGrabAgent,
  onSelectAgent,
  onHoverAgent,
  onOpenConversation,
  onOpenPreview,
  perks,
  crew = "people",
  departures,
  onAgentPosition,
}: WorkspaceSceneProps) {
  /** The built office, with whoever happens to be sitting at each desk. */
  const workstations = useMemo(() => {
    const occupants = new Map(placed.map((entry) => [entry.seat.index, entry.agent]));
    return officeSeats().map((seat) => ({ seat, agent: occupants.get(seat.index) ?? null }));
  }, [placed]);

  const rootRef = useRef<Container>(null);
  const { app, isInitialised } = useApplication();

  /*
   * One effect owns the whole stage transform.
   *
   * The renderer is resized from the size React measured rather than from
   * Pixi's own `resizeTo`, because the container can change size without the
   * window doing so — collapsing the sidebar, for one. Position and scale are
   * set through the display object because `position.set`/`scale.set` are what
   * mark Pixi's transform dirty; assigning them as props does not.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isInitialised || !app.renderer) return;
    if (app.renderer.width !== transform.width || app.renderer.height !== transform.height) {
      app.renderer.resize(transform.width, transform.height);
    }
    root.position.set(transform.offsetX, transform.offsetY);
    root.scale.set(transform.scale);
  }, [
    app,
    isInitialised,
    transform.height,
    transform.offsetX,
    transform.offsetY,
    transform.scale,
    transform.width,
  ]);

  const handoff = viewModel.latestHandoff;
  const handoffPoints = useMemo(() => {
    if (!handoff) return { from: null, to: null };
    const seatFor = (agentId: string | null) =>
      placed.find((entry) => entry.agent.agentId === agentId)?.seat ?? null;
    const fromSeat = seatFor(handoff.fromAgentId);
    const toSeat = seatFor(handoff.toAgentId);
    return {
      from: fromSeat ? { x: fromSeat.desk.x, y: fromSeat.desk.y - 14 } : null,
      to: toSeat ? { x: toSeat.desk.x, y: toSeat.desk.y - 14 } : null,
    };
  }, [handoff, placed]);

  return (
    <pixiContainer ref={rootRef}>
      <Room />
      {perks && <Perks enabled={perks} />}
      <PreviewStation
        status={viewModel.previewStatus}
        onActivate={onOpenPreview}
        label={`Shared preview — ${PREVIEW_ACTIVITY_LABEL[viewModel.previewStatus]}`}
      />
      {/* Painted on the floor, under the furniture and under the Agent being
          carried over it — which is where a marking on the floor belongs. */}
      {carry && (
        <DropZones active={carriedTarget} carrying={carriedAgentId !== null} carry={carry} />
      )}
      {/* One sorted layer, so walking in front of furniture just works. */}
      <pixiContainer sortableChildren>
        <BoardStation
          replies={replies}
          active={viewModel.orchestrationStatus === "running"}
          onActivate={onOpenConversation}
          label="Shared board — open the conversation"
        />
        {/* Every workstation is furnished, occupied or not: an office with
            nobody in it is still an office. The chair sits behind whoever is
            using it and the desk in front, so each takes its own depth. */}
        {workstations.map(({ seat }) => (
          <pixiContainer key={`chair-${seat.index}`} zIndex={seat.anchor.y - 2}>
            <DeskChair seat={seat} />
          </pixiContainer>
        ))}
        {workstations.map(({ seat, agent }) => (
          <pixiContainer key={`desk-${seat.index}`} zIndex={seat.desk.y + 11}>
            <Desk
              seat={seat}
              accent={agent ? avatarLook(agent.agentId).accent : 0}
              busy={agent ? BUSY_ACTIVITIES.has(agent.activity) : false}
              dimmed={agent ? agentPresentation(agent.activity).dimmed : false}
              occupied={agent !== null}
            />
          </pixiContainer>
        ))}
        {placed.map(({ agent, seat, anchor, station }) => (
          <AgentSprite
            key={agent.agentId}
            agent={agent}
            seat={seat}
            anchor={anchor}
            station={station}
            hovered={hoveredAgentId === agent.agentId}
            carried={carriedAgentId === agent.agentId}
            crew={crew}
            onSelect={onSelectAgent}
            onHoverChange={onHoverAgent}
            {...(carry ? { carry } : {})}
            {...(onGrabAgent ? { onGrab: onGrabAgent } : {})}
            {...(onAgentPosition ? { onPositionChange: onAgentPosition } : {})}
          />
        ))}
        {/* Drawn in the same sorted layer as the seated Agents so someone
            leaving passes in front of and behind furniture correctly. They own
            no seat and take no part in the roster. */}
        {departures?.map((departure) => (
          <DepartingAgent
            key={departure.agentId + ":" + departure.startedAt}
            agent={departure}
            crew={crew}
          />
        ))}
        <HandoffToken
          handoffId={handoff?.id ?? null}
          from={handoffPoints.from}
          to={handoffPoints.to}
        />
      </pixiContainer>
    </pixiContainer>
  );
}
