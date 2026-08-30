import { CanvasSource, Texture } from "pixi.js";

/**
 * Tiny pixel-art pipeline.
 *
 * Sprites are authored as character grids in `sprites.ts` — one character per
 * pixel — and rasterised here into nearest-neighbour textures. Art stays
 * readable and diffable in source instead of arriving as base64 blobs, and
 * swapping in real sprite sheets later only means replacing this loader.
 */
export type PixelGrid = readonly string[];

/** Character to CSS colour. Any character absent from the map is transparent. */
export type PixelPalette = Readonly<Record<string, string>>;

const textureCache = new Map<string, Texture>();

export function pixelGridSize(grid: PixelGrid): { width: number; height: number } {
  return {
    width: grid.reduce((widest, row) => Math.max(widest, row.length), 0),
    height: grid.length,
  };
}

function rasterize(grid: PixelGrid, palette: PixelPalette): HTMLCanvasElement | null {
  const { width, height } = pixelGridSize(grid);
  if (width === 0 || height === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  for (let y = 0; y < grid.length; y += 1) {
    const row = grid[y] ?? "";
    for (let x = 0; x < row.length; x += 1) {
      const colour = palette[row[x] ?? "."];
      if (!colour) continue;
      context.fillStyle = colour;
      context.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

/**
 * Textures are cached by key and never rebuilt for a second sprite using the
 * same art and palette, so adding an Agent costs no extra GPU uploads beyond
 * its own colours.
 */
export function pixelTexture(
  key: string,
  grid: PixelGrid,
  palette: PixelPalette,
): Texture {
  const cached = textureCache.get(key);
  if (cached) return cached;
  const canvas = rasterize(grid, palette);
  if (!canvas) return Texture.EMPTY;
  const texture = new Texture({
    source: new CanvasSource({
      resource: canvas,
      scaleMode: "nearest",
      label: key,
      // The room never scales art down, so mipmaps would only cost memory.
      autoGenerateMipmaps: false,
    }),
    label: key,
  });
  textureCache.set(key, texture);
  return texture;
}
