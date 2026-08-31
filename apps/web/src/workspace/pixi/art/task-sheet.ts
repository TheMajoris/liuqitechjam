import type { Texture } from "pixi.js";
import { pixelTexture } from "./pixel-texture";
import { TASK_SHEET } from "./sprites";

const PALETTE = { k: "#8f8878", w: "#fbfaf7", a: "#b6ae9c" } as const;

/** The task sheet: on the board, and in flight during a handoff. */
export function sheetTexture(): Texture {
  return pixelTexture("sheet", TASK_SHEET, PALETTE);
}
