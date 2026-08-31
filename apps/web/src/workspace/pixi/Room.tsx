import { useCallback } from "react";
import type { Graphics } from "pixi.js";
import "./pixi-elements";
import { pixelTexture } from "./art/pixel-texture";
import { PLANT } from "./art/sprites";
import {
  CORRIDOR,
  SHELVES,
  WALL_HEIGHT,
  WORLD,
  ZONES,
  type WorldRect,
} from "../workspace-layout";
import { SCENE } from "./scene-theme";

const PLANT_PALETTE = { g: "#4f8a5c", k: "#8a6a45", p: "#c08c58" } as const;

/** Cubicle wall thickness, in world pixels. */
const PARTITION = 3;

/**
 * Where a plant stands. Placed in the gaps between the upper zones and in the
 * open strip below the lower ones, so none stands in a corridor an Agent
 * walks along.
 */
const PLANTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 110, y: 100 },
  { x: 250, y: 100 },
  { x: 30, y: 250 },
  { x: 120, y: 250 },
  { x: 232, y: 250 },
  { x: 300, y: 250 },
];

/**
 * Draw one cubicle partition: a slab with a lighter cap, so a wall reads as a
 * standing panel rather than a line painted on the floor.
 */
function partition(
  graphics: Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  graphics
    .rect(x, y, width, height)
    .fill(SCENE.partition)
    .rect(x, y, width, 1)
    .fill(SCENE.partitionCap);
}

/**
 * Outline one zone with partitions, leaving the bottom edge open.
 *
 * Every zone opens downward onto a corridor, which is exactly the assumption
 * `walkRoute` encodes — so the drawn walls and the routing rules cannot drift
 * apart.
 */
function zoneWalls(graphics: Graphics, zone: WorldRect): void {
  const { x, y, width, height } = zone;
  partition(graphics, x, y, width, PARTITION);
  partition(graphics, x, y, PARTITION, height);
  partition(graphics, x + width - PARTITION, y, PARTITION, height);
}

/**
 * The office shell: floor, wall, partitioned zones, fixtures and greenery.
 *
 * Everything here is static, so it is drawn once and never touched by the
 * ticker. The partitions are the same rectangles the layout routes around, so
 * the art and the walking rules can never disagree.
 */
export function Room() {
  const draw = useCallback((graphics: Graphics) => {
    graphics.clear();

    // Floor and its plank grid.
    graphics.rect(0, WALL_HEIGHT, WORLD.width, WORLD.height - WALL_HEIGHT).fill(SCENE.floor);
    for (let x = 0; x < WORLD.width; x += 24) {
      graphics.rect(x, WALL_HEIGHT, 1, WORLD.height - WALL_HEIGHT).fill(SCENE.floorPlank);
    }

    // Corridors read as a lighter runway, so the route an Agent takes is
    // legible even while it is standing still.
    graphics
      .rect(0, CORRIDOR.top - 9, WORLD.width, 18)
      .fill({ color: SCENE.floorGlow, alpha: 0.6 })
      .rect(0, CORRIDOR.bottom - 9, WORLD.width, 18)
      .fill({ color: SCENE.floorGlow, alpha: 0.6 })
      .rect(CORRIDOR.left - 9, CORRIDOR.top, 18, CORRIDOR.bottom - CORRIDOR.top)
      .fill({ color: SCENE.floorGlow, alpha: 0.6 })
      .rect(CORRIDOR.right - 9, CORRIDOR.top, 18, CORRIDOR.bottom - CORRIDOR.top)
      .fill({ color: SCENE.floorGlow, alpha: 0.6 });

    // Back wall.
    graphics.rect(0, 0, WORLD.width, WALL_HEIGHT).fill(SCENE.wall);
    for (let x = 8; x < WORLD.width; x += 72) {
      graphics.rect(x, 6, 48, WALL_HEIGHT - 16).fill(SCENE.wallPanel);
    }
    graphics.rect(0, WALL_HEIGHT - 6, WORLD.width, 3).fill(SCENE.wallShadow);
    graphics.rect(0, WALL_HEIGHT - 3, WORLD.width, 3).fill(SCENE.baseboard);

    // Zone floors, tinted just enough to separate one room from the next.
    for (const zone of Object.values(ZONES)) {
      graphics
        .rect(zone.x, zone.y, zone.width, zone.height)
        .fill({ color: SCENE.zoneFloor, alpha: 0.6 });
    }

    // Library shelves, which a researching Agent walks over to.
    for (const shelf of SHELVES) {
      graphics
        .rect(shelf.x, shelf.y, shelf.width, shelf.height)
        .fill(SCENE.shelf)
        .rect(shelf.x, shelf.y + 5, shelf.width, 1)
        .fill(SCENE.shelfLine)
        .rect(shelf.x, shelf.y + 10, shelf.width, 1)
        .fill(SCENE.shelfLine);
      for (let index = 0; index < 4; index += 1) {
        graphics
          .rect(shelf.x + 2 + index * 4, shelf.y + 1, 2, 4)
          .fill(index % 2 === 0 ? SCENE.bookA : SCENE.bookB);
      }
    }

    // Meeting table beneath the shared board.
    const meeting = ZONES.meeting;
    graphics
      .roundRect(meeting.x + 28, meeting.y + 40, 72, 12, 4)
      .fill({ color: SCENE.shadow, alpha: 0.12 })
      .roundRect(meeting.x + 28, meeting.y + 37, 72, 12, 4)
      .fill(SCENE.deskTop);

    // Lounge: a low couch and a table, so a dozing Agent has somewhere to be.
    const lounge = ZONES.lounge;
    graphics
      .roundRect(lounge.x + 10, lounge.y + 16, 44, 12, 3)
      .fill(SCENE.couch)
      .roundRect(lounge.x + 10, lounge.y + 12, 44, 6, 2)
      .fill(SCENE.couchBack)
      .roundRect(lounge.x + 60, lounge.y + 20, 18, 8, 2)
      .fill(SCENE.deskTop);

    // Server nook: racks with steady indicator strips.
    const server = ZONES.server;
    for (let index = 0; index < 3; index += 1) {
      const rackX = server.x + 10 + index * 20;
      graphics
        .rect(rackX, server.y + 8, 16, 28)
        .fill(SCENE.rack)
        .rect(rackX + 2, server.y + 12, 12, 2)
        .fill(SCENE.rackLight)
        .rect(rackX + 2, server.y + 18, 12, 2)
        .fill(SCENE.rackLight)
        .rect(rackX + 2, server.y + 24, 12, 2)
        .fill(SCENE.rackLight);
    }

    // Walls last, so no fixture is drawn over a partition.
    for (const zone of Object.values(ZONES)) zoneWalls(graphics, zone);
  }, []);

  const plantTexture = pixelTexture("plant", PLANT, PLANT_PALETTE);

  return (
    <pixiContainer>
      <pixiGraphics draw={draw} />
      {PLANTS.map((plant) => (
        <pixiSprite
          key={`${plant.x}:${plant.y}`}
          texture={plantTexture}
          x={plant.x}
          y={plant.y}
          anchor={{ x: 0.5, y: 1 }}
        />
      ))}
    </pixiContainer>
  );
}
