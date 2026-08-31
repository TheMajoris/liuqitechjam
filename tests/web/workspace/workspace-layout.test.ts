import { describe, expect, it } from "vitest";
import {
  CORRIDOR,
  MAX_SEATS,
  STATION_POINTS,
  ZONES,
  laneFor,
  seatLayout,
  stageTransform,
  stationPoint,
  walkRoute,
  WORLD,
  worldToScreen,
  type StationName,
  type WorldPoint,
  type WorldRect,
} from "../../../apps/web/src/workspace/workspace-layout";

const STATIONS: readonly StationName[] = [
  "desk",
  "board",
  "door",
  "library",
  "server",
  "lounge",
];

describe("seatLayout", () => {
  it("is deterministic: the same roster size always seats the same way", () => {
    expect(seatLayout(4)).toEqual(seatLayout(4));
  });

  it("lays out every roster size inside the office", () => {
    for (let count = 1; count <= MAX_SEATS; count += 1) {
      const seats = seatLayout(count);
      expect(seats).toHaveLength(count);
      for (const seat of seats) {
        expect(seat.anchor.x).toBeGreaterThan(0);
        expect(seat.anchor.x).toBeLessThan(WORLD.width);
        expect(seat.anchor.y).toBeGreaterThan(0);
        expect(seat.anchor.y).toBeLessThan(WORLD.height);
        expect(Number.isInteger(seat.anchor.x)).toBe(true);
        expect(Number.isInteger(seat.anchor.y)).toBe(true);
      }
    }
  });

  it("gives every seat its own desk", () => {
    const desks = seatLayout(6).map((seat) => `${seat.desk.x}:${seat.desk.y}`);
    expect(new Set(desks).size).toBe(6);
  });

  it("caps the office and never seats a negative roster", () => {
    expect(seatLayout(40)).toHaveLength(MAX_SEATS);
    expect(seatLayout(0)).toHaveLength(0);
    expect(seatLayout(-3)).toHaveLength(0);
  });

  it("seats every Agent inside its own desk pod", () => {
    for (let count = 1; count <= MAX_SEATS; count += 1) {
      for (const seat of seatLayout(count)) {
        const pod = seat.pod === "a" ? ZONES.deskPodA : ZONES.deskPodB;
        expect(seat.anchor.x).toBeGreaterThan(pod.x);
        expect(seat.anchor.x).toBeLessThan(pod.x + pod.width);
        expect(seat.anchor.y).toBeGreaterThan(pod.y);
        expect(seat.anchor.y).toBeLessThan(pod.y + pod.height);
      }
    }
  });

  it("puts each seat on the corridor its pod opens onto", () => {
    for (const seat of seatLayout(6)) {
      expect(seat.lane).toBe(seat.pod === "a" ? CORRIDOR.top : CORRIDOR.bottom);
      expect(seat.lane).toBe(laneFor(seat.anchor.y));
    }
  });

  it("keeps the idle wander box inside the pod", () => {
    for (let count = 1; count <= MAX_SEATS; count += 1) {
      for (const seat of seatLayout(count)) {
        const pod = seat.pod === "a" ? ZONES.deskPodA : ZONES.deskPodB;
        const { wander } = seat;
        expect(wander.x).toBeGreaterThan(pod.x);
        expect(wander.x + wander.width).toBeLessThan(pod.x + pod.width);
        expect(wander.y).toBeGreaterThan(pod.y);
        expect(wander.y + wander.height).toBeLessThan(pod.y + pod.height);
      }
    }
  });
});

describe("station points", () => {
  it("places every shared station inside the zone it belongs to", () => {
    const inside = (point: WorldPoint, zone: WorldRect): boolean =>
      point.x > zone.x &&
      point.x < zone.x + zone.width &&
      point.y > zone.y &&
      point.y < zone.y + zone.height;

    expect(inside(STATION_POINTS.board, ZONES.meeting)).toBe(true);
    expect(inside(STATION_POINTS.library, ZONES.library)).toBe(true);
    expect(inside(STATION_POINTS.server, ZONES.server)).toBe(true);
    expect(inside(STATION_POINTS.lounge, ZONES.lounge)).toBe(true);
    // The door sits in the open strip below every zone, not inside one.
    for (const zone of Object.values(ZONES)) {
      expect(inside(STATION_POINTS.door, zone)).toBe(false);
    }
  });
});

describe("walkRoute", () => {
  /**
   * Every zone is a room with three solid sides and an open bottom. A leg may
   * cross the bottom edge, but never a side or the top — that is what keeps
   * an Agent from walking through a cubicle wall.
   */
  function zoneAt(x: number, y: number): string | null {
    for (const [name, zone] of Object.entries(ZONES)) {
      if (x > zone.x && x < zone.x + zone.width && y > zone.y && y < zone.y + zone.height) {
        return name;
      }
    }
    return null;
  }

  function legCrossesWall(from: WorldPoint, to: WorldPoint): string | null {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 2;
    // Seed with the zone the leg starts in: standing inside a pod is normal,
    // only *changing* zone away from the open edge is a wall crossing.
    let previous = zoneAt(from.x, from.y);
    for (let step = 0; step <= steps; step += 1) {
      const ratio = steps === 0 ? 0 : step / steps;
      const x = from.x + (to.x - from.x) * ratio;
      const y = from.y + (to.y - from.y) * ratio;
      const current = zoneAt(x, y);
      // A zone may only be entered or left through its open bottom edge.
      if (current !== previous) {
        const changed = current ?? previous!;
        const zone = ZONES[changed as keyof typeof ZONES];
        const atBottom = Math.abs(y - (zone.y + zone.height)) <= 1.5;
        if (!atBottom) return changed;
      }
      previous = current;
    }
    return null;
  }

  it("never walks through a partition, for any roster size or station", () => {
    for (let count = 1; count <= MAX_SEATS; count += 1) {
      for (const seat of seatLayout(count)) {
        for (const from of STATIONS) {
          for (const to of STATIONS) {
            let cursor = stationPoint(seat, from);
            for (const point of walkRoute(seat, cursor, to)) {
              const wall = legCrossesWall(cursor, point);
              expect(
                wall,
                `seat ${seat.index} walking ${from} -> ${to} crossed ${wall}`,
              ).toBeNull();
              cursor = point;
            }
          }
        }
      }
    }
  });

  it("ends on the station it was asked for", () => {
    for (let count = 1; count <= MAX_SEATS; count += 1) {
      for (const seat of seatLayout(count)) {
        for (const station of STATIONS) {
          const route = walkRoute(seat, seat.anchor, station);
          if (route.length === 0) {
            expect(stationPoint(seat, station)).toEqual(seat.anchor);
            continue;
          }
          expect(route.at(-1)).toEqual(stationPoint(seat, station));
        }
      }
    }
  });

  it("stays put when already at the destination", () => {
    const seat = seatLayout(2)[0]!;
    expect(walkRoute(seat, seat.anchor, "desk")).toEqual([]);
  });

  it("returns home from wherever the Agent is standing", () => {
    const seat = seatLayout(3)[2]!;
    for (const station of STATIONS) {
      const route = walkRoute(seat, stationPoint(seat, station), "desk");
      if (route.length === 0) continue;
      expect(route.at(-1)).toEqual(seat.anchor);
    }
  });

  it("routes between corridors through a gap, never through a lower zone", () => {
    for (const x of [CORRIDOR.left, CORRIDOR.right]) {
      for (const zone of [ZONES.deskPodB, ZONES.lounge, ZONES.server]) {
        const insideHorizontally = x > zone.x && x < zone.x + zone.width;
        expect(insideHorizontally).toBe(false);
      }
    }
  });
});

describe("stageTransform", () => {
  it("centres the office and never scales below one", () => {
    const transform = stageTransform(1000, 600);
    expect(transform.scale).toBeGreaterThanOrEqual(1);
    expect(WORLD.width * transform.scale).toBeLessThanOrEqual(1000);
    expect(WORLD.height * transform.scale).toBeLessThanOrEqual(600);
    expect(transform.offsetX).toBe(Math.round((1000 - WORLD.width * transform.scale) / 2));
  });

  it("survives a zero-sized container", () => {
    const transform = stageTransform(0, 0);
    expect(transform.scale).toBe(1);
    expect(Number.isFinite(transform.offsetX)).toBe(true);
  });

  it("maps world points the same way the canvas does", () => {
    const transform = stageTransform(1000, 600);
    expect(worldToScreen(transform, { x: 0, y: 0 })).toEqual({
      x: transform.offsetX,
      y: transform.offsetY,
    });
  });
});
