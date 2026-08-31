import { useCallback, useRef } from "react";
import type { Graphics, Sprite } from "pixi.js";
import { useTick } from "@pixi/react";
import { useReducedMotion } from "./use-reduced-motion";
import "./pixi-elements";
import { pixelTexture } from "./art/pixel-texture";
import { rotateRows, SCREEN_CODE, SCREEN_FRAME_COUNT, SCREEN_RESTING } from "./art/sprites";
import { DESK, type WorkspaceSeat } from "../workspace-layout";
import { SCENE } from "./scene-theme";

const SCREEN_PALETTE = { l: "#9fc0f5" } as const;
const RESTING_PALETTE = { l: "#606d84" } as const;
const SCREEN_FPS = 7;

const screenTextures = Array.from({ length: SCREEN_FRAME_COUNT }, (_, index) =>
  pixelTexture(`screen:${index}`, rotateRows(SCREEN_CODE, index * 3), SCREEN_PALETTE),
);
const restingTexture = pixelTexture("screen:resting", SCREEN_RESTING, RESTING_PALETTE);

interface DeskProps {
  seat: WorkspaceSeat;
  /** The Agent's colour, used only for the desk name-plate stripe. */
  accent: number;
  busy: boolean;
  dimmed: boolean;
}

/**
 * One workstation. The desk itself is static geometry; only the monitor
 * animates, and it swaps between four pre-built textures rather than
 * rebuilding geometry, so a busy room costs no per-frame draw calls.
 */
export function Desk({ seat, accent, busy, dimmed }: DeskProps) {
  const screenRef = useRef<Sprite>(null);
  const elapsed = useRef(0);
  const reducedMotion = useReducedMotion();

  const draw = useCallback(
    (graphics: Graphics) => {
      const { x, y } = seat.desk;
      const half = DESK.width / 2;
      const top = y - DESK.height / 2;
      graphics.clear();
      graphics
        .rect(x - half, y + 9, DESK.width, 3)
        .fill({ color: SCENE.shadow, alpha: 0.16 })
        .rect(x - half, top, DESK.width, 6)
        .fill(SCENE.deskTop)
        .rect(x - half, top + 6, DESK.width, DESK.height - 6)
        .fill(SCENE.desk)
        .rect(x - half, top + 5, DESK.width, 1)
        .fill(SCENE.deskShadow)
        // Name-plate stripe: the Agent's colour, repeated at its own desk.
        .rect(x - half + 2, y + 2, 10, 3)
        .fill(accent)
        // Keyboard, lying on the work surface in front of the Agent.
        .rect(x - 24, y - 9, 20, 4)
        .fill(SCENE.wallPanel)
        .rect(x - 24, y - 9, 20, 1)
        .fill(SCENE.white)
        // Monitor, offset to the side so it never covers the Agent.
        .rect(x + 14, y - 13, 4, 3)
        .fill(SCENE.monitorFrame)
        .rect(x + 4, y - 27, 24, 15)
        .fill(SCENE.monitorFrame)
        .rect(x + 5, y - 26, 22, 13)
        .fill(SCENE.monitor)
        .rect(x + 6, y - 25, 20, 11)
        .fill(busy ? SCENE.screenActive : SCENE.screenIdle);
    },
    [accent, busy, seat.desk],
  );

  useTick({
    isEnabled: busy && !reducedMotion,
    callback: (ticker) => {
      const screen = screenRef.current;
      if (!screen) return;
      elapsed.current += ticker.deltaMS;
      const frame = Math.floor((elapsed.current / 1000) * SCREEN_FPS) % SCREEN_FRAME_COUNT;
      const texture = screenTextures[frame];
      if (texture && screen.texture !== texture) screen.texture = texture;
    },
  });

  return (
    <pixiContainer alpha={dimmed ? 0.62 : 1}>
      <pixiGraphics draw={draw} />
      <pixiSprite
        ref={screenRef}
        texture={busy ? screenTextures[0]! : restingTexture}
        x={seat.desk.x + 7}
        y={seat.desk.y - 25}
      />
    </pixiContainer>
  );
}
