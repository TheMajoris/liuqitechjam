import { describe, expect, it } from "vitest";
import {
  idleTuning,
  nextIdleAction,
  type IdleInput,
} from "../../../apps/web/src/workspace/pixi/idle-behaviour";

/** An Agent standing at its own desk with nothing to do and a decision due. */
function idleAtDesk(overrides: Partial<IdleInput> = {}): IdleInput {
  return {
    isIdle: true,
    atDesk: true,
    walking: false,
    dozing: false,
    napUntil: 0,
    onBreak: false,
    breakUntil: 0,
    idleForMs: 1_000,
    dozeAfterMs: 20_000,
    now: 10_000,
    nextWanderAt: 0,
    wander: { x: 100, y: 80, width: 20, height: 10 },
    random: () => 0.9,
    ...overrides,
  };
}

describe("nextIdleAction", () => {
  it("keeps a working Agent where the middleware put it", () => {
    expect(nextIdleAction(idleAtDesk({ isIdle: false }))).toEqual({ kind: "none" });
  });

  it("sends a dozing Agent back to work when work arrives", () => {
    expect(nextIdleAction(idleAtDesk({ isIdle: false, dozing: true }))).toEqual({ kind: "wake" });
  });

  it("sends an Agent back from a break when work arrives", () => {
    expect(nextIdleAction(idleAtDesk({ isIdle: false, onBreak: true }))).toEqual({ kind: "wake" });
  });

  it("never interrupts a walk", () => {
    expect(nextIdleAction(idleAtDesk({ walking: true }))).toEqual({ kind: "none" });
  });

  it("ends a break on its own clock, not the wander clock", () => {
    const onBreak = { onBreak: true, breakUntil: 12_000, atDesk: false };
    expect(nextIdleAction(idleAtDesk({ ...onBreak, now: 11_000 }))).toEqual({ kind: "none" });
    expect(nextIdleAction(idleAtDesk({ ...onBreak, now: 12_000 }))).toEqual({ kind: "wake" });
  });

  it("dozes on the Agent's own patience, so a room never sleeps at once", () => {
    const patient = idleAtDesk({ idleForMs: 18_000, dozeAfterMs: 25_000 });
    expect(nextIdleAction(patient).kind).not.toBe("doze");
    const restless = idleAtDesk({ idleForMs: 18_000, dozeAfterMs: 16_000 });
    expect(nextIdleAction(restless).kind).toBe("doze");
  });

  it("ends a nap and heads back to the desk", () => {
    const napping = { dozing: true, atDesk: false, napUntil: 30_000 };
    expect(nextIdleAction(idleAtDesk({ ...napping, now: 29_000 }))).toEqual({ kind: "none" });
    expect(nextIdleAction(idleAtDesk({ ...napping, now: 30_000 }))).toEqual({ kind: "wake" });
  });

  it("waits until the next decision is due", () => {
    expect(nextIdleAction(idleAtDesk({ now: 5_000, nextWanderAt: 6_000 }))).toEqual({ kind: "none" });
  });

  it("picks a break, a pause, or a wander from the same roll", () => {
    expect(nextIdleAction(idleAtDesk({ random: () => 0.05 })).kind).toBe("break");
    expect(nextIdleAction(idleAtDesk({ random: () => 0.3 })).kind).toBe("pause");
    expect(nextIdleAction(idleAtDesk({ random: () => 0.8 })).kind).toBe("wander");
  });

  it("wanders to a spot inside its own pod", () => {
    const action = nextIdleAction(idleAtDesk({ random: () => 0.5 }));
    expect(action).toEqual({ kind: "wander", point: { x: 110, y: 85 } });
  });
});

describe("idleTuning", () => {
  it("gives one Agent the same temperament every time", () => {
    expect(idleTuning("agent-a")).toEqual(idleTuning("agent-a"));
  });

  it("gives neighbours different clocks", () => {
    const a = idleTuning("agent-a");
    const b = idleTuning("agent-b");
    expect(a.wanderIntervalMs === b.wanderIntervalMs && a.phaseMs === b.phaseMs).toBe(false);
  });

  it("stays inside sane bounds for every Agent", () => {
    for (let index = 0; index < 200; index += 1) {
      const tuning = idleTuning(`agent-${index}`);
      expect(tuning.wanderIntervalMs).toBeGreaterThanOrEqual(3_000);
      expect(tuning.wanderIntervalMs).toBeLessThan(6_400);
      expect(tuning.dozeAfterMs).toBeGreaterThanOrEqual(15_000);
      expect(tuning.dozeAfterMs).toBeLessThan(30_000);
      expect(tuning.walkSpeed).toBeGreaterThanOrEqual(44);
      expect(tuning.walkSpeed).toBeLessThan(62);
      expect(tuning.phaseMs).toBeGreaterThanOrEqual(0);
      expect(tuning.phaseMs).toBeLessThan(4_000);
    }
  });
});
