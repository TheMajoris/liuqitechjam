import { describe, expect, it } from "vitest";
import type { ModelResourceSnapshot } from "../../apps/web/src/types";
import {
  modelOptionLabel,
  modelResourceCapacityLabel,
  modelResourceOptionSuffix,
  modelContextTone,
  modelContextUsage,
  modelFreeGrantLabel,
  modelResourceQuotaLabel,
  modelResourceQuotaPercent,
} from "../../apps/web/src/model-resource-format";

function resource(overrides: Partial<ModelResourceSnapshot> = {}): ModelResourceSnapshot {
  return {
    providerId: "ark",
    modelId: "ep-1",
    endpointStatus: "running",
    usage: null,
    freshness: "fresh",
    observedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("model context copy", () => {
  const lastRun = { inputTokens: 90_000, outputTokens: 10_000 };

  it("reports how full the window is, not how much is notionally left", () => {
    const snapshot = resource({ contextWindowTokens: 200_000 });
    expect(modelContextUsage(snapshot, lastRun)?.usedPercent).toBe(50);
    expect(modelResourceCapacityLabel(snapshot, lastRun)).toBe("50% of context used");
  });

  it("counts cache reads against the window", () => {
    // A prompt served from cache still occupies the window it was read from,
    // so removing it would understate how close the next turn is to refusal.
    const snapshot = resource({ contextWindowTokens: 100_000 });
    const cached = { inputTokens: 80_000, cachedInputTokens: 70_000, outputTokens: 0 };
    expect(modelContextUsage(snapshot, cached)?.usedTokens).toBe(80_000);
  });

  it("falls back to the last turn's size when no window is configured", () => {
    // A measured token count is more use than a dash; only the share of a
    // ceiling is unknown, so only that is withheld.
    expect(modelContextUsage(resource(), lastRun)).toBeNull();
    expect(modelResourceCapacityLabel(resource(), lastRun)).toBe("100K last turn");
    // The detail line floats over the room, so it stays one short clause.
    expect(modelResourceQuotaLabel(resource(), lastRun)).toBe(
      "No context window set for this model",
    );
  });

  it("shows a dash only when the turn reported nothing either", () => {
    expect(modelResourceCapacityLabel(resource(), null)).toBe("Context —");
  });

  it("does not infer context from a free-token grant", () => {
    // The grant is shared across every Agent on the model and never says how
    // full one Agent's window is.
    const snapshot = resource({
      quota: { usedTokens: 66, totalTokens: 100, remainingTokens: 34 },
    });
    expect(modelContextUsage(snapshot, lastRun)).toBeNull();
    expect(modelResourceCapacityLabel(snapshot, lastRun)).toBe("100K last turn");
  });

  it("marks a reading that is no longer being confirmed as last known", () => {
    const snapshot = resource({ contextWindowTokens: 200_000, freshness: "stale" });
    expect(modelResourceCapacityLabel(snapshot, lastRun)).toBe(
      "50% of context used \u00b7 last known",
    );
  });

  it("says nothing when the turn reported no counters", () => {
    const snapshot = resource({ contextWindowTokens: 200_000 });
    expect(modelContextUsage(snapshot, null)).toBeNull();
  });
});

describe("free-token grant copy", () => {
  it("names it a trial and says it is shared", () => {
    const snapshot = resource({
      quota: { usedTokens: 106_000, totalTokens: 500_000, remainingTokens: 394_000 },
    });
    const label = modelFreeGrantLabel(snapshot);
    expect(label).toContain("Free trial");
    expect(label).toContain("shared by every Agent");
    // Never presented as a capacity the Agent is running out of.
    expect(label).not.toContain("tokens left \u00b7");
  });

  it("says nothing when no grant was reported", () => {
    expect(modelFreeGrantLabel(resource())).toBeNull();
  });
});

describe("model context bands", () => {
  function toneFor(usedTokens: number) {
    return modelContextTone(
      resource({ contextWindowTokens: 100 }),
      { inputTokens: usedTokens, outputTokens: 0 },
    );
  }

  it("stays healthy while the window has real room", () => {
    expect(toneFor(1)).toBe("healthy");
    expect(toneFor(69)).toBe("healthy");
  });

  it("warns as the window fills", () => {
    expect(toneFor(70)).toBe("warning");
    expect(toneFor(89)).toBe("warning");
  });

  it("goes critical only when the next turn is at risk of refusal", () => {
    expect(toneFor(90)).toBe("critical");
    expect(toneFor(100)).toBe("critical");
  });

  it("never colours a free-token grant, however low it runs", () => {
    // Exhausting a grant changes the price, not the behaviour, so it earns no
    // warning colour at all.
    expect(
      modelContextTone(
        resource({ quota: { usedTokens: 99, totalTokens: 100, remainingTokens: 1 } }),
        { inputTokens: 10, outputTokens: 0 },
      ),
    ).toBe("unknown");
  });

  it("reports an unknown tone for a stale snapshot", () => {
    expect(
      modelContextTone(
        resource({ contextWindowTokens: 100, freshness: "stale" }),
        { inputTokens: 10, outputTokens: 0 },
      ),
    ).toBe("unknown");
  });
});

describe("model picker option labels", () => {
  const model = { id: "ep-1", label: "liuqi9 · deepseek-v4-pro-ga 260813" };

  it("names the free trial rather than implying a capacity limit", () => {
    const snapshot = resource({
      quota: { usedTokens: 18, totalTokens: 100, remainingTokens: 82 },
    });
    expect(modelResourceOptionSuffix(snapshot)).toBe("82% of free trial left");
    expect(modelOptionLabel(model, snapshot)).toBe(
      "liuqi9 · deepseek-v4-pro-ga 260813 — 82% of free trial left",
    );
  });

  it("falls back to consumption rather than implying a remaining figure", () => {
    const snapshot = resource({
      usage: {
        totalTokens: 353_000,
        inputTokens: 349_000,
        outputTokens: 4_000,
        scope: "model",
      },
    });
    expect(modelResourceOptionSuffix(snapshot)).toBe("353K used");
    expect(modelOptionLabel(model, snapshot)).toBe(
      "liuqi9 · deepseek-v4-pro-ga 260813 — 353K used",
    );
  });

  it("says nothing when neither quota nor usage was reported", () => {
    expect(modelResourceOptionSuffix(resource())).toBeNull();
    expect(modelResourceOptionSuffix(null)).toBeNull();
    expect(modelOptionLabel(model, null)).toBe("liuqi9 · deepseek-v4-pro-ga 260813");
    expect(modelOptionLabel({ id: "ep-2" }, null)).toBe("ep-2");
  });
});
