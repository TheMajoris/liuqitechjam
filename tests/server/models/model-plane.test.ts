import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../apps/server/src/app.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import {
  ArkModelProvider,
  ARK_WORKER_PROVIDER_ID,
} from "../../../apps/server/src/models/ark-provider.js";
import { ModelListCache } from "../../../apps/server/src/models/cache.js";
import { ModelCatalogError } from "../../../apps/server/src/models/errors.js";
import { ModelRegistryService } from "../../../apps/server/src/models/registry.js";
import {
  ArkWorkerModelResolver,
  WorkerModelResolver,
} from "../../../apps/server/src/models/worker-model-resolver.js";
import type {
  ModelDescriptor,
  ModelProviderAdapter,
  ModelRegistry,
  ModelScope,
  ProviderDescriptor,
  WorkerRuntimeModelConfig,
} from "../../../apps/server/src/models/types.js";
import type { AgentService } from "../../../apps/server/src/agent-service.js";

describe("worker model configuration", () => {
  it("always includes the configured default in the deduplicated curated list", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_MODEL: " ep-default ",
      WORKER_CURATED_MODELS: "ep-worker-a, ep-default, ,ep-worker-b",
    });
    expect(config.workerCuratedModels).toEqual([
      "ep-default",
      "ep-worker-a",
      "ep-worker-b",
    ]);
  });
});

const arkProvider = (overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor => ({
  id: ARK_WORKER_PROVIDER_ID,
  label: "BytePlus ModelArk",
  capabilities: {
    worker: true,
    supervisor: true,
    dynamicModelListing: true,
    ...overrides.capabilities,
  },
  ...overrides,
});

function model(
  id: string,
  providerId = ARK_WORKER_PROVIDER_ID,
  scopes: ModelScope[] = ["worker"],
): ModelDescriptor {
  return {
    id,
    label: id,
    providerId,
    capabilities: {
      scopes,
      reasoning: false,
    },
  };
}

function runtimeModel(modelId: string): WorkerRuntimeModelConfig {
  return {
    providerId: ARK_WORKER_PROVIDER_ID,
    modelId,
    codexModel: modelId,
    usesDefaultModel: false,
  };
}

describe("Ark worker model provider", () => {
  it("discovers only configured worker models and sends credentials server-side", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://ark.example/api/v3/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
      return new Response(
        JSON.stringify({
          data: [
            { id: "ep-worker-a" },
            { id: "embedding-model" },
            { id: "ep-worker-a" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = new ArkModelProvider({
      apiKey: "secret-key",
      baseUrl: "https://ark.example/api/v3",
      curatedModelIds: ["ep-worker-a"],
      fetchImpl,
    });

    await expect(provider.listModels({ scope: "worker" })).resolves.toEqual([
      model("ep-worker-a"),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(await provider.listModels({ scope: "worker" }));
    expect(serialized).not.toContain("secret-key");
  });

  it("uses the curated catalog when discovery is unavailable", async () => {
    const provider = new ArkModelProvider({
      apiKey: "secret-key",
      baseUrl: "https://ark.example/api/v3",
      curatedModelIds: ["ep-default", "ep-curated"],
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new Error("network failure");
      }),
    });

    await expect(provider.listModels({ scope: "worker" })).resolves.toEqual([
      model("ep-default"),
      model("ep-curated"),
    ]);
  });

  it("normalizes provider failures when no safe fallback exists", async () => {
    const provider = new ArkModelProvider({
      apiKey: "secret-key",
      baseUrl: "https://ark.example/api/v3",
      curatedModelIds: [],
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("no", { status: 503 })),
    });

    await expect(provider.listModels({ scope: "worker" })).rejects.toMatchObject({
      code: "MODEL_PROVIDER_UNAVAILABLE",
      statusCode: 503,
    });
  });
});

describe("Worker model resolver and registry", () => {
  it("resolves the configured default and rejects unsupported reasoning", () => {
    const resolver = new ArkWorkerModelResolver({
      defaultModelId: "ep-default",
      allowedModelIds: ["ep-worker-a"],
    });

    expect(resolver.resolve()).toEqual({
      providerId: ARK_WORKER_PROVIDER_ID,
      modelId: "ep-default",
      codexModel: "ep-default",
      usesDefaultModel: true,
    });
    expect(
      resolver.resolve({
        providerId: ARK_WORKER_PROVIDER_ID,
        modelId: "ep-worker-a",
      }),
    ).toEqual(runtimeModel("ep-worker-a"));
    try {
      resolver.resolve({
        providerId: ARK_WORKER_PROVIDER_ID,
        modelId: "ep-worker-a",
        reasoning: { effort: "medium" },
      });
      throw new Error("expected reasoning validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_REASONING_NOT_SUPPORTED" });
    }
  });

  it("enforces Q5 by filtering every worker descriptor through the resolver", async () => {
    const provider: ModelProviderAdapter = {
      id: ARK_WORKER_PROVIDER_ID,
      describe: () => arkProvider(),
      listModels: async () => [
        model("safe"),
        model("unsafe"),
        model("wrong-provider", "other-provider"),
      ],
    };
    const resolve = vi.fn((ref: { providerId: string; modelId: string }) => {
      if (ref.modelId !== "safe") {
        throw new ModelCatalogError(
          "MODEL_NOT_SUPPORTED_FOR_WORKER",
          422,
          "The selected model cannot run worker Agents",
        );
      }
      return runtimeModel(ref.modelId);
    });
    const registry = new ModelRegistryService(
      [provider],
      { resolve },
      { cacheTtlMs: 60_000 },
    );

    await expect(registry.listModels(ARK_WORKER_PROVIDER_ID, "worker")).resolves.toEqual([
      model("safe"),
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith({
      providerId: ARK_WORKER_PROVIDER_ID,
      modelId: "safe",
    });
    expect(resolve).toHaveBeenCalledWith({
      providerId: ARK_WORKER_PROVIDER_ID,
      modelId: "unsafe",
    });
  });

  it("caches safe model metadata and returns cloned values", async () => {
    let now = 1_000;
    const cache = new ModelListCache<ModelDescriptor[]>(() => now);
    const listModels = vi.fn(async () => [model("ep-worker-a")]);
    const provider: ModelProviderAdapter = {
      id: ARK_WORKER_PROVIDER_ID,
      describe: () => arkProvider(),
      listModels,
    };
    const resolver = new ArkWorkerModelResolver({
      defaultModelId: "ep-worker-a",
      allowedModelIds: [],
    });
    const registry = new ModelRegistryService([provider], resolver, {
      cache,
      cacheTtlMs: 100,
    });

    const first = await registry.listModels(ARK_WORKER_PROVIDER_ID, "worker");
    first[0]!.label = "mutated";
    await registry.listModels(ARK_WORKER_PROVIDER_ID, "worker");
    expect(listModels).toHaveBeenCalledTimes(1);

    now = 1_101;
    await registry.listModels(ARK_WORKER_PROVIDER_ID, "worker");
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("serves stale safe metadata when a refresh fails", async () => {
    let fail = false;
    const listModels = vi.fn(async () => {
      if (fail) throw new Error("provider unavailable");
      return [model("ep-worker-a")];
    });
    const provider: ModelProviderAdapter = {
      id: ARK_WORKER_PROVIDER_ID,
      describe: () => arkProvider(),
      listModels,
    };
    let now = 1_000;
    const registry = new ModelRegistryService(
      [provider],
      new ArkWorkerModelResolver({
        defaultModelId: "ep-worker-a",
        allowedModelIds: [],
      }),
      {
        cache: new ModelListCache(() => now),
        cacheTtlMs: 100,
      },
    );

    await registry.listModels(ARK_WORKER_PROVIDER_ID, "worker");
    fail = true;
    now = 1_101;
    await expect(registry.listModels(ARK_WORKER_PROVIDER_ID, "worker")).resolves.toEqual([
      model("ep-worker-a"),
    ]);
  });
});

describe("model provider HTTP routes", () => {
  const service = {
    listAgents: () => [],
    systemInfo: async () => ({}),
    createAgent: async () => ({}) as never,
    updateAgent: async () => ({}) as never,
  } as unknown as AgentService;

  function makeRegistry(): ModelRegistry {
    const resolver = new ArkWorkerModelResolver({
      defaultModelId: "ep-default",
      allowedModelIds: ["ep-default", "ep-worker-a"],
    });
    const provider: ModelProviderAdapter = {
      id: ARK_WORKER_PROVIDER_ID,
      describe: () => arkProvider(),
      listModels: async () => [model("ep-default"), model("ep-worker-a")],
    };
    return new ModelRegistryService([provider], resolver);
  }

  it("returns worker providers, the configured default, and safe models", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", ARK_MODEL: "ep-default" }),
      service,
      undefined,
      makeRegistry(),
    );
    const providers = await app.inject({
      method: "GET",
      url: "/api/model-providers?scope=worker",
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toEqual({
      providers: [arkProvider()],
      defaultModelRef: {
        providerId: ARK_WORKER_PROVIDER_ID,
        modelId: "ep-default",
      },
    });

    const models = await app.inject({
      method: "GET",
      url: "/api/model-providers/volcengine_ark/models?scope=worker",
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({ models: [model("ep-default"), model("ep-worker-a")] });
    await app.close();
  });

  it("returns stable errors and does not invoke AgentService for invalid model refs", async () => {
    const createAgent = vi.fn(async () => ({}) as never);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      { ...service, createAgent } as unknown as AgentService,
      undefined,
      makeRegistry(),
    );

    const unknownProvider = await app.inject({
      method: "GET",
      url: "/api/model-providers/unknown/models?scope=worker",
    });
    expect(unknownProvider.statusCode).toBe(404);
    expect(unknownProvider.json()).toMatchObject({
      errorCode: "MODEL_PROVIDER_NOT_FOUND",
    });

    const invalidModel = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: {
        name: "Invalid",
        modelRef: {
          providerId: ARK_WORKER_PROVIDER_ID,
          modelId: "not-allowlisted",
        },
      },
    });
    expect(invalidModel.statusCode).toBe(422);
    expect(invalidModel.json()).toMatchObject({ errorCode: "MODEL_NOT_FOUND" });
    expect(createAgent).not.toHaveBeenCalled();

    const invalidEffort = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: {
        name: "Invalid reasoning",
        modelRef: {
          providerId: ARK_WORKER_PROVIDER_ID,
          modelId: "ep-default",
          reasoning: { effort: "unknown" },
        },
      },
    });
    expect(invalidEffort.statusCode).toBe(422);
    expect(invalidEffort.json()).toMatchObject({
      errorCode: "MODEL_REASONING_EFFORT_INVALID",
    });
    expect(createAgent).not.toHaveBeenCalled();
    await app.close();
  });

  it("validates and forwards an explicit modelRef without exposing provider secrets", async () => {
    const createAgent = vi.fn(async (input: unknown) => ({
      id: "agent",
      ...(input as object),
    }) as never);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", ARK_API_KEY: "server-secret", ARK_MODEL: "ep-default" }),
      { ...service, createAgent } as unknown as AgentService,
      undefined,
      makeRegistry(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: {
        name: "Worker",
        modelRef: {
          providerId: ARK_WORKER_PROVIDER_ID,
          modelId: "ep-worker-a",
        },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(createAgent).toHaveBeenCalledWith({
      name: "Worker",
      modelRef: {
        providerId: ARK_WORKER_PROVIDER_ID,
        modelId: "ep-worker-a",
      },
    });
    expect(response.body).not.toContain("server-secret");
    await app.close();
  });

  it("keeps model routes behind the existing bearer-token boundary", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      undefined,
      makeRegistry(),
    );
    const denied = await app.inject({ method: "GET", url: "/api/model-providers" });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });
});
