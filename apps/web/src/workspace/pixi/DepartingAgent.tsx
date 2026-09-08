import { useCallback, useMemo, useRef } from "react";
import type { Container, Graphics, Sprite } from "pixi.js";
import { useTick } from "@pixi/react";
import "./pixi-elements";
import {
  avatarLook,
  bodyTexture,
  faceTexture,
  figureHairTexture,
  figureOutfitTexture,
  type WorkspaceCrew,
} from "./art/avatar-look";
import { pixelTexture } from "./art/pixel-texture";
import {
  DEPARTURE_PALETTE,
  FACE_OFFSET,
  FIGURE_HAIR_OFFSET,
  FIGURE_OUTFIT_OFFSET,
  MOVING_BOX,
  PINK_SLIP,
} from "./art/sprites";
import { SCENE } from "./scene-theme";
import { exitRoute, type WorldPoint } from "../workspace-layout";
import {
  DEPARTURE_FADE_MS as FADE_MS,
  DEPARTURE_MS,
  DEPARTURE_NOTICE_MS as NOTICE_MS,
  DEPARTURE_PACK_MS as PACK_MS,
  type DepartingAgentModel,
} from "../departure";

export type { DepartingAgentModel };

const WALK_SPEED = 46;
const WALK_FRAME_MS = 150;

interface DepartingAgentProps {
  agent: DepartingAgentModel;
  crew: WorkspaceCrew;
}

/**
 * An Agent leaving the office.
 *
 * Purely a farewell: by the time this renders, the Agent is already gone from
 * every server record and from the view model. It animates a copy, owns no
 * state anyone else reads, and cannot delay or block the deletion that caused
 * it — if the renderer is unavailable or motion is reduced, the Agent simply
 * disappears, which is the same outcome without the ceremony.
 *
 * The sequence: the notice flutters down, they pack a box (with the desk
 * plant), and they walk out the door on the left.
 */
export function DepartingAgent({ agent, crew }: DepartingAgentProps) {
  const look = avatarLook(agent.agentId, agent.appearance);
  const containerRef = useRef<Container>(null);
  const bodyRef = useRef<Sprite>(null);
  const faceRef = useRef<Sprite>(null);
  const boxRef = useRef<Container>(null);
  const slipRef = useRef<Sprite>(null);
  const shadowRef = useRef<Graphics>(null);

  const position = useRef<WorldPoint>({ ...agent.from });
  const route = useRef<WorldPoint[]>([]);
  const routed = useRef(false);
  const clock = useRef(0);

  const boxTexture = useMemo(
    () => pixelTexture("departure:box", MOVING_BOX, DEPARTURE_PALETTE),
    [],
  );
  const slipTexture = useMemo(
    () => pixelTexture("departure:slip", PINK_SLIP, DEPARTURE_PALETTE),
    [],
  );
  const figureHair = crew === "robots"
    ? null
    : figureHairTexture(agent.agentId, agent.appearance);
  const figureOutfit = crew === "robots"
    ? null
    : figureOutfitTexture(agent.agentId, agent.appearance);

  useTick((ticker) => {
    const container = containerRef.current;
    if (!container) return;
    clock.current += ticker.deltaMS;
    const elapsed = performance.now() - agent.startedAt;
    const packing = elapsed >= NOTICE_MS;
    const walking = elapsed >= NOTICE_MS + PACK_MS;

    // The route is computed once, when they actually stand up to leave, so it
    // starts from where they were standing rather than from the desk they may
    // have wandered away from.
    if (walking && !routed.current) {
      routed.current = true;
      route.current = exitRoute(position.current);
    }

    let remaining = walking ? (WALK_SPEED * ticker.deltaMS) / 1000 : 0;
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
      if (dx !== 0) position.current.x += Math.sign(dx) * Math.min(remaining, Math.abs(dx));
      else position.current.y += Math.sign(dy) * Math.min(remaining, Math.abs(dy));
      remaining = 0;
    }

    const moving = walking && route.current.length > 0;
    const body = bodyRef.current;
    if (body) {
      const frame = moving
        ? Math.floor(clock.current / WALK_FRAME_MS) % 2 === 0
          ? "walkA"
          : "walkB"
        : "stand";
      const texture = bodyTexture(agent.agentId, frame, agent.appearance, crew);
      if (body.texture !== texture) body.texture = texture;
    }

    // Shoulders drop the moment the notice lands, and stay down.
    const slump = elapsed >= NOTICE_MS * 0.6 ? 1 : 0;
    container.x = Math.round(position.current.x);
    container.y = Math.round(position.current.y + slump);
    container.zIndex = Math.round(position.current.y) + 1;

    const face = faceRef.current;
    if (face) {
      const texture = faceTexture(
        agent.agentId,
        elapsed < NOTICE_MS ? "worried" : "neutral",
        agent.appearance,
        crew,
      );
      if (face.texture !== texture) face.texture = texture;
    }

    // The notice falls from above the head, wobbling like paper, and is put
    // away once it has been read.
    const slip = slipRef.current;
    if (slip) {
      const visible = elapsed < NOTICE_MS + 120;
      slip.visible = visible;
      if (visible) {
        const progress = Math.min(1, elapsed / NOTICE_MS);
        slip.y = -46 + progress * 18;
        slip.x = 4 + Math.sin(progress * Math.PI * 3) * 3;
        slip.alpha = elapsed < NOTICE_MS ? 1 : 1 - (elapsed - NOTICE_MS) / 120;
      }
    }

    // The box is picked up, so it rises into their arms rather than appearing.
    const box = boxRef.current;
    if (box) {
      box.visible = packing;
      if (packing) {
        const lift = Math.min(1, (elapsed - NOTICE_MS) / PACK_MS);
        box.y = -6 - lift * 8;
        box.alpha = Math.min(1, lift * 2);
      }
    }

    const shadow = shadowRef.current;
    if (shadow) shadow.alpha = moving ? 0.1 : 0.16;

    // Fade out over the last stretch, so leaving the frame is a departure
    // rather than a disappearance.
    const remainingMs = DEPARTURE_MS - elapsed;
    container.alpha = remainingMs < FADE_MS ? Math.max(0, remainingMs / FADE_MS) : 1;
  });

  const drawShadow = useCallback((graphics: Graphics) => {
    graphics.clear().ellipse(0, 0, 9, 3).fill({ color: SCENE.shadow, alpha: 0.16 });
  }, []);

  return (
    <pixiContainer
      ref={containerRef}
      x={agent.from.x}
      y={agent.from.y}
      // Nothing about a departure is interactive; the Agent is already gone.
      eventMode="none"
    >
      <pixiGraphics ref={shadowRef} draw={drawShadow} />
      <pixiSprite
        ref={bodyRef}
        texture={bodyTexture(agent.agentId, "stand", agent.appearance, crew)}
        anchor={{ x: 0.5, y: 1 }}
      />
      {figureOutfit && (
        <pixiSprite
          texture={figureOutfit}
          x={FIGURE_OUTFIT_OFFSET.x - 8}
          y={FIGURE_OUTFIT_OFFSET.y - 24}
        />
      )}
      {figureHair && (
        <pixiSprite
          texture={figureHair}
          x={FIGURE_HAIR_OFFSET.x - 8}
          y={FIGURE_HAIR_OFFSET.y - 24}
        />
      )}
      <pixiSprite
        ref={faceRef}
        texture={faceTexture(agent.agentId, "worried", agent.appearance, crew)}
        x={FACE_OFFSET.x - 8}
        y={FACE_OFFSET.y - 24}
      />
      {/* Held in front of the chest, so it covers the torso and reads as
          carried rather than as standing beside a box. */}
      <pixiContainer ref={boxRef} visible={false} y={-6}>
        <pixiSprite texture={boxTexture} x={-6} y={-9} />
      </pixiContainer>
      <pixiSprite ref={slipRef} texture={slipTexture} x={4} y={-46} visible={false} />
      <pixiGraphics
        draw={useCallback(
          (graphics: Graphics) => {
            graphics
              .clear()
              .ellipse(0, 0, 13, 5)
              .stroke({ width: 1, color: look.accent, alpha: 0.35 });
          },
          [look.accent],
        )}
      />
    </pixiContainer>
  );
}
