import { useEffect, useRef } from "react";
import type { Container } from "pixi.js";
import { useTick } from "@pixi/react";
import "./pixi-elements";
import { sheetTexture } from "./art/task-sheet";
import type { WorldPoint } from "../workspace-layout";

const TRAVEL_MS = 900;

interface HandoffTokenProps {
  /** Changing this id is what plays the animation, exactly once. */
  handoffId: string | null;
  from: WorldPoint | null;
  to: WorldPoint | null;
}

/**
 * The work itself, moving between desks.
 *
 * Driven only by a real `handoff_applied` event: a new event id starts one
 * flight, and nothing replays it. If the event carries an Agent the room does
 * not seat, the token simply never appears.
 */
export function HandoffToken({ handoffId, from, to }: HandoffTokenProps) {
  const containerRef = useRef<Container>(null);
  const startedAt = useRef<number | null>(null);
  const played = useRef<string | null>(null);

  useEffect(() => {
    if (!handoffId || !from || !to) return;
    if (played.current === handoffId) return;
    played.current = handoffId;
    startedAt.current = performance.now();
  }, [from, handoffId, to]);

  useTick(() => {
    const container = containerRef.current;
    if (!container) return;
    if (startedAt.current === null || !from || !to) {
      container.visible = false;
      return;
    }
    const progress = (performance.now() - startedAt.current) / TRAVEL_MS;
    if (progress >= 1) {
      startedAt.current = null;
      container.visible = false;
      return;
    }
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - 2 * (1 - progress) ** 2;
    container.visible = true;
    container.x = Math.round(from.x + (to.x - from.x) * eased);
    // A shallow arc reads as "carried across" rather than "teleported".
    container.y = Math.round(
      from.y + (to.y - from.y) * eased - 18 * Math.sin(eased * Math.PI),
    );
    container.zIndex = 900;
    container.alpha = progress > 0.85 ? (1 - progress) / 0.15 : 1;
  });

  return (
    <pixiContainer ref={containerRef} visible={false}>
      <pixiSprite texture={sheetTexture()} anchor={{ x: 0.5, y: 0.5 }} />
    </pixiContainer>
  );
}
