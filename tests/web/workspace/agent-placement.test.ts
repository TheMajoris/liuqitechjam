import { describe, expect, it } from "vitest";
import {
  MAX_SEATS,
  STATION_POINTS,
  STATION_STAND,
  ZONES,
  POST_STATIONS,
  POST_ZONES,
  dropLandingPoint,
  dropTargetAt,
  officeSeats,
  screenToWorld,
  stageTransform,
  worldToScreen,
  type DropTarget,
  type WorldRect,
} from "../../../apps/web/src/workspace/workspace-layout";
import {
  EMPTY_PLACEMENT,
  applyDrop,
  assignSeats,
  effectiveStation,
  moveToSeat,
  placeAgents,
  prunePlacement,
  seatingOf,
  type AgentPlacement,
} from "../../../apps/web/src/workspace/workspace-placement";
import type { WorkspaceAgentViewModel } from "../../../apps/web/src/workspace/workspace-view-model";

/**
 * Arranging the room is the one thing in the workspace a person does *to* the
 * picture rather than through the middleware, so it is the one thing that can
 * be wrong without any backend disagreeing. The failures worth catching here
 * are quiet: two Agents assigned the same desk, an arrangement that survives
 * the Agent it was made for, or a posting that overrules what the runtime is
 * actually reporting.
 */

function agent(
  agentId: string,
  overrides: Partial<WorkspaceAgentViewModel> = {},
): WorkspaceAgentViewModel {
  return {
    agentId,
    participantId: null,
    name: agentId,
    role: null,
    activity: "idle",
    currentRunId: null,
    safeSummary: null,
    isCurrentParticipant: false,
    isSupervisorChoice: false,
    isSelected: false,
    modelLabel: null,
    modelAssigned: false,
    projectRole: null,
    available: true,
    lifecycle: "ready",
    lastError: null,
    seatIndex: 0,
    station: "desk",
    activeTool: null,
    sandboxActivity: null,
    typing: false,
    appearance: null,
    metrics: null,
    modelResource: null,
    ...overrides,
  };
}

function contains(rect: WorldRect, x: number, y: number): boolean {
  return (
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
  );
}

describe("assignSeats", () => {
  const ids = ["a", "b", "c"];

  it("seats an unarranged roster in roster order", () => {
    const seating = assignSeats(ids, MAX_SEATS, EMPTY_PLACEMENT);
    expect([...seating]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("honours a chosen desk and fills the rest around it", () => {
    const seating = assignSeats(ids, MAX_SEATS, { seats: { c: 0 }, posts: {} });
    expect(seating.get("c")).toBe(0);
    expect(seating.get("a")).toBe(1);
    expect(seating.get("b")).toBe(2);
  });

  it("never seats two Agents at one desk", () => {
    const seating = assignSeats(ids, MAX_SEATS, { seats: { a: 4, b: 4, c: 4 }, posts: {} });
    expect(new Set(seating.values()).size).toBe(ids.length);
  });

  it("drops a seat that no longer exists rather than repairing it", () => {
    const seating = assignSeats(ids, MAX_SEATS, { seats: { b: 99, c: -1 }, posts: {} });
    expect([...seating.values()].every((seat) => seat >= 0 && seat < MAX_SEATS)).toBe(true);
    expect(new Set(seating.values()).size).toBe(ids.length);
  });

  it("keeps an arrangement when someone else leaves the room", () => {
    const placement: AgentPlacement = { seats: { c: 5, a: 3 }, posts: {} };
    const before = assignSeats(ids, MAX_SEATS, placement);
    const after = assignSeats(["a", "c"], MAX_SEATS, placement);
    expect(after.get("a")).toBe(before.get("a"));
    expect(after.get("c")).toBe(before.get("c"));
  });
});

describe("moveToSeat", () => {
  const ids = ["a", "b", "c"];
  const seating = assignSeats(ids, MAX_SEATS, EMPTY_PLACEMENT);

  it("trades places with whoever already has the desk", () => {
    const next = moveToSeat(EMPTY_PLACEMENT, seating, "a", 2);
    const after = assignSeats(ids, MAX_SEATS, next);
    expect(after.get("a")).toBe(2);
    expect(after.get("c")).toBe(0);
    expect(after.get("b")).toBe(1);
  });

  it("leaves nobody displaced when the desk is free", () => {
    const next = moveToSeat(EMPTY_PLACEMENT, seating, "a", 5);
    const after = assignSeats(ids, MAX_SEATS, next);
    expect(after.get("a")).toBe(5);
    expect(after.get("b")).toBe(1);
    expect(after.get("c")).toBe(2);
  });

  it("ends a posting: the desk is the arrangement now", () => {
    const posted: AgentPlacement = {
      seats: {},
      posts: { a: { station: "lounge", x: 220, y: 180 } },
    };
    expect(moveToSeat(posted, seating, "a", 3).posts.a).toBeUndefined();
  });
});

describe("applyDrop", () => {
  const seating = assignSeats(["a", "b"], MAX_SEATS, EMPTY_PLACEMENT);

  it("remembers the exact spot a zone drop chose", () => {
    const target: DropTarget = { kind: "station", station: "lounge" };
    const next = applyDrop(EMPTY_PLACEMENT, seating, "a", target, { x: 200, y: 174 });
    expect(next.posts.a).toEqual({ station: "lounge", x: 200, y: 174 });
  });

  it("pulls a spot outside the standing band back onto clear floor", () => {
    const target: DropTarget = { kind: "station", station: "library" };
    // Aimed at the bookshelves, which are furniture rather than floor.
    const next = applyDrop(EMPTY_PLACEMENT, seating, "a", target, { x: 20, y: 58 });
    const post = next.posts.a!;
    expect(contains(STATION_STAND.library, post.x, post.y)).toBe(true);
  });
});

describe("prunePlacement", () => {
  it("forgets Agents that have left the room", () => {
    const placement: AgentPlacement = {
      seats: { a: 1, gone: 4 },
      posts: { a: { station: "server", x: 320, y: 180 }, gone: { station: "lounge", x: 1, y: 2 } },
    };
    const pruned = prunePlacement(placement, ["a"]);
    expect(pruned.seats).toEqual({ a: 1 });
    expect(Object.keys(pruned.posts)).toEqual(["a"]);
  });
});

describe("effectiveStation", () => {
  const posting = { station: "lounge", x: 220, y: 180 } as const;

  it("stands a waiting Agent where it was put", () => {
    expect(effectiveStation("desk", posting)).toBe("lounge");
  });

  it("never overrules what the runtime is actually reporting", () => {
    expect(effectiveStation("board", posting)).toBe("board");
    expect(effectiveStation("library", posting)).toBe("library");
    expect(effectiveStation("server", posting)).toBe("server");
  });

  it("leaves an unarranged Agent at its desk", () => {
    expect(effectiveStation("desk", null)).toBe("desk");
  });
});

describe("placeAgents", () => {
  const seats = officeSeats();

  it("stands a posted Agent on its own spot, not the zone's one tile", () => {
    const placed = placeAgents([agent("a")], seats, {
      seats: {},
      posts: { a: { station: "lounge", x: 200, y: 174 } },
    });
    expect(placed[0]!.anchor).toEqual({ x: 200, y: 174 });
    expect(placed[0]!.station).toBe("lounge");
  });

  it("sends a posted Agent to the zone its work implies, and no further", () => {
    const placed = placeAgents([agent("a", { station: "board" })], seats, {
      seats: {},
      posts: { a: { station: "lounge", x: 200, y: 174 } },
    });
    expect(placed[0]!.station).toBe("board");
    expect(placed[0]!.anchor).toEqual(STATION_POINTS.board);
  });

  it("seats a moved Agent at its chosen desk", () => {
    const placed = placeAgents([agent("a"), agent("b")], seats, {
      seats: { a: 4 },
      posts: {},
    });
    expect(placed[0]!.seat.index).toBe(4);
    expect(placed[0]!.anchor).toEqual(seats[4]!.anchor);
    expect(seatingOf(placed).get("b")).toBe(0);
  });

  it("seats no more Agents than the room has desks", () => {
    const roster = Array.from({ length: MAX_SEATS + 3 }, (_, index) => agent(`a${index}`));
    expect(placeAgents(roster, seats, EMPTY_PLACEMENT)).toHaveLength(MAX_SEATS);
  });
});

describe("drop geometry", () => {
  const seats = officeSeats();

  it("puts every workstation and every zone within reach", () => {
    for (const seat of seats) {
      expect(dropTargetAt(seat.anchor)).toEqual({ kind: "desk", seatIndex: seat.index });
    }
    for (const station of POST_STATIONS) {
      expect(dropTargetAt(STATION_POINTS[station])).toEqual({ kind: "station", station });
    }
  });

  it("accepts nothing over the open corridor", () => {
    expect(dropTargetAt({ x: 200, y: 212 })).toBeNull();
  });

  it("reaches for the nearest area only when asked to", () => {
    expect(dropTargetAt({ x: 200, y: 206 }, 12)).toEqual({
      kind: "station",
      station: "lounge",
    });
  });

  it("lands a desk drop on the seat itself", () => {
    const seat = seats[2]!;
    expect(dropLandingPoint({ kind: "desk", seatIndex: 2 }, { x: 999, y: 999 })).toEqual(
      seat.anchor,
    );
  });

  it("reads a pointer back to the exact world point the room was drawn from", () => {
    // The highlight is drawn from world units and the drop is decided from a
    // pointer in stage pixels. If these two disagree by even a pixel at some
    // zoom, an Agent lands in a zone the room never lit up — so the two
    // conversions are held to being inverses at every scale the stage picks.
    for (const [width, height] of [
      [520, 340],
      [900, 500],
      [1440, 720],
      [401, 265],
    ] as const) {
      const transform = stageTransform(width, height);
      for (const seat of seats) {
        const back = screenToWorld(transform, worldToScreen(transform, seat.anchor));
        expect(back.x).toBeCloseTo(seat.anchor.x, 6);
        expect(back.y).toBeCloseTo(seat.anchor.y, 6);
        expect(dropTargetAt(back)).toEqual({ kind: "desk", seatIndex: seat.index });
      }
    }
  });

  it("keeps every standing band inside its zone and clear of the canonical spot", () => {
    for (const station of POST_STATIONS) {
      const band = STATION_STAND[station];
      const zone = ZONES[POST_ZONES[station]];
      expect(contains(zone, band.x, band.y), `${station} band start`).toBe(true);
      expect(
        contains(zone, band.x + band.width, band.y + band.height),
        `${station} band end`,
      ).toBe(true);
      const point = STATION_POINTS[station];
      expect(contains(band, point.x, point.y), `${station} station point`).toBe(true);
    }
  });
});
