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

/**
 * The way out.
 *
 * On the left edge at the bottom corridor, which is the one place a doorway
 * can go without cutting through a partitioned zone: the bottom corridor runs
 * the full width of the room, so any desk can reach it and then walk straight
 * out. `x` is negative on purpose — an Agent leaving walks past the frame
 * rather than stopping politely at the threshold.
 */
export const EXIT_DOOR = { x: 0, y: 194, width: 11, height: 30 } as const;
export const EXIT_POINT: WorldPoint = { x: -12, y: CORRIDOR.bottom };

export const BOARD = { x: 180, y: 76, width: 84, height: 28 } as const;
export const PREVIEW_SCREEN = { x: 340, y: 150, width: 56, height: 30 } as const;
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

/* ------------------------------------------------------------------ *
 * Picking an Agent up and putting it somewhere else.
 *
 * The room is already partitioned into zones, so "where can I drop this" has
 * an answer the art already draws: a workstation, or one of the four open
 * zones. Everything below turns a world point into that answer, and back into
 * a spot to stand on. It is pure geometry — who may be moved, and whether the
 * move is remembered, is decided well above this file.
 * ------------------------------------------------------------------ */

export type ZoneName = keyof typeof ZONES;

/** Somewhere an Agent can be posted: any station that is not its own desk. */
export type PostStation = Exclude<StationName, "desk">;

/** The zone each posting stands in. Desk pods are reached by seat, not by zone. */
export const POST_ZONES: Record<PostStation, ZoneName> = {
  board: "meeting",
  library: "library",
  server: "server",
  lounge: "lounge",
};

/** Postings, in the order a keyboard move steps through them. */
export const POST_STATIONS: readonly PostStation[] = ["board", "library", "server", "lounge"];

/**
 * Where an Agent may actually stand inside each zone.
 *
 * Narrower than the zone itself, because a zone is mostly furniture: the
 * library is shelves, the meeting room is a table under the board, the lounge
 * is a couch. These bands are the clear floor in front of each, so an Agent
 * dropped anywhere in a zone lands somewhere it could plausibly be standing
 * rather than inside a bookcase.
 */
export const STATION_STAND: Record<PostStation, WorldRect> = {
  board: { x: 124, y: 94, width: 112, height: 8 },
  library: { x: 14, y: 78, width: 82, height: 22 },
  server: { x: 296, y: 172, width: 90, height: 20 },
  lounge: { x: 192, y: 168, width: 72, height: 24 },
};

/** How much floor around a workstation counts as "at that desk". */
const DESK_DROP = { width: 44, height: 38 } as const;

/**
 * Somewhere an Agent can be dropped: a workstation of its own, or a zone it
 * stands in. Deliberately not a `StationName` — a desk is identified by which
 * one, and no zone is.
 */
export type DropTarget =
  | { kind: "desk"; seatIndex: number }
  | { kind: "station"; station: PostStation };

/** The floor a workstation claims, centred on the desk and reaching behind it. */
export function deskDropRect(seat: WorkspaceSeat): WorldRect {
  return {
    x: seat.desk.x - DESK_DROP.width / 2,
    y: seat.anchor.y - 22,
    width: DESK_DROP.width,
    height: DESK_DROP.height,
  };
}

/** Every place something can be dropped, built once: this runs per pointer move. */
const DROP_TARGETS: ReadonlyArray<{ target: DropTarget; rect: WorldRect }> = [
  ...officeSeats().map((seat) => ({
    target: { kind: "desk", seatIndex: seat.index } as DropTarget,
    rect: deskDropRect(seat),
  })),
  ...POST_STATIONS.map((station) => ({
    target: { kind: "station", station } as DropTarget,
    rect: ZONES[POST_ZONES[station]],
  })),
];

export function dropTargets(): ReadonlyArray<{ target: DropTarget; rect: WorldRect }> {
  return DROP_TARGETS;
}

export function dropTargetRect(target: DropTarget): WorldRect {
  return target.kind === "desk"
    ? deskDropRect(officeSeats()[target.seatIndex]!)
    : ZONES[POST_ZONES[target.station]];
}

export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "desk" && b.kind === "desk") return a.seatIndex === b.seatIndex;
  if (a.kind === "station" && b.kind === "station") return a.station === b.station;
  return false;
}

function contains(rect: WorldRect, point: WorldPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** Manhattan gap from a point to a rectangle; zero once the point is inside. */
function gapTo(rect: WorldRect, point: WorldPoint): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return dx + dy;
}

/**
 * What is under the pointer, or near enough to count.
 *
 * Containment first, so a point genuinely inside a zone always picks that
 * zone. Only when the pointer is over bare corridor does `tolerance` reach for
 * the nearest area — forgiving about aim without ever overruling a deliberate
 * drop. Nothing within reach means nothing: the caller sends the Agent back.
 */
export function dropTargetAt(point: WorldPoint, tolerance = 0): DropTarget | null {
  for (const { target, rect } of DROP_TARGETS) {
    if (contains(rect, point)) return target;
  }
  if (tolerance <= 0) return null;
  let best: DropTarget | null = null;
  let bestGap = tolerance;
  for (const { target, rect } of DROP_TARGETS) {
    const gap = gapTo(rect, point);
    if (gap <= bestGap) {
      best = target;
      bestGap = gap;
    }
  }
  return best;
}

function clampTo(rect: WorldRect, point: WorldPoint): WorldPoint {
  return {
    x: Math.round(Math.min(Math.max(point.x, rect.x), rect.x + rect.width)),
    y: Math.round(Math.min(Math.max(point.y, rect.y), rect.y + rect.height)),
  };
}

/**
 * Where an Agent dropped at `point` ends up standing.
 *
 * A desk has one seat, so a desk drop always lands on it. A zone has floor, so
 * a zone drop keeps the spot that was chosen — clamped into the standing band
 * so nobody is left inside the shelving. Keeping the chosen spot is what makes
 * the room arrangeable rather than merely sortable: two Agents posted to the
 * lounge stand where they were put, not on top of each other.
 */
export function dropLandingPoint(target: DropTarget, point: WorldPoint): WorldPoint {
  if (target.kind === "desk") {
    const seat = officeSeats()[target.seatIndex];
    return seat ? { ...seat.anchor } : { ...point };
  }
  return clampTo(STATION_STAND[target.station], point);
}

/** The middle of a posting's standing band: where a keyboard move puts an Agent. */
export function stationStandCentre(station: PostStation): WorldPoint {
  const band = STATION_STAND[station];
  return {
    x: Math.round(band.x + band.width / 2),
    y: Math.round(band.y + band.height / 2),
  };
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
 * The open zones, where crossing the floor needs no corridor.
 *
 * Deliberately excludes the desk pods: a re-seated Agent squeezing sideways
 * behind the desk row reads as clipping through the furniture, so it walks out
 * to the corridor and back in like anyone carrying a laptop would.
 */
const OPEN_ZONES: ReadonlySet<ZoneName> = new Set<ZoneName>([
  "library",
  "meeting",
  "lounge",
  "server",
]);

function zoneAt(point: WorldPoint): ZoneName | null {
  for (const [name, zone] of Object.entries(ZONES) as Array<[ZoneName, WorldRect]>) {
    if (contains(zone, point)) return name;
  }
  return null;
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
  return routeToPoint(from, stationPoint(seat, station));
}

/**
 * The same corridor route, to an arbitrary spot on the floor.
 *
 * `walkRoute` answers "go to your station"; this answers "go exactly there",
 * which is what a drop needs — an Agent put down in the corner of the lounge
 * stays in that corner rather than sliding to the zone's one canonical tile.
 * Crossing an open zone is a straight walk: stepping out to the corridor and
 * back in to reach the other side of the same room looks like a bug.
 */
export function routeToPoint(from: WorldPoint, target: WorldPoint): WorldPoint[] {
  if (from.x === target.x && from.y === target.y) return [];

  const room = zoneAt(from);
  const sameRoom = room !== null && room === zoneAt(target);
  // A step across the same open room, or a step of any kind that is barely a
  // step: an Agent set down beside its own chair shuffling out to the corridor
  // and back to cover four pixels is the kind of detail that reads as broken.
  const near = Math.abs(target.x - from.x) + Math.abs(target.y - from.y) <= 26;
  if (sameRoom && (OPEN_ZONES.has(room) || near)) {
    const route: WorldPoint[] = [];
    if (target.x !== from.x) route.push({ x: target.x, y: from.y });
    if (target.y !== from.y) route.push({ x: target.x, y: target.y });
    return route;
  }

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

/**
 * The route out of the building, from wherever the Agent is standing.
 *
 * Deliberately not a `StationName`: the exit is not somewhere an Agent works,
 * and adding it to that union would put a door in every switch that decides
 * what an Agent is doing. It follows the same corridor rules as `walkRoute`,
 * so no leg crosses a partition.
 */
export function exitRoute(from: WorldPoint): WorldPoint[] {
  const route: WorldPoint[] = [];
  const startLane = laneFor(from.y);
  if (from.y !== startLane) route.push({ x: from.x, y: startLane });
  if (startLane !== CORRIDOR.bottom) {
    const side = Math.abs(from.x - CORRIDOR.left) <= Math.abs(from.x - CORRIDOR.right)
      ? CORRIDOR.left
      : CORRIDOR.right;
    route.push({ x: side, y: startLane });
    route.push({ x: side, y: CORRIDOR.bottom });
  }
  route.push({ x: EXIT_POINT.x, y: CORRIDOR.bottom });
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

/**
 * The inverse, for pointers.
 *
 * A drag arrives in stage pixels and every drop rule is written in world
 * units, so exactly one conversion happens, here, and both directions share
 * the same transform — the highlighted zone can never disagree with the zone
 * the Agent is actually dropped into.
 */
export function screenToWorld(transform: StageTransform, point: WorldPoint): WorldPoint {
  return {
    x: (point.x - transform.offsetX) / transform.scale,
    y: (point.y - transform.offsetY) / transform.scale,
  };
}
