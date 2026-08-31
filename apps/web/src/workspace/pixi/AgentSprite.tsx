import { useCallback, useEffect, useRef } from "react";
import { Rectangle, type Container, type Graphics, type Sprite } from "pixi.js";
import { useTick } from "@pixi/react";
import "./pixi-elements";
import {
  accessoryTexture,
  avatarLook,
  bodyTexture,
  faceTexture,
  handsTexture,
} from "./art/avatar-look";
import { ACCESSORY_OFFSET, FACE_OFFSET, HANDS_OFFSET } from "./art/sprites";
import { agentPresentation } from "./agent-presentation";
import { useReducedMotion } from "./use-reduced-motion";
import { AgentIndicator } from "./AgentIndicator";
import { nextIdleAction, WANDER_INTERVAL_MS } from "./idle-behaviour";
import { SCENE } from "./scene-theme";
import {
  walkRoute,
  type WorkspaceSeat,
  type WorldPoint,
} from "../workspace-layout";
import type { WorkspaceAgentViewModel } from "../workspace-view-model";

/** Feet at the origin, so `y` doubles as the depth-sorting key. */
const HIT_AREA = new Rectangle(-10, -34, 20, 36);
const WALK_SPEED = 52;
const WALK_FRAME_MS = 150;
const CELEBRATION_MS = 1000;

interface AgentSpriteProps {
  agent: WorkspaceAgentViewModel;
  seat: WorkspaceSeat;
  hovered: boolean;
  onSelect: (agentId: string) => void;
  onHoverChange: (agentId: string | null) => void;
}

/**
 * One Agent in the room.
 *
 * All motion runs on the Pixi ticker against refs; React re-renders this
 * component only when the Agent's *logical* state changes, so animation never
 * costs a render and never costs a request. The state machine is deliberately
 * small: walk to a station, stand there, and play the pose the middleware's
 * activity implies.
 */
export function AgentSprite({
  agent,
  seat,
  hovered,
  onSelect,
  onHoverChange,
}: AgentSpriteProps) {
  const look = avatarLook(agent.agentId, agent.appearance);
  const presentation = agentPresentation(agent.activity);
  const reducedMotion = useReducedMotion();

  const containerRef = useRef<Container>(null);
  const bodyRef = useRef<Sprite>(null);
  const handsRef = useRef<Sprite>(null);
  const faceRef = useRef<Sprite>(null);
  const sleepBadgeRef = useRef<Container>(null);
  const pulseRef = useRef<Graphics>(null);

  const position = useRef<WorldPoint>({ ...seat.anchor });
  const route = useRef<WorldPoint[]>([]);
  const clock = useRef(0);
  const celebrateUntil = useRef(0);
  /** When the Agent last had something to do. Drives wander, then dozing. */
  const idleSince = useRef(performance.now());
  const nextWanderAt = useRef(0);
  const dozing = useRef(false);

  // `idle` is the only activity that decays into wandering and then sleep, so
  // every other activity resets the clock and wakes the Agent up.
  const isIdle = agent.activity === "idle";
  useEffect(() => {
    if (isIdle) {
      idleSince.current = performance.now();
      nextWanderAt.current = performance.now() + WANDER_INTERVAL_MS;
      return;
    }
    idleSince.current = performance.now();
    dozing.current = false;
  }, [isIdle, agent.station]);

  // A change of station — or of seat, when the roster grows — is the only
  // thing that makes an Agent walk. The route is recomputed from wherever the
  // Agent currently stands, so an interrupted walk resolves cleanly.
  useEffect(() => {
    const next = walkRoute(seat, position.current, agent.station);
    if (reducedMotion) {
      // Arrive rather than travel: the destination is the information.
      const destination = next.at(-1);
      if (destination) position.current = { ...destination };
      route.current = [];
      return;
    }
    route.current = next;
  }, [agent.station, reducedMotion, seat]);

  useEffect(() => {
    if (agent.activity === "success" && !reducedMotion) {
      celebrateUntil.current = performance.now() + CELEBRATION_MS;
    }
  }, [agent.activity, reducedMotion]);

  useTick((ticker) => {
    const container = containerRef.current;
    if (!container) return;
    clock.current += ticker.deltaMS;

    let remaining = (WALK_SPEED * ticker.deltaMS) / 1000;
    while (remaining > 0 && route.current.length > 0) {
      const target = route.current[0]!;
      const dx = target.x - position.current.x;
      const dy = target.y - position.current.y;
      const distance = Math.abs(dx) + Math.abs(dy);
      if (distance <= remaining) {
        position.current = { x: target.x, y: target.y };
        route.current = route.current.slice(1);
        remaining -= distance;
        continue;
      }
      // Legs are axis-aligned, so only one component moves at a time.
      if (dx !== 0) position.current.x += Math.sign(dx) * Math.min(remaining, Math.abs(dx));
      else position.current.y += Math.sign(dy) * Math.min(remaining, Math.abs(dy));
      remaining = 0;
    }

    // Idle life: drift around the pod for a while, then go and sleep. The
    // decision itself is a pure function, so the behaviour is unit-tested
    // rather than only observable by watching the room.
    if (!reducedMotion) {
      const now = performance.now();
      const action = nextIdleAction({
        isIdle,
        atDesk: agent.station === "desk",
        walking: route.current.length > 0,
        dozing: dozing.current,
        idleForMs: now - idleSince.current,
        now,
        nextWanderAt: nextWanderAt.current,
        wander: seat.wander,
        random: Math.random,
      });
      if (action.kind === "wander") {
        nextWanderAt.current = now + WANDER_INTERVAL_MS;
        route.current = [action.point];
      } else if (action.kind === "doze") {
        dozing.current = true;
        route.current = walkRoute(seat, position.current, "lounge");
      } else if (action.kind === "wake") {
        dozing.current = false;
        route.current = walkRoute(seat, position.current, agent.station);
      }
    }

    container.label = agent.name + '|' + agent.station + '|' + route.current.length + '|' + Math.round(position.current.x) + ',' + Math.round(position.current.y);
    const walking = route.current.length > 0;
    const asleep = dozing.current && !walking;
    const body = bodyRef.current;
    if (body) {
      const frame = walking
        ? Math.floor(clock.current / WALK_FRAME_MS) % 2 === 0
          ? "walkA"
          : "walkB"
        : "stand";
      const texture = bodyTexture(agent.agentId, frame, agent.appearance);
      if (body.texture !== texture) body.texture = texture;
    }

    const hands = handsRef.current;
    if (hands) {
      hands.visible = presentation.typing && !walking;
      if (hands.visible && !reducedMotion) {
        const texture = handsTexture(
          agent.agentId,
          Math.floor(clock.current / 130) % 2 === 0 ? "a" : "b",
          agent.appearance,
        );
        if (hands.texture !== texture) hands.texture = texture;
      }
    }

    let offsetY = presentation.slumped || asleep ? 1 : 0;
    if (!walking && !reducedMotion && presentation.breathing !== "none") {
      const period = asleep ? 3400 : presentation.breathing === "slow" ? 2600 : 1700;
      offsetY += Math.sin((clock.current / period) * Math.PI * 2) > 0 ? -1 : 0;
    }
    const celebrating = performance.now() < celebrateUntil.current;
    if (celebrating) {
      const progress = 1 - (celebrateUntil.current - performance.now()) / CELEBRATION_MS;
      offsetY -= Math.round(3 * Math.abs(Math.sin(progress * Math.PI * 2)));
    }

    container.x = Math.round(position.current.x);
    container.y = Math.round(position.current.y + offsetY);
    container.zIndex = Math.round(position.current.y);

    const face = faceRef.current;
    if (face) {
      const texture = faceTexture(
        agent.agentId,
        asleep ? "sleep" : presentation.face,
        agent.appearance,
      );
      if (face.texture !== texture) face.texture = texture;
    }
    const sleepBadge = sleepBadgeRef.current;
    if (sleepBadge) sleepBadge.visible = asleep;

    const pulse = pulseRef.current;
    if (pulse) {
      pulse.alpha = !agent.isSupervisorChoice
        ? 0
        : reducedMotion
          ? 0.5
          : 0.3 + 0.35 * (0.5 + 0.5 * Math.sin((clock.current / 900) * Math.PI * 2));
    }
  });

  const drawGround = useCallback(
    (graphics: Graphics) => {
      graphics.clear();
      graphics.ellipse(0, 0, 9, 3).fill({ color: SCENE.shadow, alpha: 0.16 });
      if (agent.isCurrentParticipant) {
        graphics
          .ellipse(0, 0, 13, 5)
          .stroke({ width: 2, color: look.accent, alpha: 0.9 })
          .ellipse(0, 0, 13, 5)
          .fill({ color: look.accent, alpha: 0.14 });
      }
      if (agent.isSelected) {
        graphics.ellipse(0, 0, 16, 6).stroke({ width: 1, color: SCENE.ink, alpha: 0.75 });
      } else if (hovered) {
        graphics.ellipse(0, 0, 16, 6).stroke({ width: 1, color: SCENE.ink, alpha: 0.32 });
      }
    },
    [agent.isCurrentParticipant, agent.isSelected, hovered, look.accent],
  );

  const drawPulse = useCallback(
    (graphics: Graphics) => {
      graphics.clear().ellipse(0, 0, 19, 7).stroke({ width: 1, color: look.accent });
    },
    [look.accent],
  );

  return (
    <pixiContainer
      ref={containerRef}
      x={seat.anchor.x}
      y={seat.anchor.y}
      alpha={presentation.dimmed || !agent.available ? 0.6 : 1}
      eventMode="static"
      cursor="pointer"
      hitArea={HIT_AREA}
      onPointerTap={() => onSelect(agent.agentId)}
      onPointerOver={() => onHoverChange(agent.agentId)}
      onPointerOut={() => onHoverChange(null)}
    >
      <pixiGraphics ref={pulseRef} draw={drawPulse} alpha={0} />
      <pixiGraphics draw={drawGround} />
      <pixiSprite
        ref={bodyRef}
        texture={bodyTexture(agent.agentId, "stand", agent.appearance)}
        anchor={{ x: 0.5, y: 1 }}
      />
      <pixiSprite
        texture={accessoryTexture(agent.agentId, agent.appearance)}
        x={ACCESSORY_OFFSET.x - 8}
        y={ACCESSORY_OFFSET.y - 24}
      />
      <pixiSprite
        ref={faceRef}
        texture={faceTexture(agent.agentId, presentation.face, agent.appearance)}
        x={FACE_OFFSET.x - 8}
        y={FACE_OFFSET.y - 24}
      />
      <pixiSprite
        ref={handsRef}
        texture={handsTexture(agent.agentId, "a", agent.appearance)}
        x={HANDS_OFFSET.x - 8}
        y={HANDS_OFFSET.y - 24}
        visible={false}
      />
      <pixiContainer y={-28}>
        <AgentIndicator kind={presentation.indicator} />
      </pixiContainer>
      <pixiContainer ref={sleepBadgeRef} y={-28} visible={false}>
        <AgentIndicator kind="sleep" />
      </pixiContainer>
    </pixiContainer>
  );
}
