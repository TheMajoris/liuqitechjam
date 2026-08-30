import { useCallback, useRef } from "react";
import type { Container, Graphics } from "pixi.js";
import { useTick } from "@pixi/react";
import { useReducedMotion } from "./use-reduced-motion";
import "./pixi-elements";
import { sheetTexture } from "./art/task-sheet";
import { SCENE } from "./scene-theme";
import { BOARD, DOOR, PREVIEW_SCREEN } from "../workspace-layout";
import type {
  WorkspaceDoorState,
  WorkspacePreviewActivity,
} from "../workspace-view-model";

interface StationProps {
  onActivate: () => void;
  label: string;
}

/**
 * The shared board. It carries the Team's task and a card per reply, so the
 * middle of the room shows how far the conversation has actually got.
 */
export function BoardStation({
  replies,
  active,
  onActivate,
  label,
}: StationProps & { replies: number; active: boolean }) {
  const draw = useCallback(
    (graphics: Graphics) => {
      const { x, y, width, height } = BOARD;
      graphics.clear();
      graphics
        .roundRect(x - width / 2, y - height / 2 + 4, width, height, 4)
        .fill({ color: SCENE.shadow, alpha: 0.14 })
        .roundRect(x - width / 2, y - height / 2, width, height, 4)
        .fill(SCENE.boardFrame)
        .roundRect(x - width / 2 + 2, y - height / 2 + 2, width - 4, height - 4, 3)
        .fill(SCENE.board);
      if (active) {
        graphics
          .roundRect(x - width / 2 - 2, y - height / 2 - 2, width + 4, height + 4, 5)
          .stroke({ width: 1, color: SCENE.purple, alpha: 0.55 });
      }
      // One small card per reply, capped so a long conversation stays legible.
      const cards = Math.min(replies, 6);
      for (let index = 0; index < cards; index += 1) {
        const cardX = x - 30 + (index % 3) * 22;
        const cardY = y - 8 + Math.floor(index / 3) * 12;
        graphics
          .rect(cardX, cardY, 16, 9)
          .fill(SCENE.sheet)
          .rect(cardX + 2, cardY + 2, 10, 1)
          .fill(SCENE.sheetLine)
          .rect(cardX + 2, cardY + 5, 7, 1)
          .fill(SCENE.sheetLine);
      }
    },
    [active, replies],
  );

  return (
    <pixiContainer
      zIndex={BOARD.y + BOARD.height / 2}
      eventMode="static"
      cursor="pointer"
      onPointerTap={onActivate}
      label={label}
    >
      <pixiGraphics draw={draw} />
      <pixiSprite texture={sheetTexture()} x={BOARD.x + 26} y={BOARD.y - 12} />
    </pixiContainer>
  );
}

/**
 * The shared Preview, mounted where everyone can see it. It mirrors the
 * Project preview runtime's status and nothing else.
 */
export function PreviewStation({
  status,
  onActivate,
  label,
}: StationProps & { status: WorkspacePreviewActivity }) {
  const barRef = useRef<Container>(null);
  const elapsed = useRef(0);
  const reducedMotion = useReducedMotion();
  const running = status === "running";
  const starting = status === "starting" || status === "stopping";

  const draw = useCallback(
    (graphics: Graphics) => {
      const { x, y, width, height } = PREVIEW_SCREEN;
      const left = x - width / 2;
      const top = y - height / 2;
      graphics.clear();
      graphics
        .roundRect(left - 3, top - 3, width + 6, height + 6, 3)
        .fill(SCENE.monitorFrame)
        .rect(left, top, width, height)
        .fill(running ? 0x223049 : SCENE.monitor)
        .rect(x - 5, y + height / 2 + 3, 10, 4)
        .fill(SCENE.monitorFrame);

      if (running) {
        graphics
          .rect(left + 4, top + 4, width - 8, 5)
          .fill(0x3d5480)
          .rect(left + 4, top + 13, 18, height - 21)
          .fill(0x33456b)
          .rect(left + 26, top + 13, width - 30, 8)
          .fill(0x4a679e)
          .rect(left + 26, top + 25, width - 38, 5)
          .fill(0x3d5480)
          .rect(left + 26, top + 33, width - 46, 5)
          .fill(0x3d5480);
      } else if (status === "failed" || status === "interrupted") {
        graphics
          .rect(x - 2, top + 8, 4, 14)
          .fill(SCENE.red)
          .rect(x - 2, top + 25, 4, 4)
          .fill(SCENE.red);
      } else if (!starting) {
        graphics.rect(x - 8, y - 1, 16, 2).fill(SCENE.muted);
      }
    },
    [running, starting, status],
  );

  const drawBar = useCallback((graphics: Graphics) => {
    graphics.clear().rect(0, 0, 14, 3).fill(SCENE.screenActive);
  }, []);

  useTick({
    isEnabled: starting && !reducedMotion,
    callback: (ticker) => {
      const bar = barRef.current;
      if (!bar) return;
      elapsed.current += ticker.deltaMS;
      const span = PREVIEW_SCREEN.width - 22;
      const progress = (elapsed.current / 1200) % 2;
      bar.x =
        PREVIEW_SCREEN.x - PREVIEW_SCREEN.width / 2 + 4 +
        Math.round(span * (progress > 1 ? 2 - progress : progress));
    },
  });

  return (
    <pixiContainer eventMode="static" cursor="pointer" onPointerTap={onActivate} label={label}>
      <pixiGraphics draw={draw} />
      {starting && (
        <pixiContainer ref={barRef} y={PREVIEW_SCREEN.y - 2}>
          <pixiGraphics draw={drawBar} />
        </pixiContainer>
      )}
    </pixiContainer>
  );
}

const DOOR_LAMP: Record<WorkspaceDoorState, number> = {
  dormant: SCENE.muted,
  locked: SCENE.muted,
  waiting: SCENE.amber,
  open: SCENE.green,
  denied: SCENE.red,
};

/**
 * The permission boundary, drawn as a door.
 *
 * It is a *picture* of a decision the Authorization and Permit layers already
 * made. Nothing here grants, withholds, or checks anything: when approvals are
 * not configured the door simply stays shut and dormant.
 */
export function AccessDoor({
  state,
  onActivate,
  label,
}: StationProps & { state: WorkspaceDoorState }) {
  const lampRef = useRef<Graphics>(null);
  const elapsed = useRef(0);
  const reducedMotion = useReducedMotion();
  const ajar = state === "open";

  const draw = useCallback(
    (graphics: Graphics) => {
      const { x, y, width, height } = DOOR;
      const left = x - width / 2;
      const top = y - height / 2;
      graphics.clear();
      graphics
        .rect(left - 3, top - 3, width + 6, height + 6)
        .fill(SCENE.doorFrame)
        .rect(left, top, width, height)
        .fill(ajar ? 0x2b2f38 : SCENE.doorPanel);
      if (ajar) {
        // The door stands open: a slab of daylight falls across the floor.
        graphics
          .rect(left, top, width - 10, height)
          .fill(SCENE.doorPanel)
          .rect(left + width - 10, top + 4, 8, height - 8)
          .fill(0x151821)
          .rect(left + 2, top + height, width, 8)
          .fill({ color: SCENE.white, alpha: 0.22 });
      } else {
        graphics
          .rect(left + 4, top + 5, width - 8, height - 18)
          .fill({ color: SCENE.shadow, alpha: 0.12 })
          .rect(left + width - 9, y + 2, 3, 4)
          .fill(SCENE.doorHandle);
      }
      // Threshold mat, so the boundary reads as a place you can stand.
      graphics.roundRect(x - 14, y + height / 2 + 4, 28, 8, 2).fill(SCENE.wallShadow);
    },
    [ajar],
  );

  const drawLamp = useCallback(
    (graphics: Graphics) => {
      graphics.clear();
      graphics
        .circle(0, 0, 3)
        .fill(DOOR_LAMP[state])
        .circle(0, 0, 3)
        .stroke({ width: 1, color: SCENE.doorFrame });
    },
    [state],
  );

  useTick({
    isEnabled: state === "waiting" && !reducedMotion,
    callback: (ticker) => {
      const lamp = lampRef.current;
      if (!lamp) return;
      elapsed.current += ticker.deltaMS;
      lamp.alpha = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin((elapsed.current / 700) * Math.PI * 2));
    },
  });

  return (
    <pixiContainer eventMode="static" cursor="pointer" onPointerTap={onActivate} label={label}>
      <pixiGraphics draw={draw} />
      <pixiGraphics
        ref={lampRef}
        draw={drawLamp}
        x={DOOR.x}
        y={DOOR.y - DOOR.height / 2 - 8}
        alpha={state === "dormant" ? 0.4 : 1}
      />
    </pixiContainer>
  );
}
