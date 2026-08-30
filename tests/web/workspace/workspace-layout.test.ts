import { describe, expect, it } from "vitest";
import {
  BOARD,
  LANE_BOTTOM,
  LANE_TOP,
  MAX_SEATS,
  seatLayout,
  stageTransform,
  stationPoint,
  walkRoute,
  WORLD,
  worldToScreen,
} from "../../../apps/web/src/workspace/workspace-layout";

describe("seatLayout", () => {
  it("is deterministic: the same roster size always seats the same way", () => {
    expect(seatLayout(4)).toEqual(seatLayout(4));
  });

  it("lays out one to six Agents inside the room", () => {
    for (let count = 1; count <= 6; count += 1) {
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

  it("caps the room and never seats a negative roster", () => {
    expect(seatLayout(40)).toHaveLength(MAX_SEATS);
    expect(seatLayout(0)).toHaveLength(0);
    expect(seatLayout(-3)).toHaveLength(0);
  });

  it("puts each seat on the corridor for its row", () => {
    for (const seat of seatLayout(6)) {
      expect(seat.lane).toBe(seat.row === "top" ? LANE_TOP : LANE_BOTTOM);
    }
  });
});

describe("walkRoute", () => {
  const boardTop = BOARD.y - BOARD.height / 2;
  const boardBottom = BOARD.y + BOARD.height / 2;
  const boardLeft = BOARD.x - BOARD.width / 2;
  const boardRight = BOARD.x + BOARD.width / 2;

  /** Sample a straight leg densely enough to catch any crossing. */
  function legCrossesBoard(
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): boolean {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    for (let step = 0; step <= steps; step += 1) {
      const ratio = steps === 0 ? 0 : step / steps;
      const x = from.x + (to.x - from.x) * ratio;
      const y = from.y + (to.y - from.y) * ratio;
      if (x > boardLeft && x < boardRight && y > boardTop && y < boardBottom) return true;
    }
    return false;
  }

  it("never walks through the shared board", () => {
    for (let count = 1; count <= MAX_SEATS; count += 1) {
      for (const seat of seatLayout(count)) {
        for (const station of ["desk", "board", "door"] as const) {
          let cursor = seat.anchor;
          for (const point of walkRoute(seat, seat.anchor, station)) {
            expect(legCrossesBoard(cursor, point)).toBe(false);
            cursor = point;
          }
        }
      }
    }
  });

  it("ends on the station it was asked for", () => {
    const seat = seatLayout(4)[3]!;
    const route = walkRoute(seat, seat.anchor, "door");
    expect(route.at(-1)).toEqual(stationPoint(seat, "door"));
  });

  it("stays put when already at the destination", () => {
    const seat = seatLayout(2)[0]!;
    expect(walkRoute(seat, seat.anchor, "desk")).toEqual([]);
  });

  it("returns home from wherever the Agent is standing", () => {
    const seat = seatLayout(3)[2]!;
    const route = walkRoute(seat, stationPoint(seat, "door"), "desk");
    expect(route.at(-1)).toEqual(seat.anchor);
  });
});

describe("stageTransform", () => {
  it("centres the room and never scales below one", () => {
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
