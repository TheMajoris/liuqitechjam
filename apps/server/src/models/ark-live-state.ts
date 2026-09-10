import { ModelCatalogError } from "./errors.js";
import type {
  ModelDescriptor,
  ModelEndpointResource,
  ModelQuotaSnapshot,
  ModelResourceView,
  ModelScope,
  ModelUsageCounters,
  ModelUsageAvailability,
  ProviderDescriptor,
} from "./types.js";
import { ARK_WORKER_PROVIDER_ID, ARK_WORKER_PROVIDER_LABEL } from "./ark-provider.js";
import type {
  ArkEndpointRecord,
  ArkInferenceUsageRecord,
  ArkModelActivationRecord,
  ArkManagementClient,
} from "./ark-management-client.js";

export interface ArkLiveModelCatalog {
  getProvider(providerId: string): ProviderDescriptor | undefined;
  getModel(providerId: string, modelId: string): ModelDescriptor | undefined;
}

export interface ArkLiveModelStateOptions {
  client: ArkManagementClient;
  ttlMs?: number;
  /** Optional test/deployment override; always capped by the endpoint TTL. */
  usageTtlMs?: number;
  /**
   * Endpoint reserved for supervisor routing. It is hidden from every worker
   * listing and rejected by worker resolution, but stays in the resource
   * projection so its consumption remains observable.
   */
  reservedSupervisorModelId?: () => string | null | undefined;
  /**
   * Configured context windows, by endpoint id or foundation-model name.
   *
   * Neither Codex nor the ModelArk catalogue reports a window, so it is stated
   * in configuration and carried here: it is the one limit that actually
   * refuses a turn, unlike a free-token grant, which only changes the price.
   */
  contextWindows?: ReadonlyMap<string, number>;
  now?: () => number;
}

export interface ArkLiveRefreshOptions {
  /** Drop the current snapshot and start a new provider read. */
  force?: boolean;
}

interface CacheEntry<T> {
  value: T;
  fetchedAtMs: number;
  expiresAtMs: number;
  revision: number;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_USAGE_TTL_MS = 20_000;

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ModelCatalogError) return error.message;
  return "ModelArk management data is unavailable";
}

function cloneEndpoint(endpoint: ArkEndpointRecord): ArkEndpointRecord {
  return {
    ...endpoint,
    foundationModel: endpoint.foundationModel === null
      ? null
      : { ...endpoint.foundationModel },
    rateLimit: { ...endpoint.rateLimit },
  };
}

function cloneModelActivation(activation: ArkModelActivationRecord): ArkModelActivationRecord {
  return {
    ...activation,
    initialInferenceFreeUsage: activation.initialInferenceFreeUsage === null
      ? null
      : { ...activation.initialInferenceFreeUsage },
    freeInferenceUsage: activation.freeInferenceUsage === null
      ? null
      : { ...activation.freeInferenceUsage },
  };
}

function endpointUsage(
  usage: ArkInferenceUsageRecord | undefined,
  endpointId: string,
): ModelUsageCounters | null {
  const rows = usage?.rows.filter((row) => row.modelEndpoint === endpointId) ?? [];
  if (rows.length === 0) return null;
  const sum = (field: keyof ModelUsageCounters): number | null => {
    let total = 0;
    let found = false;
    for (const row of rows) {
      const value = row[field];
      if (value === null) continue;
      if (total > Number.MAX_SAFE_INTEGER - value) return null;
      total += value;
      found = true;
    }
    return found ? total : null;
  };
  return {
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    requests: sum("requests"),
  };
}

/**
 * Resolve the free-token quota ModelArk reports for a foundation model.
 *
 * An activated model exposes its live counters through FreeResourcePackItems;
 * InitialInferenceFreeUsage is populated only while the model is still
 * unactivated, so it is a fallback and never the primary source.
 */
function activationQuota(
  activation: ArkModelActivationRecord | undefined,
): { total: number; consumed: number } | null {
  if (activation === undefined) return null;
  const pack = activation.freeInferenceUsage;
  if (pack !== null && pack !== undefined) return pack;
  const initial = activation.initialInferenceFreeUsage;
  if (!initial || initial.total === null || initial.consumed === null) return null;
  return { total: initial.total, consumed: initial.consumed };
}

function endpointResource(
  endpoint: ArkEndpointRecord,
  usage?: ArkInferenceUsageRecord,
  activations?: ReadonlyMap<string, ArkModelActivationRecord>,
  contextWindows?: ReadonlyMap<string, number>,
): ModelEndpointResource {
  const usageCounters = endpointUsage(usage, endpoint.id);
  const freeUsage = endpoint.foundationModel === null
    ? null
    : activationQuota(activations?.get(endpoint.foundationModel.name));
  // A pack consumed past its grant still means "nothing left" rather than an
  // incoherent snapshot, so the used counter is clamped to the total.
  const quota: ModelQuotaSnapshot | null =
    freeUsage !== null && freeUsage.total > 0
      ? {
          usedTokens: Math.min(freeUsage.consumed, freeUsage.total),
          totalTokens: freeUsage.total,
          remainingTokens: Math.max(0, freeUsage.total - freeUsage.consumed),
        }
      : null;
  return {
    providerId: ARK_WORKER_PROVIDER_ID,
    modelId: endpoint.id,
    name: endpoint.name,
    foundationModel: endpoint.foundationModel === null
      ? null
      : { ...endpoint.foundationModel },
    status:
      endpoint.status === "running"
        ? "running"
        : endpoint.status.length > 0
          ? "not_running"
          : "unknown",
    statusReason: endpoint.statusReason,
    rateLimit: { ...endpoint.rateLimit },
    usage: usageCounters,
    quota,
    // Endpoint id first so one endpoint can be pinned, then foundation model,
    // which is how a window is published and which survives an endpoint being
    // recreated — as one was here mid-session.
    contextWindowTokens:
      contextWindows?.get(endpoint.id) ??
      (endpoint.foundationModel === null
        ? undefined
        : contextWindows?.get(endpoint.foundationModel.name)) ??
      null,
    observedAt: endpoint.observedAt,
  };
}

function descriptorForEndpoint(endpoint: ArkEndpointRecord, scope: ModelScope): ModelDescriptor {
  const modelLabel = endpoint.foundationModel === null
    ? null
    : endpoint.foundationModel.name + " " + endpoint.foundationModel.version;
  return {
    id: endpoint.id,
    label: endpoint.name === null
      ? modelLabel ?? endpoint.id
      : modelLabel === null
        ? endpoint.name
        : endpoint.name + " · " + modelLabel,
    providerId: ARK_WORKER_PROVIDER_ID,
    capabilities: {
      scopes: [scope],
      reasoning: false,
    },
  };
}

function cloneUsage(usage: ArkInferenceUsageRecord): ArkInferenceUsageRecord {
  return {
    ...usage,
    rows: usage.rows.map((row) => ({ ...row })),
  };
}

/**
 * One live, server-owned ModelArk snapshot shared by selectors, resolver, and
 * the resource HTTP route. The persisted model catalog remains an operator
 * metadata/default store; this state is the execution authority.
 */
export class ArkLiveModelState implements ArkLiveModelCatalog {
  private readonly client: ArkManagementClient;
  private readonly ttlMs: number;
  private readonly usageTtlMs: number;
  private readonly activationTtlMs: number;
  private readonly reservedSupervisorModelId:
    | (() => string | null | undefined)
    | undefined;
  private readonly contextWindows: ReadonlyMap<string, number> | undefined;
  private readonly now: () => number;
  private endpointEntry: CacheEntry<ArkEndpointRecord[]> | undefined;
  private usageEntry: CacheEntry<ArkInferenceUsageRecord> | undefined;
  private activationEntry: CacheEntry<ArkModelActivationRecord[]> | undefined;
  private endpointInflight: Promise<ArkEndpointRecord[]> | undefined;
  private readonly usageInflight = new Map<string, Promise<ArkInferenceUsageRecord>>();
  private activationInflight: Promise<ArkModelActivationRecord[]> | undefined;
  private usageQueryKey: string | null = null;
  private endpointError: string | null = null;
  private usageError: string | null = null;
  private revision = 0;
  private generation = 0;

  constructor(options: ArkLiveModelStateOptions) {
    this.client = options.client;
    this.ttlMs = positiveLimit(options.ttlMs, DEFAULT_TTL_MS);
    // Endpoint membership changes slowly; usage should track an active
    // workspace closely without issuing one provider request per Agent.
    this.usageTtlMs = Math.min(
      positiveLimit(options.usageTtlMs, DEFAULT_USAGE_TTL_MS),
      this.ttlMs,
    );
    this.activationTtlMs = this.usageTtlMs;
    this.reservedSupervisorModelId = options.reservedSupervisorModelId;
    this.contextWindows = options.contextWindows;
    this.now = options.now ?? Date.now;
  }

  /** The supervisor endpoint currently withheld from worker selection. */
  private reservedWorkerModelId(): string | null {
    const reserved = this.reservedSupervisorModelId?.()?.trim();
    return reserved === undefined || reserved.length === 0 ? null : reserved;
  }

  getProvider(providerId: string): ProviderDescriptor | undefined {
    if (providerId !== ARK_WORKER_PROVIDER_ID) return undefined;
    return {
      id: ARK_WORKER_PROVIDER_ID,
      label: ARK_WORKER_PROVIDER_LABEL,
      capabilities: {
        worker: true,
        // Supervisor selection is still a separate central Responses path,
        // but the provider metadata remains compatible with existing callers.
        supervisor: true,
        dynamicModelListing: true,
      },
    };
  }

  getModel(providerId: string, modelId: string): ModelDescriptor | undefined {
    if (providerId !== ARK_WORKER_PROVIDER_ID) return undefined;
    // This seam is the worker resolver's validation gate, so the reserved
    // supervisor endpoint must fail here too. Hiding it from the listing
    // alone would still let a persisted assignment resolve.
    if (modelId === this.reservedWorkerModelId()) return undefined;
    const endpoint = this.endpointEntry?.value.find(
      (candidate) => candidate.id === modelId && candidate.status === "running",
    );
    return endpoint === undefined ? undefined : descriptorForEndpoint(endpoint, "worker");
  }

  async refresh(options: ArkLiveRefreshOptions = {}): Promise<void> {
    if (options.force) this.invalidate();
    await this.refreshEndpoints();
  }

  async refreshEndpoints(options: ArkLiveRefreshOptions = {}): Promise<ArkEndpointRecord[]> {
    if (options.force) this.invalidate();
    const current = this.endpointEntry;
    if (current !== undefined && current.expiresAtMs > this.now()) {
      return current.value.map(cloneEndpoint);
    }
    if (this.endpointInflight !== undefined) return this.endpointInflight.then((items) => items.map(cloneEndpoint));

    const generation = this.generation;
    const pending = this.client.listEndpoints()
      .then((items) => {
        if (generation !== this.generation) {
          throw new ModelCatalogError(
            "MODEL_PROVIDER_UNAVAILABLE",
            503,
            "The ModelArk endpoint refresh was superseded",
          );
        }
        const fetchedAtMs = this.now();
        this.revision += 1;
        this.endpointEntry = {
          value: items.map(cloneEndpoint),
          fetchedAtMs,
          expiresAtMs: fetchedAtMs + this.ttlMs,
          revision: this.revision,
        };
        this.endpointError = null;
        return items.map(cloneEndpoint);
      })
      .catch((error) => {
        if (generation === this.generation) this.endpointError = safeErrorMessage(error);
        throw error;
      })
      .finally(() => {
        if (this.endpointInflight === pending) this.endpointInflight = undefined;
      });
    this.endpointInflight = pending;
    return pending.then((items) => items.map(cloneEndpoint));
  }

  async refreshActivations(options: ArkLiveRefreshOptions = {}): Promise<ArkModelActivationRecord[]> {
    if (options.force) this.invalidate();
    const current = this.activationEntry;
    if (current !== undefined && current.expiresAtMs > this.now()) {
      return current.value.map(cloneModelActivation);
    }
    if (this.activationInflight !== undefined) {
      return this.activationInflight.then((items) => items.map(cloneModelActivation));
    }

    const generation = this.generation;
    const pending = this.client.listModelActivations()
      .then((items) => {
        if (generation !== this.generation) {
          throw new ModelCatalogError(
            "MODEL_PROVIDER_UNAVAILABLE",
            503,
            "The ModelArk model activation refresh was superseded",
          );
        }
        const fetchedAtMs = this.now();
        this.revision += 1;
        this.activationEntry = {
          value: items.map(cloneModelActivation),
          fetchedAtMs,
          expiresAtMs: fetchedAtMs + this.activationTtlMs,
          revision: this.revision,
        };
        return items.map(cloneModelActivation);
      })
      .finally(() => {
        if (this.activationInflight === pending) this.activationInflight = undefined;
      });
    this.activationInflight = pending;
    return pending.then((items) => items.map(cloneModelActivation));
  }

  async refreshUsage(
    query: {
      queryInterval?: "Hour" | "Day";
      startTime: string;
      endTime: string;
      showWindowDetail?: boolean;
      modelEndpoints?: readonly string[];
    },
    options: ArkLiveRefreshOptions = {},
  ): Promise<ArkInferenceUsageRecord> {
    if (options.force) this.invalidate();
    if (query.modelEndpoints === undefined || query.modelEndpoints.length === 0) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "ModelArk usage telemetry requires explicit endpoint IDs",
      );
    }
    const queryKey = JSON.stringify(query);
    const current = this.usageEntry;
    if (
      current !== undefined &&
      current.expiresAtMs > this.now() &&
      this.usageQueryKey === queryKey
    ) {
      return cloneUsage(current.value);
    }
    const inflight = this.usageInflight.get(queryKey);
    if (inflight !== undefined) return inflight.then(cloneUsage);

    const generation = this.generation;
    const pending = this.client.getInferenceUsage(query)
      .then((usage) => {
        if (generation !== this.generation) {
          throw new ModelCatalogError(
            "MODEL_PROVIDER_UNAVAILABLE",
            503,
            "The ModelArk usage refresh was superseded",
          );
        }
        const fetchedAtMs = this.now();
        this.usageEntry = {
          value: cloneUsage(usage),
          fetchedAtMs,
          expiresAtMs: fetchedAtMs + this.usageTtlMs,
          revision: this.revision,
        };
        this.usageQueryKey = queryKey;
        this.usageError = null;
        return cloneUsage(usage);
      })
      .catch((error) => {
        if (generation === this.generation) this.usageError = safeErrorMessage(error);
        throw error;
      })
      .finally(() => {
        if (this.usageInflight.get(queryKey) === pending) this.usageInflight.delete(queryKey);
      });
    this.usageInflight.set(queryKey, pending);
    return pending.then(cloneUsage);
  }

  listRunningDescriptors(scope: ModelScope): ModelDescriptor[] {
    const endpoints = this.endpointEntry?.value ?? [];
    // The supervisor picker needs the unfiltered list; only worker selection
    // withholds the endpoint that is currently reserved for routing.
    const reserved = scope === "worker" ? this.reservedWorkerModelId() : null;
    return endpoints
      .filter((endpoint) => endpoint.status === "running")
      .filter((endpoint) => endpoint.id !== reserved)
      .map((endpoint) => descriptorForEndpoint(endpoint, scope));
  }

  getCatalogRevision(): number | undefined {
    return this.endpointEntry?.revision;
  }

  snapshot(): {
    endpoints: ArkEndpointRecord[];
    fetchedAt: string | null;
    stale: boolean;
    revision: number;
    error: string | null;
  } {
    const entry = this.endpointEntry;
    if (entry === undefined) {
      return {
        endpoints: [],
        fetchedAt: null,
        stale: true,
        revision: this.revision,
        error: this.endpointError,
      };
    }
    return {
      endpoints: entry.value.map(cloneEndpoint),
      fetchedAt: new Date(entry.fetchedAtMs).toISOString(),
      stale: entry.expiresAtMs <= this.now(),
      revision: entry.revision,
      error: this.endpointError,
    };
  }

  async modelResources(options: ArkLiveRefreshOptions = {}): Promise<ModelResourceView> {
    if (options.force) this.invalidate();
    const endpointResult = (await Promise.allSettled([
      this.refreshEndpoints(),
    ]))[0]!;
    const activationResult = (await Promise.allSettled([
      this.refreshActivations(),
    ]))[0]!;
    const runningEndpointIds = (this.endpointEntry?.value ?? [])
      .filter((endpoint) => endpoint.status === "running")
      .map((endpoint) => endpoint.id);
    const usageQuery = this.defaultUsageQuery();
    const expectedUsageQuery = JSON.stringify({
      ...usageQuery,
      modelEndpoints: runningEndpointIds,
    });
    const usageResult: PromiseSettledResult<ArkInferenceUsageRecord> =
      runningEndpointIds.length === 0
        ? {
            status: "rejected",
            reason: new ModelCatalogError(
              "MODEL_PROVIDER_UNAVAILABLE",
              503,
              "No running ModelArk endpoints are available for usage telemetry",
            ),
          }
        : (await Promise.allSettled([
            this.refreshUsage({
              ...usageQuery,
              modelEndpoints: runningEndpointIds,
            }),
          ]))[0]!;
    const endpointSnapshot = this.snapshot();
    const usage = this.usageEntry;
    const usageMatchesQuery = usage !== undefined && this.usageQueryKey === expectedUsageQuery;
    const activationValue = activationResult.status === "fulfilled"
      ? activationResult.value
      : this.activationEntry?.value;
    const activationsByFoundationModel = new Map(
      (activationValue ?? []).map((activation) => [activation.foundationModelName, activation]),
    );
    // Use the value returned by this request when it succeeded. A concurrent
    // request for a different endpoint set may replace the shared cache before
    // this continuation runs; attaching the global cache here would then show
    // the wrong endpoint totals (or hide a valid response).
    const usageValue = usageResult.status === "fulfilled"
      ? usageResult.value
      : usageMatchesQuery
        ? usage.value
        : undefined;
    const usageAvailability: ModelUsageAvailability =
      usageResult.status === "fulfilled"
        ? usageResult.value.availability
        : usageValue !== undefined
          ? "partial"
          : "unavailable";
    const endpointAvailability: ModelUsageAvailability =
      endpointResult.status === "fulfilled"
        ? "available"
        : endpointSnapshot.endpoints.length > 0
          ? "partial"
          : "unavailable";
    const error = endpointResult.status === "rejected"
      ? safeErrorMessage(endpointResult.reason)
      : usageResult.status === "rejected"
        ? safeErrorMessage(usageResult.reason)
        : activationResult.status === "rejected"
          ? safeErrorMessage(activationResult.reason)
          : null;
    return {
      providerId: ARK_WORKER_PROVIDER_ID,
      availability:
        endpointAvailability === "unavailable" || usageAvailability === "unavailable"
          ? "unavailable"
          : endpointAvailability === "partial" || usageAvailability === "partial"
            ? "partial"
            : "available",
      stale:
        endpointSnapshot.stale ||
        usageResult.status === "rejected" ||
        (usageMatchesQuery && usage !== undefined && usage.expiresAtMs <= this.now()) ||
        activationResult.status === "rejected" ||
        (this.activationEntry !== undefined && this.activationEntry.expiresAtMs <= this.now()),
      fetchedAt: endpointSnapshot.fetchedAt,
      revision: endpointSnapshot.revision,
      endpoints: endpointSnapshot.endpoints.map((endpoint) =>
        endpointResource(
          endpoint,
          usageValue,
          activationsByFoundationModel,
          this.contextWindows,
        ),
      ),
      inferenceUsage:
        usageValue === undefined
          ? null
          : {
              availability: usageResult.status === "fulfilled"
                ? usageResult.value.availability
                : "partial",
              dataCount: usageValue.dataCount,
              inputTokens: usageValue.inputTokens,
              cachedInputTokens: usageValue.cachedInputTokens,
              outputTokens: usageValue.outputTokens,
              totalTokens: usageValue.totalTokens,
              requests: usageValue.requests,
              queryInterval: usageValue.queryInterval,
              startTime: usageValue.startTime,
              endTime: usageValue.endTime,
              observedAt: usageValue.observedAt,
              rows: usageValue.rows.map((row) => ({ ...row })),
            },
      error,
    };
  }

  invalidate(): void {
    this.generation += 1;
    this.endpointEntry = undefined;
    this.usageEntry = undefined;
    this.activationEntry = undefined;
    this.endpointInflight = undefined;
    this.activationInflight = undefined;
    this.usageInflight.clear();
    this.usageQueryKey = null;
    this.endpointError = null;
    this.usageError = null;
  }

  private defaultUsageQuery(): {
    queryInterval: "Day";
    startTime: string;
    endTime: string;
    showWindowDetail: false;
  } {
    const end = new Date(this.now());
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1_000);
    return {
      queryInterval: "Day",
      startTime: start.toISOString().slice(0, 10),
      endTime: end.toISOString().slice(0, 10),
      showWindowDetail: false,
    };
  }
}
