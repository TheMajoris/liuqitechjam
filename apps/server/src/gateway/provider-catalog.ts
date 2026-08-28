import type { GatewayProviderConfig } from "./config.js";
import { DeterministicMockProvider } from "./providers/deterministic-mock-provider.js";
import { ResponsesHttpProvider } from "./providers/responses-http-provider.js";
import type {
  ProviderHealth,
  ProviderSummary,
  ResponsesProvider,
} from "./types.js";

/**
 * Thrown by `resolve` for an unknown provider id. Unknown ids fail closed:
 * no provider is constructed and no upstream call is made.
 */
export class ProviderNotFoundError extends Error {
  readonly code = "PROVIDER_NOT_FOUND" as const;
  constructor(readonly providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = "ProviderNotFoundError";
  }
}

/** Small use-case interface so tests can inject a spy catalog. */
export interface ProviderCatalogPort {
  list(): ProviderSummary[];
  resolve(id: string): ResponsesProvider;
  has(id: string): boolean;
  allowsModel(id: string, model: string): boolean;
}

interface CatalogEntry {
  id: string;
  protocol: GatewayProviderConfig["protocol"];
  baseUrl: string | null;
  models: string[];
  health: ProviderHealth;
  provider: ResponsesProvider;
}

export interface ProviderCatalogOptions {
  /** Injected fetch for `responses-http` providers (used by tests). */
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export class ProviderCatalog implements ProviderCatalogPort {
  private readonly entries = new Map<string, CatalogEntry>();

  constructor(
    providers: readonly GatewayProviderConfig[],
    options: ProviderCatalogOptions = {},
  ) {
    for (const config of providers) {
      this.entries.set(config.id, {
        id: config.id,
        protocol: config.protocol,
        baseUrl: config.baseUrl,
        models: [...config.models],
        health: config.protocol === "mock" ? "ok" : "unknown",
        provider: ProviderCatalog.build(config, options),
      });
    }
  }

  private static build(
    config: GatewayProviderConfig,
    options: ProviderCatalogOptions,
  ): ResponsesProvider {
    if (config.protocol === "mock") {
      return new DeterministicMockProvider();
    }
    if (!config.baseUrl || !config.apiKey) {
      throw new Error(
        `Provider ${config.id} is missing a base URL or credential`,
      );
    }
    return new ResponsesHttpProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  /** SAFE descriptors only. No base URL, key env name, or credential value. */
  list(): ProviderSummary[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      protocol: entry.protocol,
      models: [...entry.models],
      credentialMode: "gateway-managed",
      health: entry.health,
    }));
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  allowsModel(id: string, model: string): boolean {
    const entry = this.entries.get(id);
    return entry ? entry.models.includes(model) : false;
  }

  resolve(id: string): ResponsesProvider {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new ProviderNotFoundError(id);
    }
    return entry.provider;
  }
}
