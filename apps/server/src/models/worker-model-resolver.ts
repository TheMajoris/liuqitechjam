import type { AppConfig } from "../config.js";
import { ARK_WORKER_PROVIDER_ID } from "./ark-provider.js";
import { ModelCatalogError, type ModelErrorCode } from "./errors.js";
import type {
  ModelDescriptor,
  ModelRef,
  ProviderDescriptor,
  ReasoningEffort,
  WorkerModelResolver as WorkerModelResolverContract,
  WorkerRuntimeModelConfig,
} from "./types.js";

/** The only provider currently proven to be executable by the Codex worker. */
export const DEFAULT_WORKER_PROVIDER_ID = ARK_WORKER_PROVIDER_ID;

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type WorkerModelErrorCode = ModelErrorCode;

/** Stable, HTTP-safe model configuration failure. */
export class WorkerModelResolutionError extends ModelCatalogError {
  constructor(
    code: WorkerModelErrorCode,
    message: string,
    statusCode = 422,
  ) {
    super(code, statusCode, message);
    this.name = "WorkerModelResolutionError";
  }
}

/** Read-only catalog seam used by the runtime resolver. */
export interface WorkerModelCatalog {
  getProvider(providerId: string): ProviderDescriptor | undefined;
  getModel(providerId: string, modelId: string): ModelDescriptor | undefined;
}

export interface WorkerModelResolverOptions {
  /** Default used for legacy Agents and newly created Agents. */
  defaultModelRef?: ModelRef;
  /** Catalog containing only provider/model metadata, never credentials. */
  catalog?: WorkerModelCatalog;
}

export type WorkerModelResolution =
  | { ok: true; model: WorkerRuntimeModelConfig }
  | { ok: false; code: WorkerModelErrorCode; message: string };

const defaultProviderDescriptor = (): ProviderDescriptor => ({
  id: DEFAULT_WORKER_PROVIDER_ID,
  label: "BytePlus ModelArk",
  capabilities: {
    worker: true,
    supervisor: true,
    dynamicModelListing: true,
  },
});

function descriptorForModel(modelId: string): ModelDescriptor {
  return {
    id: modelId,
    label: modelId,
    providerId: DEFAULT_WORKER_PROVIDER_ID,
    capabilities: { scopes: ["worker"], reasoning: false },
  };
}

function createDefaultCatalog(defaultModelRef: ModelRef | undefined): WorkerModelCatalog {
  const provider = defaultProviderDescriptor();
  const defaultModel = defaultModelRef
    ? descriptorForModel(defaultModelRef.modelId)
    : undefined;
  return {
    getProvider(providerId) {
      return providerId === provider.id ? provider : undefined;
    },
    getModel(providerId, modelId) {
      return providerId === provider.id && defaultModel?.id === modelId
        ? defaultModel
        : undefined;
    },
  };
}

function createAllowlistedCatalog(
  defaultModelRef: ModelRef | undefined,
  allowedModelIds: readonly string[] = [],
): WorkerModelCatalog {
  const provider = defaultProviderDescriptor();
  const allowed = new Set(
    allowedModelIds.map((value) => value.trim()).filter(Boolean),
  );
  if (defaultModelRef?.modelId) allowed.add(defaultModelRef.modelId.trim());
  return {
    getProvider(providerId) {
      return providerId === provider.id ? provider : undefined;
    },
    getModel(providerId, modelId) {
      return providerId === provider.id && allowed.has(modelId)
        ? descriptorForModel(modelId)
        : undefined;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidModelRef(message: string): WorkerModelResolutionError {
  return new WorkerModelResolutionError(
    "MODEL_RUNTIME_CONFIGURATION_INVALID",
    message,
  );
}

/** Normalize and validate user/persisted model references without SDK types. */
export function normalizeModelRef(input: ModelRef): ModelRef {
  if (!isRecord(input)) throw invalidModelRef("Worker model configuration is invalid.");

  for (const key of Object.keys(input)) {
    if (key !== "providerId" && key !== "modelId" && key !== "reasoning") {
      throw invalidModelRef("Worker model configuration is invalid.");
    }
  }

  const providerId = input.providerId;
  const modelId = input.modelId;
  if (
    typeof providerId !== "string" ||
    providerId.trim().length === 0 ||
    providerId.trim().length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(providerId)
  ) {
    throw invalidModelRef("Worker model provider is required.");
  }
  if (
    typeof modelId !== "string" ||
    modelId.trim().length === 0 ||
    modelId.trim().length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(modelId)
  ) {
    throw invalidModelRef("Worker model is required.");
  }

  const reasoningValue = input.reasoning;
  if (reasoningValue !== undefined) {
    if (!isRecord(reasoningValue)) {
      throw invalidModelRef("Worker model reasoning configuration is invalid.");
    }
    for (const key of Object.keys(reasoningValue)) {
      if (key !== "effort") {
        throw invalidModelRef("Worker model reasoning configuration is invalid.");
      }
    }
  }
  const effort = reasoningValue?.effort;
  if (
    effort !== undefined &&
    (typeof effort !== "string" || !REASONING_EFFORTS.has(effort as ReasoningEffort))
  ) {
    throw new WorkerModelResolutionError(
      "MODEL_REASONING_EFFORT_INVALID",
      "The selected reasoning effort is invalid.",
    );
  }

  return {
    providerId: providerId.trim(),
    modelId: modelId.trim(),
    ...(effort === undefined
      ? {}
      : { reasoning: { effort: effort as ReasoningEffort } }),
  };
}

function cloneModelRef(modelRef: ModelRef): ModelRef {
  return {
    providerId: modelRef.providerId,
    modelId: modelRef.modelId,
    ...(modelRef.reasoning?.effort === undefined
      ? {}
      : { reasoning: { effort: modelRef.reasoning.effort } }),
  };
}

export function modelRefsEqual(
  left: ModelRef | undefined,
  right: ModelRef | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  try {
    const normalizedLeft = normalizeModelRef(left);
    const normalizedRight = normalizeModelRef(right);
    return (
      normalizedLeft.providerId === normalizedRight.providerId &&
      normalizedLeft.modelId === normalizedRight.modelId &&
      normalizedLeft.reasoning?.effort === normalizedRight.reasoning?.effort
    );
  } catch {
    return false;
  }
}

/** Resolve Agent settings into the narrow Codex worker runtime contract. */
export class WorkerModelResolver implements WorkerModelResolverContract {
  private readonly defaultModel: ModelRef | undefined;
  private readonly catalog: WorkerModelCatalog;

  constructor(options: WorkerModelResolverOptions = {}) {
    this.defaultModel = options.defaultModelRef
      ? normalizeModelRef(options.defaultModelRef)
      : undefined;
    this.catalog = options.catalog ?? createDefaultCatalog(this.defaultModel);
  }

  defaultModelRef(): ModelRef | undefined {
    return this.defaultModel ? cloneModelRef(this.defaultModel) : undefined;
  }

  effectiveModelRef(modelRef: ModelRef | undefined): ModelRef | undefined {
    if (modelRef === undefined) return this.defaultModelRef();
    return normalizeModelRef(modelRef);
  }

  resolve(modelRef: ModelRef | undefined): WorkerRuntimeModelConfig {
    const effective = this.effectiveModelRef(modelRef);
    if (effective === undefined) {
      throw new WorkerModelResolutionError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        "The worker runtime has no configured model.",
        503,
      );
    }

    // The current Ark/Codex invocation has no verified reasoning flag
    // mapping. Validate the normalized value, then reject it explicitly so a
    // requested effort can never be silently ignored by the worker runtime.
    const normalized = normalizeModelRef(effective);
    if (normalized.reasoning?.effort !== undefined) {
      throw new WorkerModelResolutionError(
        "MODEL_REASONING_NOT_SUPPORTED",
        "The selected model does not support reasoning controls.",
      );
    }

    let provider: ProviderDescriptor | undefined;
    let descriptor: ModelDescriptor | undefined;
    try {
      provider = this.catalog.getProvider(normalized.providerId);
      descriptor = this.catalog.getModel(
        normalized.providerId,
        normalized.modelId,
      );
    } catch {
      throw new WorkerModelResolutionError(
        "MODEL_PROVIDER_UNAVAILABLE",
        "The selected worker model provider is unavailable.",
        503,
      );
    }
    if (provider === undefined) {
      throw new WorkerModelResolutionError(
        "MODEL_PROVIDER_NOT_FOUND",
        "The selected worker model provider is not available.",
      );
    }
    if (!provider.capabilities.worker) {
      throw new WorkerModelResolutionError(
        "MODEL_NOT_SUPPORTED_FOR_WORKER",
        "The selected provider cannot run worker Agents.",
      );
    }

    if (descriptor === undefined) {
      throw new WorkerModelResolutionError(
        "MODEL_NOT_FOUND",
        "The selected worker model is not available.",
      );
    }
    if (
      descriptor.id !== normalized.modelId ||
      descriptor.providerId !== normalized.providerId ||
      !descriptor.capabilities.scopes.includes("worker")
    ) {
      throw new WorkerModelResolutionError(
        "MODEL_NOT_SUPPORTED_FOR_WORKER",
        "The selected model cannot run worker Agents.",
      );
    }

    return {
      providerId: normalized.providerId,
      modelId: normalized.modelId,
      codexModel: normalized.modelId,
      usesDefaultModel: modelRef === undefined,
    };
  }

  resolveSafe(modelRef: ModelRef | undefined): WorkerModelResolution {
    try {
      return { ok: true, model: this.resolve(modelRef) };
    } catch (error) {
      if (error instanceof WorkerModelResolutionError) {
        return { ok: false, code: error.code, message: error.message };
      }
      return {
        ok: false,
        code: "MODEL_RUNTIME_CONFIGURATION_INVALID",
        message: "The worker runtime model configuration is invalid.",
      };
    }
  }

  isResolvable(modelRef: ModelRef | undefined): boolean {
    return this.resolveSafe(modelRef).ok;
  }

  isWorkerModelResolvable(modelRef: ModelRef | undefined): boolean {
    return this.isResolvable(modelRef);
  }
}

export interface ArkWorkerModelResolverOptions {
  defaultModelId?: string;
  allowedModelIds?: readonly string[];
}

/** Worker resolver configured for the current Ark/ModelArk runtime. */
export class ArkWorkerModelResolver extends WorkerModelResolver {
  constructor(options: ArkWorkerModelResolverOptions = {}) {
    const defaultModelId = options.defaultModelId?.trim() ?? "";
    const defaultModelRef = defaultModelId
      ? { providerId: DEFAULT_WORKER_PROVIDER_ID, modelId: defaultModelId }
      : undefined;
    super({
      ...(defaultModelRef === undefined ? {} : { defaultModelRef }),
      catalog: createAllowlistedCatalog(defaultModelRef, options.allowedModelIds),
    });
  }
}

export function createDefaultWorkerModelResolver(
  defaultModelRef?: ModelRef,
): WorkerModelResolver {
  return new WorkerModelResolver({
    ...(defaultModelRef === undefined ? {} : { defaultModelRef }),
  });
}

export function createWorkerModelResolver(
  config: Pick<AppConfig, "arkModel" | "workerCuratedModels">,
): ArkWorkerModelResolver {
  return new ArkWorkerModelResolver({
    defaultModelId: config.arkModel,
    allowedModelIds: config.workerCuratedModels,
  });
}
