import { describe, expect, it } from "vitest";
import {
  DURATION,
  EASE_OUT,
  OFFSET,
  transitions,
  variants,
} from "../../../apps/web/src/motion/motion-tokens";

/**
 * These are consistency guards, not behaviour tests.
 *
 * The point of a shared vocabulary is that a panel opening in one view feels
 * like a panel opening in another. Nothing enforces that at the type level, so
 * a stray `duration: 0.6` or a hand-written easing curve would pass review and
 * only show up as one surface that moves differently from the rest.
 */
describe("the app's motion vocabulary", () => {
  it("eases everything on the curve the stylesheet already uses", () => {
    // --ease-out: cubic-bezier(0.32, 0.72, 0, 1)
    expect(EASE_OUT).toEqual([0.32, 0.72, 0, 1]);
  });

  it("gives every named transition the shared curve, or a spring", () => {
    for (const [name, transition] of Object.entries(transitions)) {
      const eased =
        "ease" in transition && transition.ease === EASE_OUT;
      const sprung = "type" in transition && transition.type === "spring";
      expect(eased || sprung, name + " uses an off-vocabulary easing").toBe(true);
    }
  });

  it("keeps every duration inside the range the stylesheet moves in", () => {
    // The CSS spans 140ms to 260ms. Anything slower reads as waiting.
    for (const [name, seconds] of Object.entries(DURATION)) {
      expect(seconds, name + " is too slow").toBeLessThanOrEqual(0.26);
      expect(seconds, name + " is too fast to see").toBeGreaterThanOrEqual(0.1);
    }
  });

  it("moves things by the distances the stylesheet already travels", () => {
    for (const [name, pixels] of Object.entries(OFFSET)) {
      expect(pixels, name + " travels too far").toBeLessThanOrEqual(14);
      expect(pixels, name + " is an imperceptible move").toBeGreaterThanOrEqual(4);
    }
  });

  it("gives every variant an exit, which is the half CSS cannot do", () => {
    for (const [name, variant] of Object.entries(variants)) {
      expect(variant.initial, name + " has no entry state").toBeDefined();
      expect(variant.animate, name + " has no resting state").toBeDefined();
      expect(variant.exit, name + " has no exit state").toBeDefined();
    }
  });

  it("takes a leaving element out of hit-testing", () => {
    // It is still in the DOM for the length of its exit, so without this a
    // second click confirms a delete the reader has already dismissed.
    for (const [name, variant] of Object.entries(variants)) {
      const leaving = variant.exit as Record<string, unknown>;
      expect(leaving.pointerEvents, name + " stays clickable while leaving").toBe(
        "none",
      );
    }
  });

  it("returns to a neutral resting state, so nothing is left transformed", () => {
    for (const [name, variant] of Object.entries(variants)) {
      const resting = variant.animate as Record<string, unknown>;
      expect(resting.opacity, name + " does not rest opaque").toBe(1);
      for (const axis of ["x", "y"] as const) {
        if (axis in resting) expect(resting[axis], name + " rests offset").toBe(0);
      }
      if ("scale" in resting) expect(resting.scale, name + " rests scaled").toBe(1);
    }
  });
});
