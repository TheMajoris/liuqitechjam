import type { AgentAccessory, AgentAppearance, AgentFigure } from "./types.js";

/** Mirrors the client's accessory sprite set. */
export const AGENT_ACCESSORIES: readonly AgentAccessory[] = [
  "none",
  "glasses",
  "headset",
  "cap",
];

/** Mirrors the client's figure overlays. */
export const AGENT_FIGURES: readonly AgentFigure[] = [
  "neutral",
  "feminine",
  "masculine",
];

/** Palette sizes the client renders. An out-of-range index is dropped. */
export const APPEARANCE_LIMITS = {
  hairCount: 6,
  skinCount: 4,
  maxHue: 359,
} as const;

function paletteIndex(value: unknown, count: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < count
    ? value
    : undefined;
}

function hue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= APPEARANCE_LIMITS.maxHue ? rounded : undefined;
}

function figure(value: unknown): AgentFigure | undefined {
  return typeof value === "string" &&
    (AGENT_FIGURES as readonly string[]).includes(value)
    ? (value as AgentFigure)
    : undefined;
}

function accessory(value: unknown): AgentAccessory | undefined {
  return typeof value === "string" &&
    (AGENT_ACCESSORIES as readonly string[]).includes(value)
    ? (value as AgentAccessory)
    : undefined;
}

/**
 * Keep only the fields the renderer understands, and drop the record entirely
 * when nothing survives.
 *
 * An absent field is meaningful rather than missing data: it means "use the
 * ID-derived default", so writing a partial record is the normal case and an
 * empty one is stored as no record at all.
 */
export function normalizeAppearance(
  value: AgentAppearance | undefined,
): AgentAppearance | undefined {
  if (value === undefined || value === null || typeof value !== "object") {
    return undefined;
  }
  const normalized: AgentAppearance = {};
  const nextHue = hue(value.hue);
  if (nextHue !== undefined) normalized.hue = nextHue;
  const nextHair = paletteIndex(value.hair, APPEARANCE_LIMITS.hairCount);
  if (nextHair !== undefined) normalized.hair = nextHair;
  const nextSkin = paletteIndex(value.skin, APPEARANCE_LIMITS.skinCount);
  if (nextSkin !== undefined) normalized.skin = nextSkin;
  const nextAccessory = accessory(value.accessory);
  if (nextAccessory !== undefined) normalized.accessory = nextAccessory;
  const nextFigure = figure(value.figure);
  if (nextFigure !== undefined) normalized.figure = nextFigure;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
