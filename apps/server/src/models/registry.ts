import type { AppConfig } from "../config.js";
import { ArkModelProvider } from "./ark-provider.js";
import { ModelListCache } from "./cache.js";
import { ModelCatalogError } from "./errors.js";
import { createWorkerModelResolver } from "./worker-model-resolver.js";
import type {
  ModelDescriptor,
  ModelProviderAdapter,
  ModelRef,
  ModelRegistry,
  ModelScope,
  ProviderDescriptor,
  WorkerModelResolver,
  WorkerRuntimeModelConfig,
} from "./types.js";

export interface ModelRegistryOptions {
  providers?: readonly ModelProviderAdapter[];
  workerResolver?: WorkerModelResolver;
  cache?: ModelListCache<ModelDescriptor[]>;
  cacheTtlMs?: number;
}

function cloneDescriptors(descriptors: readonly ModelDescriptor[]): ModelDescriptor[] {
  return descriptors.map((model) => ({
    ...model,
    capabilities: {
      ...model.capabilities,
      scopes: [...model.capabilities.scopes],
      ...(model.capabilities.reasoningEfforts === undefined
        ? {}
        : { reasoningEfforts: [...model.capabilities.reasoningEfforts] }),
    },
  }));
}

function cloneProviders(providers: readonly ProviderDescriptor[]): ProviderDescriptor[] {
  return providers.map((provider) => ({
    ...provider,
    capabilities: { ...provider.capabilities },
  }));
}

function supportsScope(provider: ProviderDescriptor, scope: ModelScope): boolean {
  return scope === "worker"
    ? provider.capabilities.worker
    : provider.capabilities.supervisor;
}

/**
 * Safe model metadata facade used by HTTP and Agent services. Worker models
 * are filtered through the same resolver that produces Codex runtime config;
 * provider discovery alone is never enough to make a model selectable.
 */
export class ModelRegistryService implements ModelRegistry {
  readonly workerModelResolver: WorkerModelResolver;

  private readonly providers: readonly ModelProviderAdapter[];
  private readonly providerById: ReadonlyMap<string, ModelProviderAdapter>;
  private readonly cache: ModelListCache<ModelDescriptor[]>;
  private readonly cacheTtlMs: number;

  constructor(
    providers: readonly ModelProviderAdapter[],
    workerResolver: WorkerModelResolver,
    options: Pick<ModelRegistryOptions, "cache" | "cacheTtlMs"> = {},
  ) {
    this.providers = [...providers];
    this.providerById = new Map(this.providers.map((provider) => [provider.id, provider]));
    this.workerModelResolver = workerResolver;
    this.cache = options.cache ?? new ModelListCache<ModelDescriptor[]>();
    const cacheTtlMs = options.cacheTtlMs;
    this.cacheTtlMs =
      cacheTtlMs !== undefined && Number.isInteger(cacheTtlMs) && cacheTtlMs > 0
      ? cacheTtlMs
      : 600_000;
  }

  async listProviders(scope: ModelScope): Promise<ProviderDescriptor[]> {
    const descriptors = this.providers
      .map((provider) => provider.describe())
      .filter((provider) => supportsScope(provider, scope));
    return cloneProviders(descriptors);
  }

  async listModels(providerId: string, scope: ModelScope): Promise<ModelDescriptor[]> {
    const normalizedProviderId = providerId.trim();
    const provider = this.providerById.get(normalizedProviderId);
    if (!provider) {
      throw new ModelCatalogError(
        "MODEL_PROVIDER_NOT_FOUND",
        404,
        "The requested model provider is not available",
      );
    }

    const description = provider.describe();
    if (!supportsScope(description, scope)) {
      throw new ModelCatalogError(
        "MODEL_NOT_SUPPORTED_FOR_WORKER",
        422,
        "The requested provider does not support this model scope",
      );
    }

    const cacheKey = scope + ":" + normalizedProviderId;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cloneDescriptors(cached);

    let listed: ModelDescriptor[];
    try {
      listed = await provider.listModels({ scope });
    } catch (error) {
      const stale = this.cache.getStale(cacheKey);
      if (stale !== undefined) return cloneDescriptors(stale);
      if (error instanceof ModelCatalogError) throw error;
      throw new ModelCatalogError(
        "MODEL_LIST_FAILED",
        502,
        "Unable to load models from the requested provider",
      );
    }

    const safe = listed.filter((model) => {
      if (model.providerId !== normalizedProviderId) return false;
      if (!model.capabilities.scopes.includes(scope)) return false;
      if (scope !== "worker") return true;
      try {
        // Q5 invariant: every displayed worker model must resolve into the
        // credential-free Codex runtime configuration accepted by the worker.
        this.workerModelResolver.resolve({
          providerId: normalizedProviderId,
          modelId: model.id,
        });
        return true;
      } catch {
        return false;
      }
    });
    this.cache.set(cacheKey, cloneDescriptors(safe), this.cacheTtlMs);
    return cloneDescriptors(safe);
  }

  resolveWorkerModel(modelRef?: ModelRef): WorkerRuntimeModelConfig {
    return this.workerModelResolver.resolve(modelRef);
  }

  validateWorkerModelRef(modelRef: ModelRef): void {
    this.workerModelResolver.resolve(modelRef);
  }
}

export function createModelRegistry(
  config: Pick<
    AppConfig,
    | "arkApiKey"
    | "arkBaseUrl"
    | "arkModel"
    | "workerCuratedModels"
    | "workerModelListTimeoutMs"
    | "workerModelCacheTtlMs"
  >,
  options: ModelRegistryOptions = {},
): ModelRegistryService {
  const workerResolver =
    options.workerResolver ?? createWorkerModelResolver(config);
  const providers =
    options.providers ?? [
      new ArkModelProvider({
        apiKey: config.arkApiKey,
        baseUrl: config.arkBaseUrl,
        curatedModelIds: config.workerCuratedModels,
        timeoutMs: config.workerModelListTimeoutMs,
      }),
    ];
  return new ModelRegistryService(providers, workerResolver, {
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    cacheTtlMs: options.cacheTtlMs ?? config.workerModelCacheTtlMs,
  });
}
