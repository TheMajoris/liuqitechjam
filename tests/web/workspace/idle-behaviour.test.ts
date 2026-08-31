import { describe, expect, it } from "vitest";
import {
  DOZE_AFTER_MS,
  WANDER_INTERVAL_MS,
  nextIdleAction,
  type IdleInput,
} from "../../../apps/web/src/workspace/pixi/idle-behaviour";
import { seatLayout } from "../../../apps/web/src/workspace/workspace-layout";

const seat = seatLayout(2)[0]!;

function input(overrides: Partial<IdleInput> = {}): IdleInput {
  return {
    isIdle: true,
    atDesk: true,
    walking: false,
    dozing: false,
    idleForMs: 0,
    now: 10_000,
    nextWanderAt: 0,
    wander: seat.wander,
    random: () => 0.5,
    ...overrides,
  };
}

describe("nextIdleAction", () => {
  it("wanders once the interval has elapsed", () => {
    const action = nextIdleAction(input({ now: 10_000, nextWanderAt: 9_000 }));
    expect(action.kind).toBe("wander");
  });

  it("waits until the wander interval is due", () => {
    expect(
      nextIdleAction(input({ now: 10_000, nextWanderAt: 12_000 })).kind,
    ).toBe("none");
  });

  it("keeps every wander target inside the pod's own box", () => {
    for (const ratio of [0, 0.25, 0.5, 0.75, 0.999]) {
      const action = nextIdleAction(input({ random: () => ratio }));
      if (action.kind !== "wander") throw new Error("expected a wander");
      expect(action.point.x).toBeGreaterThanOrEqual(seat.wander.x);
      expect(action.point.x).toBeLessThanOrEqual(seat.wander.x + seat.wander.width);
      expect(action.point.y).toBeGreaterThanOrEqual(seat.wander.y);
      expect(action.point.y).toBeLessThanOrEqual(seat.wander.y + seat.wander.height);
    }
  });

  it("dozes once idle long enough, and prefers dozing over wandering", () => {
    expect(nextIdleAction(input({ idleForMs: DOZE_AFTER_MS })).kind).toBe("doze");
    expect(
      nextIdleAction(input({ idleForMs: DOZE_AFTER_MS - 1 })).kind,
    ).toBe("wander");
  });

  it("stays asleep instead of wandering off the couch", () => {
    expect(
      nextIdleAction(input({ dozing: true, idleForMs: DOZE_AFTER_MS * 2 })).kind,
    ).toBe("none");
  });

  it("wakes a dozing Agent as soon as it has work", () => {
    expect(nextIdleAction(input({ isIdle: false, dozing: true })).kind).toBe("wake");
  });

  it("does not interrupt an Agent already walking", () => {
    expect(nextIdleAction(input({ walking: true })).kind).toBe("none");
    expect(
      nextIdleAction(input({ walking: true, idleForMs: DOZE_AFTER_MS })).kind,
    ).toBe("none");
    // A dozing Agent still on its way to the couch must not be yanked back.
    expect(
      nextIdleAction(input({ isIdle: false, dozing: true, walking: true })).kind,
    ).toBe("none");
  });

  it("never wanders an Agent that is away on a tool trip", () => {
    // Away from its desk means the middleware sent it somewhere; the idle
    // machine must not fight that.
    expect(nextIdleAction(input({ atDesk: false })).kind).toBe("none");
    expect(
      nextIdleAction(input({ atDesk: false, idleForMs: DOZE_AFTER_MS })).kind,
    ).toBe("none");
  });

  it("does nothing for a busy Agent that was never dozing", () => {
    expect(nextIdleAction(input({ isIdle: false, dozing: false })).kind).toBe("none");
  });

  it("uses a wander interval shorter than the doze threshold", () => {
    // Otherwise an Agent would fall asleep without ever drifting first.
    expect(WANDER_INTERVAL_MS).toBeLessThan(DOZE_AFTER_MS);
  });
});
