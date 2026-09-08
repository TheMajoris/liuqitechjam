import { describe, expect, it } from "vitest";
import {
  CORRIDOR,
  EXIT_POINT,
  WORLD,
  ZONES,
  exitRoute,
  officeSeats,
  type WorldPoint,
} from "../../../apps/web/src/workspace/workspace-layout";

/**
 * The departure walk is the one route in the room that is not a station move,
 * so it does not get the same coverage `walkRoute` does. The failure it can
 * produce is silent and looks like a bug in the art: an Agent strolling
 * diagonally through a cubicle wall on its way out.
 */
function legs(from: WorldPoint, route: WorldPoint[]): Array<[WorldPoint, WorldPoint]> {
  const points = [from, ...route];
  return points.slice(0, -1).map((point, index) => [point, points[index + 1]!]);
}

/** Does a straight leg pass through the interior of a partitioned zone? */
function crossesZone(start: WorldPoint, end: WorldPoint): boolean {
  return Object.values(ZONES).some((zone) => {
    const left = zone.x;
    const right = zone.x + zone.width;
    const top = zone.y;
    const bottom = zone.y + zone.height;
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    // Strict overlap: touching a zone's open bottom edge is how an Agent leaves it.
    return maxX > left && minX < right && maxY > top && minY < bottom;
  });
}

describe("exitRoute", () => {
  const starts: Array<[string, WorldPoint]> = [
    ...officeSeats().map(
      (seat) => [`desk ${seat.index} (pod ${seat.pod})`, seat.anchor] as [string, WorldPoint],
    ),
    ["the top corridor", { x: 300, y: CORRIDOR.top }],
    ["the bottom corridor", { x: 380, y: CORRIDOR.bottom }],
    ["the lounge", { x: 228, y: 188 }],
    ["the library", { x: 55, y: 96 }],
    ["the server nook", { x: 340, y: 190 }],
  ];

  for (const [where, from] of starts) {
    it(`walks off the frame from ${where} without crossing a partition`, () => {
      const route = exitRoute(from);
      expect(route.length).toBeGreaterThan(0);

      for (const [start, end] of legs(from, route)) {
        // Axis-aligned: the room has no diagonal walking.
        expect(start.x === end.x || start.y === end.y, `${where} leg`).toBe(true);
      }

      // Every leg after the first — which is the step out of the zone through
      // its open bottom edge — must stay in the corridors.
      for (const [start, end] of legs(from, route).slice(1)) {
        expect(crossesZone(start, end), `${where} leg into a zone`).toBe(false);
      }

      const last = route.at(-1)!;
      expect(last).toEqual({ x: EXIT_POINT.x, y: CORRIDOR.bottom });
      // Off the left edge, so leaving reads as leaving rather than as standing
      // politely at the threshold.
      expect(last.x).toBeLessThan(0);
      expect(last.y).toBeLessThan(WORLD.height);
    });
  }

  it("leaves from the bottom corridor in a single leg", () => {
    expect(exitRoute({ x: 300, y: CORRIDOR.bottom })).toEqual([
      { x: EXIT_POINT.x, y: CORRIDOR.bottom },
    ]);
  });

  it("crosses to the bottom corridor by a vertical connector, never through a pod", () => {
    const route = exitRoute({ x: 325, y: 88 });
    const connector = route.find((point) => point.y === CORRIDOR.bottom && point.x > 0);
    expect(connector).toBeDefined();
    expect([CORRIDOR.left, CORRIDOR.right]).toContain(connector?.x);
  });
});
