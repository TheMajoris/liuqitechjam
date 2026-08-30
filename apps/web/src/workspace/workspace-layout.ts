/**
 * Deterministic room geometry, in world units.
 *
 * The stage scales the whole room by an integer factor, so keeping every
 * coordinate a whole number here is what keeps the pixel art crisp at any
 * container size. Layout is a pure function of how many Agents are seated:
 * the same Team always sits the same way, and a refresh rebuilds the room
 * exactly without anything visual being persisted.
 */
export const WORLD = { width: 360, height: 232 } as const;

/** Back wall band. The floor starts where it ends. */
export const WALL_HEIGHT = 54;

export interface WorldPoint {
  x: number;
  y: number;
}

export type StationName = "desk" | "board" | "door";

export interface WorkspaceSeat {
  index: number;
  /** Feet position of the Agent when seated. Sprites are bottom-anchored.
   *  Offset from the desk centre so the Agent never sits behind its monitor. */
  anchor: WorldPoint;
  /** Desk centre. Drawn in front of the Agent, hiding the legs. */
  desk: WorldPoint;
  /** Anchor for this seat's HTML name plate, in world units. */
  chip: WorldPoint;
  /** Corridor this seat walks along, so routes never cross the board. */
  lane: number;
  row: "top" | "bottom";
}

/** Corridors sit above and below the shared board. */
export const LANE_TOP = 122;
export const LANE_BOTTOM = 176;

export const BOARD = { x: 180, y: 146, width: 88, height: 32 } as const;
export const PREVIEW_SCREEN = { x: 112, y: 28, width: 64, height: 36 } as const;
export const DOOR = { x: 322, y: 30, width: 32, height: 46 } as const;
export const DESK = { width: 56, height: 22 } as const;

/** Where an Agent stands when it leaves its desk. */
export const STATION_POINTS = {
  board: { top: { x: 180, y: LANE_TOP }, bottom: { x: 180, y: LANE_BOTTOM } },
  door: { x: DOOR.x, y: 70 },
} as const;

/** Room capacity. Extra Agents stay in the roster list rather than the room. */
export const MAX_SEATS = 8;

const TOP_ROW_Y = 84;
const BOTTOM_ROW_Y = 198;
const DESK_OFFSET_Y = 6;
/** The monitor occupies the right half of the desk; the Agent sits left. */
const SEAT_OFFSET_X = -13;
/** Where the HTML name plate for a seat is anchored, just below its desk. */
const CHIP_OFFSET_Y = 13;

/**
 * Hand-placed arrangements for the sizes this product actually sees, each one
 * balanced around the shared board rather than being a generic grid.
 */
const ARRANGEMENTS: Record<number, ReadonlyArray<readonly [number, "top" | "bottom"]>> = {
  1: [[180, "top"]],
  2: [[112, "top"], [248, "top"]],
  3: [[112, "top"], [248, "top"], [180, "bottom"]],
  4: [[112, "top"], [248, "top"], [112, "bottom"], [248, "bottom"]],
  5: [[72, "top"], [180, "top"], [288, "top"], [112, "bottom"], [248, "bottom"]],
  6: [[72, "top"], [180, "top"], [288, "top"], [72, "bottom"], [180, "bottom"], [288, "bottom"]],
};

function spread(count: number): number[] {
  if (count === 0) return [];
  const usable = WORLD.width - 144;
  if (count === 1) return [Math.round(72 + usable / 2)];
  const step = usable / (count - 1);
  return Array.from({ length: count }, (_, index) => Math.round(72 + index * step));
}

function generatedArrangement(count: number): Array<readonly [number, "top" | "bottom"]> {
  const topCount = Math.ceil(count / 2);
  return [
    ...spread(topCount).map((x) => [x, "top"] as const),
    ...spread(count - topCount).map((x) => [x, "bottom"] as const),
  ];
}

export function seatLayout(count: number): WorkspaceSeat[] {
  const seats = Math.max(0, Math.min(count, MAX_SEATS));
  if (seats === 0) return [];
  const arrangement = ARRANGEMENTS[seats] ?? generatedArrangement(seats);
  return arrangement.map(([x, row], index) => {
    const anchorY = row === "top" ? TOP_ROW_Y : BOTTOM_ROW_Y;
    return {
      index,
      anchor: { x: x + SEAT_OFFSET_X, y: anchorY },
      desk: { x, y: anchorY + DESK_OFFSET_Y },
      chip: { x, y: anchorY + DESK_OFFSET_Y + CHIP_OFFSET_Y },
      lane: row === "top" ? LANE_TOP : LANE_BOTTOM,
      row,
    };
  });
}

export function stationPoint(seat: WorkspaceSeat, station: StationName): WorldPoint {
  switch (station) {
    case "board":
      return seat.row === "top" ? STATION_POINTS.board.top : STATION_POINTS.board.bottom;
    case "door":
      return STATION_POINTS.door;
    case "desk":
    default:
      return seat.anchor;
  }
}

/**
 * A route of at most three straight legs: out to the seat's corridor, along
 * it, then in to the destination. No pathfinder and no collision engine — the
 * corridors are placed so this route can never cross the board.
 */
export function walkRoute(
  seat: WorkspaceSeat,
  from: WorldPoint,
  station: StationName,
): WorldPoint[] {
  const target = stationPoint(seat, station);
  if (from.x === target.x && from.y === target.y) return [];
  const route: WorldPoint[] = [];
  if (from.y !== seat.lane && (target.x !== from.x || target.y !== from.y)) {
    route.push({ x: from.x, y: seat.lane });
  }
  const lastX = route.length > 0 ? route[route.length - 1]!.x : from.x;
  const lastY = route.length > 0 ? route[route.length - 1]!.y : from.y;
  if (target.x !== lastX) route.push({ x: target.x, y: lastY });
  const settled = route.length > 0 ? route[route.length - 1]! : { x: from.x, y: from.y };
  if (target.y !== settled.y || route.length === 0) route.push({ x: target.x, y: target.y });
  return route;
}

export interface StageTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/**
 * Integer scaling keeps every art pixel square. The room is centred in the
 * container and the surrounding area is painted by the stage background, so
 * the canvas always fills its parent without stretching the room.
 */
export function stageTransform(width: number, height: number): StageTransform {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const raw = Math.min(safeWidth / WORLD.width, safeHeight / WORLD.height);
  const scale = Math.max(1, Math.floor(raw * 2) / 2);
  return {
    scale,
    offsetX: Math.round((safeWidth - WORLD.width * scale) / 2),
    offsetY: Math.round((safeHeight - WORLD.height * scale) / 2),
    width: safeWidth,
    height: safeHeight,
  };
}

/** Shared by the canvas and the HTML label overlay, so both agree exactly. */
export function worldToScreen(transform: StageTransform, point: WorldPoint): WorldPoint {
  return {
    x: transform.offsetX + point.x * transform.scale,
    y: transform.offsetY + point.y * transform.scale,
  };
}
