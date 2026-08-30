import { describe, expect, it } from "vitest";
import {
  ArkWorkerModelResolver,
  normalizeModelRef,
  WorkerModelResolver,
} from "../../../apps/server/src/models/worker-model-resolver.js";

describe("ArkWorkerModelResolver", () => {
  const makeResolver = () =>
    new ArkWorkerModelResolver({
      defaultModelId: "ep-default",
      allowedModelIds: ["ep-worker-b"],
    });

  it("resolves a legacy Agent to the configured default", () => {
    const model = makeResolver().resolve();

    expect(model).toEqual({
      providerId: "volcengine_ark",
      modelId: "ep-default",
      codexModel: "ep-default",
      usesDefaultModel: true,
    });
  });

  it("resolves curated explicit models without returning credentials", () => {
    const model = makeResolver().resolve({
      providerId: "volcengine_ark",
      modelId: "ep-worker-b",
    });

    expect(model).toEqual({
      providerId: "volcengine_ark",
      modelId: "ep-worker-b",
      codexModel: "ep-worker-b",
      usesDefaultModel: false,
    });
    expect(JSON.stringify(model)).not.toContain("ARK_API_KEY");
  });

  it("rejects providers, models, and reasoning that the worker cannot execute", () => {
    expect(() =>
      makeResolver().resolve({ providerId: "other", modelId: "model" }),
    ).toThrowError(
      expect.objectContaining({ code: "MODEL_PROVIDER_NOT_FOUND" }),
    );
    expect(() =>
      makeResolver().resolve({
        providerId: "volcengine_ark",
        modelId: "not-curated",
      }),
    ).toThrowError(expect.objectContaining({ code: "MODEL_NOT_FOUND" }));
    expect(() =>
      makeResolver().resolve({
        providerId: "volcengine_ark",
        modelId: "ep-worker-b",
        reasoning: { effort: "medium" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "MODEL_REASONING_NOT_SUPPORTED" }),
    );
  });

  it("reports invalid effort values and provides a catalog-safe check", () => {
    expect(() =>
      normalizeModelRef({
        providerId: "volcengine_ark",
        modelId: "ep-default",
        reasoning: { effort: "bogus" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "MODEL_REASONING_EFFORT_INVALID" }),
    );

    const resolver = makeResolver();
    expect(resolver.resolveSafe({
      providerId: "volcengine_ark",
      modelId: "ep-worker-b",
    })).toMatchObject({ ok: true });
    expect(resolver.isResolvable({
      providerId: "volcengine_ark",
      modelId: "not-curated",
    })).toBe(false);
  });

  it("normalizes catalog failures at the resolver boundary", () => {
    const resolver = new WorkerModelResolver({
      defaultModelRef: {
        providerId: "volcengine_ark",
        modelId: "ep-default",
      },
      catalog: {
        getProvider() {
          throw new Error("provider secret should not escape");
        },
        getModel() {
          return undefined;
        },
      },
    });

    expect(resolver.resolveSafe()).toEqual({
      ok: false,
      code: "MODEL_PROVIDER_UNAVAILABLE",
      message: "The selected worker model provider is unavailable.",
    });
  });

  it("fails safely when no default runtime model is configured", () => {
    expect(() =>
      new ArkWorkerModelResolver({ defaultModelId: "", allowedModelIds: [] }).resolve(),
    ).toThrowError(
      expect.objectContaining({
        code: "MODEL_RUNTIME_CONFIGURATION_INVALID",
        statusCode: 503,
      }),
    );
  });
});
