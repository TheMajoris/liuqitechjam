import { describe, expect, it } from "vitest";
import { runContextWindow } from "../../../apps/server/src/telemetry/context-window.js";

describe("runContextWindow", () => {
  // Context is space, not price. The turn-3 probe reported 34633 input with
  // 21248 of it served from cache; all 34633 still occupied the window.
  it("counts cached input as occupying the window it was read from", () => {
    const context = runContextWindow(
      { inputTokens: 34_633, cachedInputTokens: 21_248, outputTokens: 5 },
      256_000,
    );

    expect(context).toEqual({
      windowTokens: 256_000,
      usedTokens: 34_638,
      remainingTokens: 221_362,
      usedShare: 34_638 / 256_000,
    });
  });

  it("reports unknown rather than full when the model has no window configured", () => {
    expect(
      runContextWindow({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 }, undefined),
    ).toBeNull();
  });

  it("reports unknown rather than empty when the provider reported nothing", () => {
    expect(runContextWindow(null, 256_000)).toBeNull();
  });

  it("floors remaining at zero when a turn overran the window", () => {
    const context = runContextWindow(
      { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 1_000 },
      256_000,
    );

    expect(context?.remainingTokens).toBe(0);
    // Used is reported as measured, so an overrun stays visible.
    expect(context?.usedTokens).toBe(301_000);
    expect(context?.usedShare).toBe(1);
  });
});
