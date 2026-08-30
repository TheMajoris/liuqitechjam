import { useCallback, useRef } from "react";
import type { Graphics } from "pixi.js";
import { useTick } from "@pixi/react";
import { useReducedMotion } from "./use-reduced-motion";
import "./pixi-elements";
import type { AgentIndicator as IndicatorKind } from "./agent-presentation";
import { SCENE } from "./scene-theme";

const BUBBLE = { width: 18, height: 12 } as const;

function bubbleColour(kind: IndicatorKind): number {
  if (kind === "alert") return SCENE.red;
  if (kind === "check") return SCENE.green;
  if (kind === "flask") return SCENE.amber;
  return SCENE.white;
}

function inkColour(kind: IndicatorKind): number {
  return kind === "alert" || kind === "check" || kind === "flask" ? SCENE.white : SCENE.ink;
}

/**
 * The badge above an Agent's head. It restates the activity a second way, so
 * status never depends on colour alone; the React roster states it a third
 * time in words.
 */
export function AgentIndicator({ kind }: { kind: IndicatorKind }) {
  const dotsRef = useRef<[Graphics | null, Graphics | null, Graphics | null]>([null, null, null]);
  const elapsed = useRef(0);
  const reducedMotion = useReducedMotion();

  const drawBubble = useCallback(
    (graphics: Graphics) => {
      graphics.clear();
      if (kind === "none") return;
      const x = -BUBBLE.width / 2;
      const y = -BUBBLE.height;
      graphics
        .roundRect(x, y - 1, BUBBLE.width, BUBBLE.height, 4)
        .fill({ color: SCENE.shadow, alpha: 0.12 })
        .roundRect(x, y, BUBBLE.width, BUBBLE.height, 4)
        .fill(bubbleColour(kind))
        .rect(-2, y + BUBBLE.height, 4, 3)
        .fill(bubbleColour(kind));

      const ink = inkColour(kind);
      const midY = y + BUBBLE.height / 2;
      switch (kind) {
        case "pause":
          graphics.rect(-3, midY - 3, 2, 6).fill(ink).rect(1, midY - 3, 2, 6).fill(ink);
          break;
        case "alert":
          graphics.rect(-1, midY - 4, 2, 5).fill(ink).rect(-1, midY + 2, 2, 2).fill(ink);
          break;
        case "check":
          graphics.rect(-4, midY, 2, 2).fill(ink).rect(-2, midY + 2, 2, 2).fill(ink)
            .rect(0, midY, 2, 2).fill(ink).rect(2, midY - 2, 2, 2).fill(ink)
            .rect(4, midY - 4, 2, 2).fill(ink);
          break;
        case "sleep":
          graphics.rect(-4, midY - 3, 8, 2).fill(ink).rect(-4, midY + 1, 8, 2).fill(ink)
            .rect(0, midY - 1, 2, 2).fill(ink);
          break;
        case "page":
          graphics.rect(-5, midY - 4, 10, 8).fill(SCENE.wallPanel)
            .rect(-3, midY - 2, 6, 1).fill(ink).rect(-3, midY, 6, 1).fill(ink)
            .rect(-3, midY + 2, 4, 1).fill(ink);
          break;
        case "flask":
          graphics.rect(-1, midY - 4, 2, 3).fill(ink).rect(-3, midY - 1, 6, 5).fill(ink)
            .rect(-2, midY + 1, 4, 2).fill(bubbleColour(kind));
          break;
        default:
          break;
      }
    },
    [kind],
  );

  const drawDot = useCallback((graphics: Graphics) => {
    graphics.clear().rect(-1, -1, 2, 2).fill(SCENE.ink);
  }, []);

  useTick({
    isEnabled: kind === "dots" && !reducedMotion,
    callback: (ticker) => {
      elapsed.current += ticker.deltaMS;
      for (let index = 0; index < 3; index += 1) {
        const dot = dotsRef.current[index];
        if (!dot) continue;
        const phase = elapsed.current / 260 - index * 0.55;
        dot.alpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(phase));
      }
    },
  });

  if (kind === "none") return null;

  return (
    <pixiContainer>
      <pixiGraphics draw={drawBubble} />
      {kind === "dots" &&
        [-5, 0, 5].map((offset, index) => (
          <pixiGraphics
            key={offset}
            ref={(node) => {
              dotsRef.current[index] = node;
            }}
            draw={drawDot}
            x={offset}
            y={-BUBBLE.height / 2}
          />
        ))}
    </pixiContainer>
  );
}
