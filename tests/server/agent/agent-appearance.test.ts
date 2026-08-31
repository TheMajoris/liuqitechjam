import { describe, expect, it } from "vitest";
import { normalizeAppearance } from "../../../apps/server/src/agent-appearance.js";

describe("normalizeAppearance", () => {
  it("keeps valid choices verbatim", () => {
    expect(
      normalizeAppearance({ hue: 210, hair: 3, skin: 1, accessory: "headset" }),
    ).toEqual({ hue: 210, hair: 3, skin: 1, accessory: "headset" });
  });

  it("keeps a partial record so one knob can be set alone", () => {
    expect(normalizeAppearance({ accessory: "cap" })).toEqual({ accessory: "cap" });
  });

  it("drops out-of-range palette indexes rather than clamping them", () => {
    // Clamping would silently show a different character than was asked for;
    // dropping falls back to the ID-derived default, which is honest.
    expect(normalizeAppearance({ hair: 99, skin: -1, hue: 400 })).toBeUndefined();
  });

  it("rejects a non-integer palette index", () => {
    expect(normalizeAppearance({ hair: 1.5 })).toBeUndefined();
  });

  it("rejects an unknown accessory", () => {
    expect(
      normalizeAppearance({ accessory: "crown" as never }),
    ).toBeUndefined();
  });

  it("returns undefined for an empty or absent record", () => {
    expect(normalizeAppearance({})).toBeUndefined();
    expect(normalizeAppearance(undefined)).toBeUndefined();
  });

  it("rounds a fractional hue into the wheel", () => {
    expect(normalizeAppearance({ hue: 210.4 })).toEqual({ hue: 210 });
  });
});
