/**
 * Deterministic office geometry, in world units.
 *
 * The stage scales the whole floor by a fixed quarter-step factor, so keeping every
 * coordinate a whole number here is what keeps the pixel art crisp at any
 * container size. Layout is a pure function of how many Agents are seated:
 * the same Team always sits the same way, and a refresh rebuilds the office
 * exactly without anything visual being persisted.
 *
 * The floor is partitioned into zones separated by cubicle walls. Agents own
 * a desk inside a pod and walk out to whichever zone their current activity
 * implies, along a corridor ring that no partition crosses.
 */
export const WORLD = { width: 400, height: 264 } as const;

/** Back wall band. The floor starts where it ends. */
export const WALL_HEIGHT = 44;

export interface WorldPoint {
  x: number;
  y: number;
}

export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where an Agent can stand.
 *
 * `desk` is its own seat. The rest are shared zones it walks to, chosen by
 * the activity and tool the middleware reports — never by the room itself.
 */
export type StationName =
  | "desk"
  | "board"
  | "door"
  | "library"
  | "server"
  | "lounge";

/**
 * The corridor ring.
 *
 * Two horizontal corridors joined by two vertical ones. Every zone opens onto
 * the ring, so a route is always "step into my corridor, travel the ring, step
 * into the target" — three or four axis-aligned legs, no pathfinder, and no
 * partition is ever crossed.
 */
/**
 * The corridor ring.
 *
 * Two horizontal corridors joined by two vertical ones. Every zone opens
 * downward onto a corridor, and both vertical runs sit in the gaps *between*
 * the lower zones, so a route is always "step down out of my zone, travel the
 * ring, step up into the target" — axis-aligned legs, no pathfinder, and no
 * leg can pass through a partition.
 */
export const CORRIDOR = {
  top: 116,
  bottom: 212,
  /** Vertical connectors, in the gaps between the lower zones. */
  left: 176,
  right: 280,
} as const;

/**
 * Zone rectangles, used for the partition art, the labels, and the routing
 * invariant. Upper zones share a y band, as do lower zones, and every zone is
 * open along its bottom edge.
 */
export const ZONES = {
  library: { x: 6, y: 48, width: 98, height: 56 },
  meeting: { x: 116, y: 48, width: 128, height: 56 },
  deskPodA: { x: 256, y: 48, width: 138, height: 56 },
  deskPodB: { x: 6, y: 128, width: 162, height: 68 },
  lounge: { x: 184, y: 128, width: 88, height: 68 },
  server: { x: 288, y: 128, width: 106, height: 68 },
} as const satisfies Record<string, WorldRect>;

export const BOARD = { x: 180, y: 76, width: 84, height: 28 } as const;
export const PREVIEW_SCREEN = { x: 340, y: 150, width: 56, height: 30 } as const;
/** The permission boundary sits in the open strip below the lower zones. */
export const DOOR = { x: 355, y: 230, width: 30, height: 30 } as const;
export const DESK = { width: 40, height: 20 } as const;

/** Bookshelves the library zone draws, and that a researching Agent faces. */
export const SHELVES: readonly WorldRect[] = [
  { x: 14, y: 56, width: 20, height: 14 },
  { x: 42, y: 56, width: 20, height: 14 },
  { x: 70, y: 56, width: 20, height: 14 },
];

/** Where an Agent stands when it leaves its desk. Each sits inside its zone. */
export const STATION_POINTS: Record<Exclude<StationName, "desk">, WorldPoint> = {
  board: { x: BOARD.x, y: 98 },
  door: { x: DOOR.x, y: 232 },
  library: { x: 55, y: 96 },
  server: { x: 340, y: 190 },
  lounge: { x: 228, y: 188 },
};

/** Room capacity: one Agent per built workstation. Extras stay in the roster. */
export const MAX_SEATS = 6;

export interface WorkspaceSeat {
  index: number;
  /** Feet position of the Agent when seated. Sprites are bottom-anchored.
   *  Offset from the desk centre so the Agent never sits behind its monitor. */
  anchor: WorldPoint;
  /** Desk centre. Drawn in front of the Agent, hiding the legs. */
  desk: WorldPoint;
  /** Corridor this seat steps out to. */
  lane: number;
  pod: "a" | "b";
  /** Free space inside the pod that an idle Agent may drift within. */
  wander: WorldRect;
}

const DESK_OFFSET_Y = 6;
/** The monitor occupies the right half of the desk; the Agent sits left. */
const SEAT_OFFSET_X = -11;
const POD_A_Y = 88;
const POD_B_Y = 172;

/**
 * The workstations the office is built with, pod A first.
 *
 * Fixed rather than arranged per roster size: the furniture is drawn whether
 * or not anyone sits at it, so a desk that moved when an Agent joined would
 * rearrange the room under the people already in it.
 */
const DESK_GRID: ReadonlyArray<readonly [number, "a" | "b"]> = [
  [280, "a"],
  [325, "a"],
  [370, "a"],
  [40, "b"],
  [87, "b"],
  [134, "b"],
];

/** Every workstation in the room, occupied or not. */
export function officeSeats(): WorkspaceSeat[] {
  return buildSeats(DESK_GRID.length);
}

/** The workstations taken by the current roster, in seating order. */
export function seatLayout(count: number): WorkspaceSeat[] {
  return buildSeats(Math.max(0, Math.min(count, MAX_SEATS)));
}

function buildSeats(count: number): WorkspaceSeat[] {
  if (count === 0) return [];
  return DESK_GRID.slice(0, count).map(([x, pod], index) => {
    const anchorY = pod === "a" ? POD_A_Y : POD_B_Y;
    return {
      index,
      anchor: { x: x + SEAT_OFFSET_X, y: anchorY },
      desk: { x, y: anchorY + DESK_OFFSET_Y },
      lane: pod === "a" ? CORRIDOR.top : CORRIDOR.bottom,
      pod,
      // Kept well inside the pod so a drifting Agent never touches a wall.
      wander: { x: x - 14, y: anchorY - 4, width: 28, height: 10 },
    };
  });
}

/**
 * Which corridor a point exits onto. Every zone opens downward, so anything
 * at or above the top corridor leaves via the top, and everything else via
 * the bottom.
 */
export function laneFor(y: number): number {
  return y <= CORRIDOR.top ? CORRIDOR.top : CORRIDOR.bottom;
}

export function stationPoint(seat: WorkspaceSeat, station: StationName): WorldPoint {
  if (station === "desk") return seat.anchor;
  return STATION_POINTS[station];
}

/**
 * A route along the corridor ring.
 *
 * Legs are axis-aligned and always leave the pod before travelling, so no leg
 * can pass through a partition. At most four points: out to my corridor, along
 * it, down/up the connecting corridor, then in to the destination.
 */
export function walkRoute(
  seat: WorkspaceSeat,
  from: WorldPoint,
  station: StationName,
): WorldPoint[] {
  const target = stationPoint(seat, station);
  if (from.x === target.x && from.y === target.y) return [];

  const startLane = laneFor(from.y);
  const targetLane = laneFor(target.y);
  const route: WorldPoint[] = [];

  // Step out of the zone through its open bottom edge, onto a corridor.
  if (from.y !== startLane) route.push({ x: from.x, y: startLane });

  // Change corridor via whichever vertical run is nearer. Both sit in gaps
  // between the lower zones, so this leg never enters a partitioned room.
  if (startLane !== targetLane) {
    const side = Math.abs(from.x - CORRIDOR.left) <= Math.abs(from.x - CORRIDOR.right)
      ? CORRIDOR.left
      : CORRIDOR.right;
    route.push({ x: side, y: startLane });
    route.push({ x: side, y: targetLane });
  }

  const settledX = route.at(-1)?.x ?? from.x;
  if (target.x !== settledX) route.push({ x: target.x, y: targetLane });
  if (target.y !== targetLane) route.push({ x: target.x, y: target.y });
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
 * Integer scaling keeps every art pixel square. The office is centred in the
 * container and the surrounding area is painted by the stage background, so
 * the canvas always fills its parent without stretching the room.
 */
export function stageTransform(width: number, height: number): StageTransform {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const raw = Math.min(safeWidth / WORLD.width, safeHeight / WORLD.height);
  // Quarter steps rather than half: the pixel grid still lands on clean
  // fractions, but the room fills far more of a wide pane than 2x then 2.5x
  // allowed — the office was reading as a postage stamp in the middle.
  const scale = Math.max(1, Math.floor(raw * 4) / 4);
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
