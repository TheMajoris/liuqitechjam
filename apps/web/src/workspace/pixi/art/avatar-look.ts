import type { Texture } from "pixi.js";
import type { AgentAppearance } from "../../../types";
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
 * An Agent's appearance is derived from its ID unless it has been customized.
 *
 * The ID-derived look is the default, so an Agent nobody has styled still has
 * a stable character in every browser with nothing stored. A saved
 * `AgentAppearance` overrides field by field, so choosing a hat keeps the hair
 * and skin the Agent already had.
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

export const HAIR_COUNT = HAIR.length;
export const SKIN_COUNT = SKIN.length;

/** The look an Agent has when nobody has customized it. */
export function defaultAppearance(agentId: string): Required<AgentAppearance> {
  return {
    hue: agentHue(agentId),
    hair: hash(agentId, 7) % HAIR.length,
    skin: hash(agentId, 31) % SKIN.length,
    accessory: ACCESSORY_ORDER[hash(agentId, 97) % ACCESSORY_ORDER.length]!,
  };
}

/** Merge a saved appearance over the ID-derived default. */
export function resolveAppearance(
  agentId: string,
  appearance: AgentAppearance | null | undefined,
): Required<AgentAppearance> {
  const base = defaultAppearance(agentId);
  if (!appearance) return base;
  return {
    hue: appearance.hue ?? base.hue,
    hair: appearance.hair ?? base.hair,
    skin: appearance.skin ?? base.skin,
    accessory: appearance.accessory ?? base.accessory,
  };
}

const lookCache = new Map<string, AvatarLook>();

/** Cache key covers every visible choice, so an edit repaints immediately. */
function lookKey(agentId: string, resolved: Required<AgentAppearance>): string {
  return `${agentId}:${resolved.hue}:${resolved.hair}:${resolved.skin}:${resolved.accessory}`;
}

export function avatarLook(
  agentId: string,
  appearance?: AgentAppearance | null,
): AvatarLook {
  const resolved = resolveAppearance(agentId, appearance);
  const key = lookKey(agentId, resolved);
  const cached = lookCache.get(key);
  if (cached) return cached;
  const hue = resolved.hue;
  const hair = HAIR[resolved.hair % HAIR.length]!;
  const skin = SKIN[resolved.skin % SKIN.length]!;
  const accessory = resolved.accessory;
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
  lookCache.set(key, look);
  return look;
}

/** Texture cache keys include the look, so a restyle never reuses old pixels. */
function textureKey(
  kind: string,
  agentId: string,
  variant: string,
  appearance: AgentAppearance | null | undefined,
): string {
  const resolved = resolveAppearance(agentId, appearance);
  return `${kind}:${agentId}:${variant}:${resolved.hue}:${resolved.hair}:${resolved.skin}`;
}

export function bodyTexture(
  agentId: string,
  body: AvatarBody,
  appearance?: AgentAppearance | null,
): Texture {
  return pixelTexture(
    textureKey("body", agentId, body, appearance),
    AVATAR_BODIES[body],
    avatarLook(agentId, appearance).palette,
  );
}

export function faceTexture(
  agentId: string,
  face: AvatarFace,
  appearance?: AgentAppearance | null,
): Texture {
  return pixelTexture(
    textureKey("face", agentId, face, appearance),
    AVATAR_FACES[face],
    avatarLook(agentId, appearance).palette,
  );
}

export function handsTexture(
  agentId: string,
  hands: AvatarHands,
  appearance?: AgentAppearance | null,
): Texture {
  return pixelTexture(
    textureKey("hands", agentId, hands, appearance),
    AVATAR_HANDS[hands],
    avatarLook(agentId, appearance).palette,
  );
}

export function accessoryTexture(
  agentId: string,
  appearance?: AgentAppearance | null,
): Texture {
  const look = avatarLook(agentId, appearance);
  return pixelTexture(
    textureKey("accessory", agentId, look.accessory, appearance),
    AVATAR_ACCESSORIES[look.accessory],
    look.palette,
  );
}
