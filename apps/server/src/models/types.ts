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

/**
 * Safe, provider-neutral projection of an inference endpoint. The provider
 * status is normalized by the ModelArk adapter; only `running` is selectable
 * by worker Agents.
 */
export type ModelEndpointStatus = "running" | "not_running" | "unknown";

export interface ModelEndpointResource {
  providerId: string;
  modelId: string;
  name: string | null;
  foundationModel: { name: string; version: string } | null;
  status: ModelEndpointStatus;
  statusReason: string | null;
  rateLimit: {
    rpm: number | null;
    tpm: number | null;
  };
  /** Usage for this endpoint only; never provider-wide totals. */
  usage: ModelUsageCounters | null;
  /** Free-token quota from the matching foundation-model activation record. */
  quota: ModelQuotaSnapshot | null;
  /**
   * Configured context window for this model, or null when none is set.
   *
   * Carried beside the provider's own figures because it is the one limit that
   * actually constrains a turn: a prompt larger than the window is refused,
   * while an exhausted free-token grant only changes what the turn costs.
   */
  contextWindowTokens: number | null;
  observedAt: string;
}

export type ModelUsageAvailability = "available" | "partial" | "unavailable";

/** Provider usage counters preserve unknown values as null. */
export interface ModelUsageCounters {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requests: number | null;
}

/** Normalized account quota for one foundation model. */
export interface ModelQuotaSnapshot {
  usedTokens: number;
  totalTokens: number;
  remainingTokens: number;
}

/** A provider usage row, optionally keyed by a ModelArk endpoint. */
export interface ModelInferenceUsageRow extends ModelUsageCounters {
  modelEndpoint: string | null;
}

/**
 * ModelArk's GetInferenceUsage response exposes a bounded data count for the
 * selected interval. It is deliberately not called a token count: the API's
 * count is not a quota or context-window measurement.
 */
export interface ModelInferenceUsage {
  availability: ModelUsageAvailability;
  dataCount: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requests: number | null;
  queryInterval: "Hour" | "Day";
  startTime: string;
  endTime: string;
  observedAt: string | null;
  rows: ModelInferenceUsageRow[];
}

/** Current server-owned ModelArk resource/usage view. */
export interface ModelResourceView {
  providerId: string;
  availability: ModelUsageAvailability;
  stale: boolean;
  fetchedAt: string | null;
  revision: number;
  endpoints: ModelEndpointResource[];
  inferenceUsage: ModelInferenceUsage | null;
  error: string | null;
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
  /** Optional live refresh used before Agent validation/run acceptance. */
  refresh?(force?: boolean): Promise<void>;
}

export interface ModelRegistry {
  listProviders(scope: ModelScope): Promise<ProviderDescriptor[]>;
  listModels(providerId: string, scope: ModelScope): Promise<ModelDescriptor[]>;
  resolveWorkerModel(modelRef?: ModelRef): WorkerRuntimeModelConfig;
  validateWorkerModelRef(modelRef: ModelRef): void;
  /** Drop dynamic discovery results after an operator catalog replacement. */
  invalidate?(): void;
  /** Refresh dynamic discovery; `true` bypasses all live caches. */
  refresh?(force?: boolean): Promise<void>;
  /** Current safe ModelArk resource state, when the provider supports it. */
  modelResources?(options?: { force?: boolean }): Promise<ModelResourceView>;
}
