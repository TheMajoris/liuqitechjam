import { describe, expect, it } from "vitest";
import {
  CORRIDOR,
  STATION_POINTS,
  STATION_STAND,
  ZONES,
  officeSeats,
  routeToPoint,
  walkRoute,
  type WorldPoint,
} from "../../../apps/web/src/workspace/workspace-layout";

/**
 * Walking to an arbitrary spot is what a drop needs, and it is the routing
 * rule most easily broken by accident: a shortcut that saves a detour in the
 * lounge will happily cut a diagonal through a cubicle wall somewhere else.
 * The invariant is the same one the departure walk is held to — axis-aligned
 * legs, and no leg through a partitioned zone that neither end is in.
 */
function legs(from: WorldPoint, route: WorldPoint[]): Array<[WorldPoint, WorldPoint]> {
  const points = [from, ...route];
  return points.slice(0, -1).map((point, index) => [point, points[index + 1]!]);
}

function zonesCrossed(start: WorldPoint, end: WorldPoint): string[] {
  return Object.entries(ZONES)
    .filter(([, zone]) => {
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);
      // Strict overlap: touching a zone's open bottom edge is how an Agent
      // steps out of it.
      return (
        maxX > zone.x &&
        minX < zone.x + zone.width &&
        maxY > zone.y &&
        minY < zone.y + zone.height
      );
    })
    .map(([name]) => name);
}

/** Which zone a point sits in, by the same rectangles the art draws. */
function zoneOf(point: WorldPoint): string | null {
  const found = Object.entries(ZONES).find(
    ([, zone]) =>
      point.x >= zone.x &&
      point.x <= zone.x + zone.width &&
      point.y >= zone.y &&
      point.y <= zone.y + zone.height,
  );
  return found ? found[0] : null;
}

describe("routeToPoint", () => {
  const seats = officeSeats();
  const somewhere: Array<[string, WorldPoint]> = [
    ...seats.map((seat) => [`desk ${seat.index}`, seat.anchor] as [string, WorldPoint]),
    ["the library floor", { x: 20, y: 96 }],
    ["the meeting room", { x: 230, y: 98 }],
    ["the lounge corner", { x: 258, y: 172 }],
    ["the server nook", { x: 300, y: 188 }],
    ["the top corridor", { x: 120, y: CORRIDOR.top }],
    ["the bottom corridor", { x: 360, y: CORRIDOR.bottom }],
  ];

  for (const [fromName, from] of somewhere) {
    for (const [toName, to] of somewhere) {
      it(`walks from ${fromName} to ${toName} without crossing a partition`, () => {
        const route = routeToPoint(from, to);
        if (route.length === 0) {
          expect(from).toEqual(to);
          return;
        }
        expect(route.at(-1)).toEqual(to);

        const start = zoneOf(from);
        const finish = zoneOf(to);
        for (const [legStart, legEnd] of legs(from, route)) {
          expect(
            legStart.x === legEnd.x || legStart.y === legEnd.y,
            `${fromName} → ${toName} is not axis-aligned`,
          ).toBe(true);
          // A leg may only be inside a zone one of its ends belongs to: that
          // is stepping out of your own room, or into the one you are headed
          // for. Anything else is a walk through a cubicle wall.
          for (const crossed of zonesCrossed(legStart, legEnd)) {
            expect(
              crossed === start || crossed === finish,
              `${fromName} → ${toName} crosses ${crossed}`,
            ).toBe(true);
          }
        }
      });
    }
  }

  it("crosses an open zone directly rather than stepping out and back in", () => {
    const route = routeToPoint({ x: 200, y: 172 }, { x: 258, y: 188 });
    expect(route.every((point) => point.y < CORRIDOR.bottom)).toBe(true);
    expect(route.at(-1)).toEqual({ x: 258, y: 188 });
  });

  it("walks a re-seated Agent out to the corridor rather than behind the desks", () => {
    const route = routeToPoint(seats[0]!.anchor, seats[1]!.anchor);
    expect(route.some((point) => point.y === CORRIDOR.top)).toBe(true);
  });

  it("shuffles the last few pixels in place after being set down beside a desk", () => {
    const seat = seats[0]!;
    const route = routeToPoint({ x: seat.anchor.x + 6, y: seat.anchor.y - 4 }, seat.anchor);
    expect(route.every((point) => point.y < CORRIDOR.top)).toBe(true);
  });

  it("still answers walkRoute the way the stations expect", () => {
    const seat = seats[3]!;
    expect(walkRoute(seat, seat.anchor, "desk")).toEqual([]);
    expect(walkRoute(seat, seat.anchor, "library").at(-1)).toEqual(STATION_POINTS.library);
  });

  it("reaches every corner of every standing band from every desk", () => {
    for (const seat of seats) {
      for (const band of Object.values(STATION_STAND)) {
        for (const corner of [
          { x: band.x, y: band.y },
          { x: band.x + band.width, y: band.y + band.height },
        ]) {
          expect(routeToPoint(seat.anchor, corner).at(-1)).toEqual(corner);
        }
      }
    }
  });
});
