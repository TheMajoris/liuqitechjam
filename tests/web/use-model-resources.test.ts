import { describe, expect, it } from "vitest";
import { normalizeResponse } from "../../apps/web/src/playground/use-model-resources";
import { modelContextUsage, modelResourceQuotaLabel } from "../../apps/web/src/model-resource-format";
import type { ModelEndpointResource, ModelResourcesResponse } from "../../apps/web/src/types";

function endpoint(overrides: Partial<ModelEndpointResource> = {}): ModelEndpointResource {
  return {
    providerId: "volcengine_ark",
    modelId: "ep-agents",
    name: "agents",
    foundationModel: { name: "deepseek-v4-flash", version: "260425" },
    status: "running",
    statusReason: null,
    rateLimit: { rpm: null, tpm: null },
    usage: null,
    quota: null,
    observedAt: "2026-09-10T12:01:36.282Z",
    ...overrides,
  };
}

function response(endpoints: ModelEndpointResource[]): ModelResourcesResponse {
  return {
    providerId: "volcengine_ark",
    availability: "available",
    stale: false,
    fetchedAt: "2026-09-10T12:01:36.282Z",
    revision: 3,
    endpoints,
  } as ModelResourcesResponse;
}

describe("live model resource projection", () => {
  it("carries the server's configured context window through to the snapshot", () => {
    const { resources } = normalizeResponse(
      response([endpoint({ contextWindowTokens: 1_048_576 })]),
    );

    expect(resources[0]?.contextWindowTokens).toBe(1_048_576);
  });

  it("keeps an unconfigured window null rather than undefined", () => {
    const { resources } = normalizeResponse(response([endpoint()]));

    expect(resources[0]?.contextWindowTokens).toBeNull();
  });

  // The regression this covers: the window reached the browser but was dropped
  // in this projection, so every hover card read "No context window set for
  // this model" while the server was reporting a real one.
  it("produces real context copy for a turn once the window is projected", () => {
    const { resources } = normalizeResponse(
      response([endpoint({ contextWindowTokens: 1_048_576 })]),
    );
    const lastRun = { inputTokens: 38_900, outputTokens: 100 };

    expect(modelContextUsage(resources[0], lastRun)).toMatchObject({
      windowTokens: 1_048_576,
      usedTokens: 39_000,
    });
    expect(modelResourceQuotaLabel(resources[0], lastRun)).not.toBe(
      "No context window set for this model",
    );
  });
});
