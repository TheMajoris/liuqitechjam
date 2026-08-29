/**
 * A model scope is intentionally explicit. Middleware/supervisor models and
 * worker models may share a provider without sharing an execution contract.
 */
export type ModelScope = "worker" | "supervisor";

/**
 * Normalized reasoning values. The worker runtime currently advertises no
 * reasoning controls; keeping the type here lets a verified provider add
 * them without leaking SDK-specific values into the API.
 */
export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ModelRef {
  providerId: string;
  modelId: string;
  reasoning?: {
    effort?: ReasoningEffort;
  };
}

export interface ModelDescriptor {
  id: string;
  label: string;
  providerId: string;
  capabilities: {
    scopes: ModelScope[];
    reasoning: boolean;
    reasoningEfforts?: ReasoningEffort[];
  };
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  capabilities: {
    worker: boolean;
    supervisor: boolean;
    dynamicModelListing: boolean;
  };
}

/**
 * Runtime-specific worker configuration. It deliberately contains no API
 * key, base URL, or other credential; those remain in the trusted process
 * environment/configuration used by the runner.
 */
export interface WorkerRuntimeModelConfig {
  providerId: string;
  modelId: string;
  codexModel: string;
  usesDefaultModel: boolean;
}

export interface ModelProviderAdapter {
  readonly id: string;
  describe(): ProviderDescriptor;
  listModels(input: { scope: ModelScope }): Promise<ModelDescriptor[]>;
}

export interface WorkerModelResolver {
  resolve(modelRef?: ModelRef): WorkerRuntimeModelConfig;
  /** Optional catalog-safe seam for visibility filtering and diagnostics. */
  resolveSafe?(modelRef?: ModelRef): {
    ok: true;
    model: WorkerRuntimeModelConfig;
  } | {
    ok: false;
    code: string;
    message: string;
  };
  /** Optional fast check that must use the same authority as resolve(). */
  isResolvable?(modelRef?: ModelRef): boolean;
  /** Optional persistence helpers used to materialize defaults on new Agents. */
  defaultModelRef?(): ModelRef | undefined;
  effectiveModelRef?(modelRef?: ModelRef): ModelRef | undefined;
}

export interface ModelRegistry {
  listProviders(scope: ModelScope): Promise<ProviderDescriptor[]>;
  listModels(providerId: string, scope: ModelScope): Promise<ModelDescriptor[]>;
  resolveWorkerModel(modelRef?: ModelRef): WorkerRuntimeModelConfig;
  validateWorkerModelRef(modelRef: ModelRef): void;
}
