import { useEffect, useMemo, useRef } from "react";
import type { Container } from "pixi.js";
import { useApplication } from "@pixi/react";
import "./pixi-elements";
import { AgentSprite } from "./AgentSprite";
import { Desk } from "./Desk";
import { HandoffToken } from "./HandoffToken";
import { AccessDoor, BoardStation, PreviewStation } from "./Stations";
import { Room } from "./Room";
import { avatarLook } from "./art/avatar-look";
import { agentPresentation } from "./agent-presentation";
import type { StageTransform, WorkspaceSeat } from "../workspace-layout";
import { DOOR_STATE_LABEL, PREVIEW_ACTIVITY_LABEL } from "../workspace-view-model";
import type { WorkspaceViewModel } from "../workspace-view-model";

export interface WorkspaceSceneProps {
  viewModel: WorkspaceViewModel;
  seats: WorkspaceSeat[];
  transform: StageTransform;
  hoveredAgentId: string | null;
  replies: number;
  onSelectAgent: (agentId: string) => void;
  onHoverAgent: (agentId: string | null) => void;
  onOpenConversation: () => void;
  onOpenPreview: () => void;
  onOpenApprovals: () => void;
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
  seats,
  transform,
  hoveredAgentId,
  replies,
  onSelectAgent,
  onHoverAgent,
  onOpenConversation,
  onOpenPreview,
  onOpenApprovals,
}: WorkspaceSceneProps) {
  const seated = useMemo(
    () => viewModel.agents.slice(0, seats.length).map((agent, index) => ({
      agent,
      seat: seats[index]!,
    })),
    [seats, viewModel.agents],
  );

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
      seated.find((entry) => entry.agent.agentId === agentId)?.seat ?? null;
    const fromSeat = seatFor(handoff.fromAgentId);
    const toSeat = seatFor(handoff.toAgentId);
    return {
      from: fromSeat ? { x: fromSeat.desk.x, y: fromSeat.desk.y - 14 } : null,
      to: toSeat ? { x: toSeat.desk.x, y: toSeat.desk.y - 14 } : null,
    };
  }, [handoff, seated]);

  return (
    <pixiContainer ref={rootRef}>
      <Room />
      <PreviewStation
        status={viewModel.previewStatus}
        onActivate={onOpenPreview}
        label={`Shared preview — ${PREVIEW_ACTIVITY_LABEL[viewModel.previewStatus]}`}
      />
      <AccessDoor
        state={viewModel.doorState}
        onActivate={onOpenApprovals}
        label={DOOR_STATE_LABEL[viewModel.doorState]}
      />

      {/* One sorted layer, so walking in front of furniture just works. */}
      <pixiContainer sortableChildren>
        <BoardStation
          replies={replies}
          active={viewModel.orchestrationStatus === "running"}
          onActivate={onOpenConversation}
          label="Shared board — open the conversation"
        />
        {seated.map(({ agent, seat }) => (
          <pixiContainer key={`desk-${agent.agentId}`} zIndex={seat.desk.y + 11}>
            <Desk
              seat={seat}
              accent={avatarLook(agent.agentId).accent}
              busy={BUSY_ACTIVITIES.has(agent.activity)}
              dimmed={agentPresentation(agent.activity).dimmed}
            />
          </pixiContainer>
        ))}
        {seated.map(({ agent, seat }) => (
          <AgentSprite
            key={agent.agentId}
            agent={agent}
            seat={seat}
            hovered={hoveredAgentId === agent.agentId}
            onSelect={onSelectAgent}
            onHoverChange={onHoverAgent}
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
