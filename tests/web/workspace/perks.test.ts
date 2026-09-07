import { describe, expect, it } from "vitest";
import {
  PERKS,
  PERK_IDS,
  PERK_PALETTE,
  isPerkId,
} from "../../../apps/web/src/workspace/pixi/art/perks";
import {
  AVATAR_FIGURE_HAIR,
  AVATAR_FIGURE_OUTFIT,
  AVATAR_SIZE,
  ROBOT_BODIES,
  ROBOT_FACES,
  ROBOT_HANDS,
  AVATAR_FACES,
  AVATAR_HANDS,
} from "../../../apps/web/src/workspace/pixi/art/sprites";
import {
  CORRIDOR,
  WORLD,
} from "../../../apps/web/src/workspace/workspace-layout";
import type { PixelGrid } from "../../../apps/web/src/workspace/pixi/art/pixel-texture";

/**
 * Pixel art is authored as character grids, so the failure modes are a ragged
 * row and a colour nobody defined — both of which render as a silently wrong
 * picture rather than an error. These check the grids instead of the pixels.
 */
function widths(grid: PixelGrid): number[] {
  return [...new Set(grid.map((row) => row.length))];
}

function unknownCharacters(grid: PixelGrid, palette: Record<string, string>): string[] {
  const unknown = new Set<string>();
  for (const row of grid) {
    for (const character of row) {
      if (character !== "." && palette[character] === undefined) unknown.add(character);
    }
  }
  return [...unknown];
}

describe("office perks", () => {
  it("declares every id exactly once", () => {
    expect(PERK_IDS).toHaveLength(PERKS.length);
    expect(new Set(PERK_IDS).size).toBe(PERKS.length);
  });

  it("recognizes its own ids and nothing else", () => {
    for (const id of PERK_IDS) expect(isPerkId(id)).toBe(true);
    expect(isPerkId("ball-pit")).toBe(false);
  });

  for (const perk of PERKS) {
    it(`draws ${perk.id} as a rectangle in known colours`, () => {
      expect(widths(perk.grid)).toHaveLength(1);
      expect(unknownCharacters(perk.grid, PERK_PALETTE)).toEqual([]);
    });

    it(`stands ${perk.id} on the open floor, clear of the walking ring`, () => {
      const width = perk.grid[0]?.length ?? 0;
      const left = perk.x - Math.floor(width / 2);
      // Bottom-anchored, south of the lower corridor, and inside the room.
      expect(perk.y).toBeGreaterThan(CORRIDOR.bottom);
      expect(perk.y).toBeLessThanOrEqual(WORLD.height);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + width).toBeLessThanOrEqual(WORLD.width);
      expect(perk.y - perk.grid.length).toBeGreaterThan(CORRIDOR.bottom - 40);
    });
  }
});

describe("robot crew", () => {
  it("matches the human sprite sheet, pose for pose", () => {
    expect(Object.keys(ROBOT_BODIES).sort()).toEqual(["stand", "walkA", "walkB"]);
    expect(Object.keys(ROBOT_FACES).sort()).toEqual(Object.keys(AVATAR_FACES).sort());
    expect(Object.keys(ROBOT_HANDS).sort()).toEqual(Object.keys(AVATAR_HANDS).sort());
  });

  it("keeps every body on the avatar grid, so offsets stay shared", () => {
    for (const [name, grid] of Object.entries(ROBOT_BODIES)) {
      expect(widths(grid), name).toEqual([AVATAR_SIZE.width]);
      expect(grid, name).toHaveLength(AVATAR_SIZE.height);
    }
  });

  it("keeps every visor on the face grid", () => {
    for (const [name, grid] of Object.entries(ROBOT_FACES)) {
      expect(widths(grid), name).toEqual([8]);
      expect(grid, name).toHaveLength(4);
    }
  });
});

describe("figure overlays", () => {
  it("draws each overlay as a rectangle no wider than the body", () => {
    for (const [figure, grid] of Object.entries(AVATAR_FIGURE_HAIR)) {
      const measured = widths(grid);
      expect(measured, figure).toHaveLength(1);
      expect(measured[0], figure).toBeLessThanOrEqual(AVATAR_SIZE.width);
    }
    for (const [figure, grid] of Object.entries(AVATAR_FIGURE_OUTFIT)) {
      const measured = widths(grid);
      expect(measured, figure).toHaveLength(1);
      expect(measured[0], figure).toBeLessThanOrEqual(AVATAR_SIZE.width);
    }
  });

  it("adds nothing for the neutral figure, which is the base drawing", () => {
    expect(AVATAR_FIGURE_HAIR.neutral.join("")).toMatch(/^\.*$/);
    expect(AVATAR_FIGURE_OUTFIT.neutral.join("")).toMatch(/^\.*$/);
  });
});
