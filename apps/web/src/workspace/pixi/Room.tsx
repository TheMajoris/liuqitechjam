import { useCallback } from "react";
import type { Graphics } from "pixi.js";
import "./pixi-elements";
import { pixelTexture } from "./art/pixel-texture";
import { PLANT } from "./art/sprites";
import { BOARD, WALL_HEIGHT, WORLD } from "../workspace-layout";
import { SCENE } from "./scene-theme";

const PLANT_PALETTE = { g: "#4f8a5c", k: "#8a6a45", p: "#c08c58" } as const;

/**
 * The room shell: floor, wall, rug and greenery. Everything here is static,
 * so it is drawn once and never touched by the ticker.
 */
export function Room() {
  const draw = useCallback((graphics: Graphics) => {
    graphics.clear();

    graphics.rect(0, WALL_HEIGHT, WORLD.width, WORLD.height - WALL_HEIGHT).fill(SCENE.floor);
    for (let x = 0; x < WORLD.width; x += 24) {
      graphics.rect(x, WALL_HEIGHT, 1, WORLD.height - WALL_HEIGHT).fill(SCENE.floorPlank);
    }
    // A soft pool of light down the middle keeps the eye on the shared board.
    graphics
      .rect(BOARD.x - 96, WALL_HEIGHT, 192, WORLD.height - WALL_HEIGHT)
      .fill({ color: SCENE.floorGlow, alpha: 0.5 });

    graphics.rect(0, 0, WORLD.width, WALL_HEIGHT).fill(SCENE.wall);
    for (let x = 8; x < WORLD.width; x += 72) {
      graphics.rect(x, 6, 48, WALL_HEIGHT - 16).fill(SCENE.wallPanel);
    }
    graphics.rect(0, WALL_HEIGHT - 6, WORLD.width, 3).fill(SCENE.wallShadow);
    graphics.rect(0, WALL_HEIGHT - 3, WORLD.width, 3).fill(SCENE.baseboard);

    // Rug beneath the shared board: a quiet change of tone, not a colour block.
    graphics
      .roundRect(BOARD.x - 58, BOARD.y - 28, 116, 56, 8)
      .fill({ color: SCENE.rugEdge, alpha: 0.45 })
      .roundRect(BOARD.x - 55, BOARD.y - 25, 110, 50, 6)
      .fill({ color: SCENE.rug, alpha: 0.5 });
  }, []);

  const plantTexture = pixelTexture("plant", PLANT, PLANT_PALETTE);

  return (
    <pixiContainer>
      <pixiGraphics draw={draw} />
      <pixiSprite texture={plantTexture} x={18} y={WORLD.height - 8} anchor={{ x: 0.5, y: 1 }} />
      <pixiSprite
        texture={plantTexture}
        x={WORLD.width - 18}
        y={WORLD.height - 8}
        anchor={{ x: 0.5, y: 1 }}
      />
    </pixiContainer>
  );
}
