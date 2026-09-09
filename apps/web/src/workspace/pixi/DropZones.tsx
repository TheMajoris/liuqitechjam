import { useCallback, useRef, type RefObject } from "react";
import type { Container, Graphics } from "pixi.js";
import { useTick } from "@pixi/react";
import "./pixi-elements";
import { useReducedMotion } from "./use-reduced-motion";
import { SCENE } from "./scene-theme";
import {
  dropLandingPoint,
  dropTargets,
  sameDropTarget,
  type DropTarget,
  type WorldPoint,
} from "../workspace-layout";

interface DropZonesProps {
  /** Null when nothing is being carried; the layer draws nothing at all. */
  active: DropTarget | null;
  carrying: boolean;
  /** The live carry point, so the landing mark can follow without a render. */
  carry: RefObject<WorldPoint>;
}

/**
 * Where an Agent can be put down, shown only while one is in the air.
 *
 * Two statements, and no more: every place that will accept the Agent, drawn
 * faintly, and the one place it will actually land, drawn brightly with a mark
 * on the exact spot. The mark matters because a zone is floor rather than a
 * slot — an Agent dropped in the lounge stays in the corner you chose, so the
 * room has to show which corner that is before you let go.
 *
 * Drawn beneath the furniture layer, so a carried Agent passes over the top of
 * its own highlights instead of disappearing behind them.
 */
export function DropZones({ active, carrying, carry }: DropZonesProps) {
  const markRef = useRef<Container>(null);
  const glowRef = useRef<Container>(null);
  const reducedMotion = useReducedMotion();
  const clock = useRef(0);

  const draw = useCallback(
    (graphics: Graphics) => {
      graphics.clear();
      if (!carrying) return;
      for (const { target, rect } of dropTargets()) {
        const chosen = sameDropTarget(target, active);
        graphics.roundRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2, 4);
        if (chosen) {
          graphics
            .fill({ color: SCENE.purple, alpha: 0.16 })
            .roundRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2, 4)
            .stroke({ width: 1, color: SCENE.purple, alpha: 0.95 });
        } else {
          // Faint enough to be a hint rather than a grid, but present: the
          // whole point is that you can see where the Agent may go before you
          // have aimed at any of them.
          graphics
            .fill({ color: SCENE.white, alpha: 0.1 })
            .roundRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2, 4)
            .stroke({ width: 1, color: SCENE.ink, alpha: 0.16 });
        }
      }
    },
    [active, carrying],
  );

  /** The spot itself: a ring on the floor where the feet will land. */
  const drawMark = useCallback((graphics: Graphics) => {
    graphics
      .clear()
      .ellipse(0, 0, 11, 4)
      .fill({ color: SCENE.purple, alpha: 0.2 })
      .ellipse(0, 0, 11, 4)
      .stroke({ width: 1, color: SCENE.purple, alpha: 0.9 })
      .ellipse(0, 0, 4, 1.5)
      .fill({ color: SCENE.purple, alpha: 0.55 });
  }, []);

  useTick({
    isEnabled: carrying && active !== null,
    callback: (ticker) => {
      const mark = markRef.current;
      if (!mark || active === null) return;
      const landing = dropLandingPoint(active, carry.current);
      mark.x = landing.x;
      mark.y = landing.y;
      const glow = glowRef.current;
      if (!glow) return;
      if (reducedMotion) {
        glow.alpha = 1;
        return;
      }
      clock.current += ticker.deltaMS;
      // A slow breath, so the chosen area reads as live without flashing.
      glow.alpha = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin((clock.current / 780) * Math.PI * 2));
    },
  });

  if (!carrying) return null;

  return (
    <pixiContainer ref={glowRef}>
      <pixiGraphics draw={draw} />
      {active !== null && (
        <pixiContainer ref={markRef}>
          <pixiGraphics draw={drawMark} />
        </pixiContainer>
      )}
    </pixiContainer>
  );
}
