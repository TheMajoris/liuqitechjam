import type { Texture } from "pixi.js";
import { agentHue } from "../../../components/orchestration/orchestration-utils";
import { pixelTexture, type PixelPalette } from "./pixel-texture";
import {
  ACCESSORY_ORDER,
  AVATAR_ACCESSORIES,
  AVATAR_BODIES,
  AVATAR_FACES,
  AVATAR_HANDS,
  type AvatarAccessory,
  type AvatarBody,
  type AvatarFace,
  type AvatarHands,
} from "./sprites";

/**
 * Every Agent's appearance is derived from its ID, so the same Agent always
 * looks the same, in every browser, with no artwork to author or store. The
 * shirt hue is the one the rest of the product already uses for that Agent,
 * so a face in the room matches its avatar in the conversation.
 */
export interface AvatarLook {
  hue: number;
  accessory: AvatarAccessory;
  /** Shirt colour as a Pixi-friendly number, reused for rings and badges. */
  accent: number;
  palette: PixelPalette;
}

const HAIR: ReadonlyArray<readonly [string, string]> = [
  ["#2f2a26", "#4a4139"],
  ["#5b3a24", "#7a5333"],
  ["#8d5a2b", "#b07c45"],
  ["#c9a227", "#e3c05a"],
  ["#7e4a55", "#a56975"],
  ["#40484f", "#5d666e"],
];

const SKIN: ReadonlyArray<readonly [string, string]> = [
  ["#f2c9a6", "#d9a97f"],
  ["#e0ab80", "#c08a5e"],
  ["#c08b5f", "#9f6c44"],
  ["#8d5b3a", "#6f4429"],
];

function hash(value: string, seed: number): number {
  let result = seed;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 33 + value.charCodeAt(index)) % 100_003;
  }
  return result;
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

/** Convert the shirt hue to the numeric colour Pixi Graphics expects. */
function hueToNumber(hue: number, saturation: number, lightness: number): number {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  const sector = Math.floor(hue / 60) % 6;
  const points: ReadonlyArray<readonly [number, number, number]> = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ];
  const [red, green, blue] = points[sector] ?? points[0]!;
  const channel = (value: number) => Math.round((value + match) * 255);
  return (channel(red) << 16) + (channel(green) << 8) + channel(blue);
}

const lookCache = new Map<string, AvatarLook>();

export function avatarLook(agentId: string): AvatarLook {
  const cached = lookCache.get(agentId);
  if (cached) return cached;
  const hue = agentHue(agentId);
  const hair = HAIR[hash(agentId, 7) % HAIR.length]!;
  const skin = SKIN[hash(agentId, 31) % SKIN.length]!;
  const accessory = ACCESSORY_ORDER[hash(agentId, 97) % ACCESSORY_ORDER.length]!;
  const look: AvatarLook = {
    hue,
    accessory,
    accent: hueToNumber(hue, 52, 56),
    palette: {
      k: hsl(hue, 24, 16),
      h: hair[0],
      H: hair[1],
      s: skin[0],
      S: skin[1],
      c: hsl(hue, 48, 54),
      C: hsl(hue, 44, 42),
      a: hsl(hue, 58, 72),
      p: "#3c4250",
      b: "#242833",
      e: hsl(hue, 24, 16),
      m: hsl(hue, 20, 30),
      w: "#dfe7f2",
      g: "#4f8a5c",
    },
  };
  lookCache.set(agentId, look);
  return look;
}

export function bodyTexture(agentId: string, body: AvatarBody): Texture {
  return pixelTexture(`body:${agentId}:${body}`, AVATAR_BODIES[body], avatarLook(agentId).palette);
}

export function faceTexture(agentId: string, face: AvatarFace): Texture {
  return pixelTexture(`face:${agentId}:${face}`, AVATAR_FACES[face], avatarLook(agentId).palette);
}

export function handsTexture(agentId: string, hands: AvatarHands): Texture {
  return pixelTexture(`hands:${agentId}:${hands}`, AVATAR_HANDS[hands], avatarLook(agentId).palette);
}

export function accessoryTexture(agentId: string): Texture {
  const look = avatarLook(agentId);
  return pixelTexture(
    `accessory:${agentId}:${look.accessory}`,
    AVATAR_ACCESSORIES[look.accessory],
    look.palette,
  );
}
