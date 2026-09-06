import { describe, expect, it } from "vitest";
import type { ModelResourceSnapshot } from "../../apps/web/src/types";
import {
  modelResourceCapacityLabel,
  modelResourceQuotaPercent,
  modelResourceQuotaTone,
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

describe("model resource capacity copy", () => {
  it("formats a provider-reported remaining percentage for the compact room surface", () => {
    const snapshot = resource({
      quota: { usedTokens: 66, totalTokens: 100, remainingTokens: 34 },
    });
    expect(modelResourceQuotaPercent(snapshot)).toBe(34);
    expect(modelResourceCapacityLabel(snapshot)).toBe("34% tokens left");
  });

  it("does not infer a percentage from usage counters", () => {
    const snapshot = resource({
      usage: {
        totalTokens: 66,
        inputTokens: 50,
        outputTokens: 16,
        scope: "model",
      },
    });
    expect(modelResourceQuotaPercent(snapshot)).toBeNull();
    expect(modelResourceCapacityLabel(snapshot)).toBe("Tokens left —%");
  });

  it("rejects an incoherent quota instead of showing a false percentage", () => {
    const snapshot = resource({
      quota: { usedTokens: 120, totalTokens: 100, remainingTokens: 0 },
    });
    expect(modelResourceQuotaPercent(snapshot)).toBeNull();
    expect(modelResourceCapacityLabel(snapshot)).toBe("Tokens left —%");
  });
});

describe("model resource capacity bands", () => {
  function toneFor(remainingTokens: number) {
    return modelResourceQuotaTone(
      resource({
        quota: { usedTokens: 100 - remainingTokens, totalTokens: 100, remainingTokens },
      }),
    );
  }

  it("colours capacity green at or above 70% remaining", () => {
    expect(toneFor(100)).toBe("healthy");
    expect(toneFor(70)).toBe("healthy");
  });

  it("colours capacity amber between 20% and 70% remaining", () => {
    expect(toneFor(69)).toBe("warning");
    expect(toneFor(20)).toBe("warning");
  });

  it("colours capacity red below 20% remaining", () => {
    expect(toneFor(19)).toBe("critical");
    expect(toneFor(0)).toBe("critical");
  });

  it("reports an unknown tone for a stale snapshot", () => {
    expect(
      modelResourceQuotaTone(
        resource({
          freshness: "stale",
          quota: { usedTokens: 10, totalTokens: 100, remainingTokens: 90 },
        }),
      ),
    ).toBe("unknown");
  });
});
