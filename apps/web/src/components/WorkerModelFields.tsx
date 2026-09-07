import type {
  Agent,
  ModelDescriptor,
  ModelProviderDescriptor,
  ModelRef,
  ModelResourceSnapshot,
  ReasoningEffort,
} from "../types";
import { modelOptionLabel } from "../model-resource-format";

export interface WorkerModelFieldsProps {
  providers: ModelProviderDescriptor[];
  models: ModelDescriptor[];
  /** Lazily loaded worker models keyed by provider, used by fallback rows. */
  modelsByProvider?: Record<string, ModelDescriptor[]>;
  loadingByProvider?: Record<string, boolean>;
  /**
   * Live endpoint telemetry keyed `providerId:modelId`. Optional so a form
   * without a resource poll still renders plain model names.
   */
  modelResources?: Map<string, ModelResourceSnapshot>;
  value?: ModelRef | null;
  fallbackValues?: ModelRef[];
  loadingProviders?: boolean;
  catalogRefreshing?: boolean;
  loadingModels?: boolean;
  providerErrors?: Record<string, string | null>;
  providerStale?: Record<string, boolean>;
  catalogError?: string | null;
  disabled?: boolean;
  /** New Agents must use an explicit resolved default when one is available. */
  isNew?: boolean;
  onProviderChange: (providerId: string) => void;
  onModelChange: (modelId: string) => void;
  onReasoningChange: (effort: ReasoningEffort | undefined) => void;
  onAddFallback?: () => void;
  onRemoveFallback?: (index: number) => void;
  onFallbackProviderChange?: (index: number, providerId: string) => void;
  onFallbackModelChange?: (index: number, modelId: string) => void;
  onRefresh?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

export function providerSupportsWorkers(provider: ModelProviderDescriptor): boolean {
  return provider.capabilities.worker;
}

export function workerProviders(
  providers: ModelProviderDescriptor[],
): ModelProviderDescriptor[] {
  return providers.filter(providerSupportsWorkers);
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatProviderLabel(
  providerId: string,
  providers: ModelProviderDescriptor[] = [],
): string {
  return (
    providers.find((provider) => provider.id === providerId)?.label ||
    humanizeIdentifier(providerId)
  );
}

export function formatReasoningEffort(effort: ReasoningEffort | undefined): string {
  if (!effort) return "Not configured";
  return effort.slice(0, 1).toUpperCase() + effort.slice(1);
}

export function formatWorkerModelRef(
  modelRef: ModelRef | null | undefined,
  providers: ModelProviderDescriptor[] = [],
  models: ModelDescriptor[] = [],
): string {
  if (!modelRef?.providerId || !modelRef.modelId) {
    return "Model assignment required";
  }
  const model = models.find(
    (candidate) =>
      candidate.id === modelRef.modelId &&
      candidate.providerId === modelRef.providerId,
  );
  return `${formatProviderLabel(modelRef.providerId, providers)} / ${
    model?.label || modelRef.modelId
  }`;
}

export function formatAgentWorkerModel(
  agent: Pick<Agent, "modelRef">,
  providers: ModelProviderDescriptor[] = [],
  models: ModelDescriptor[] = [],
): string {
  return formatWorkerModelRef(agent.modelRef, providers, models);
}

function modelCapabilities(model: ModelDescriptor | undefined) {
  return model?.capabilities;
}

export function WorkerModelFields({
  providers,
  models,
  modelsByProvider = {},
  loadingByProvider = {},
  modelResources,
  value,
  fallbackValues = [],
  loadingProviders = false,
  catalogRefreshing = false,
  loadingModels = false,
  providerErrors = {},
  providerStale = {},
  catalogError = null,
  disabled = false,
  isNew = false,
  onProviderChange,
  onModelChange,
  onReasoningChange,
  onAddFallback,
  onRemoveFallback,
  onFallbackProviderChange,
  onFallbackModelChange,
  onRefresh,
  onRetry,
}: WorkerModelFieldsProps) {
  const optionLabel = (model: ModelDescriptor): string =>
    modelOptionLabel(
      model,
      modelResources?.get(`${model.providerId}:${model.id}`) ?? null,
    );
  const supportedProviders = workerProviders(providers);
  const selectedProviderId = value?.providerId ?? "";
  const selectedModel = models.find(
    (model) =>
      model.id === value?.modelId &&
      model.providerId === selectedProviderId,
  );
  const efforts = modelCapabilities(selectedModel)?.reasoningEfforts ?? [];
  const reasoningSupported =
    modelCapabilities(selectedModel)?.reasoning === true && efforts.length > 0;
  const selectedEffort = value?.reasoning?.effort;
  const selectedEffortIsValid =
    selectedEffort === undefined || efforts.includes(selectedEffort);

  return (
    <section
      className="worker-model-fields"
      aria-labelledby="worker-model-heading"
      aria-busy={loadingProviders || catalogRefreshing}
    >
      <div className="worker-model-heading">
        <div>
          <span className="eyebrow">Worker model</span>
          <h3 id="worker-model-heading">Choose how this Agent runs</h3>
        </div>
        <div className="worker-model-heading-actions">
          <span className="worker-model-lock">Server-owned catalog</span>
          {onRefresh && (
            <button
              type="button"
              className="button button-ghost worker-model-refresh"
              onClick={() => void onRefresh()}
              disabled={disabled || loadingProviders || catalogRefreshing}
              aria-label="Refresh worker model catalog"
            >
              {catalogRefreshing ? "Checking…" : "Refresh"}
            </button>
          )}
        </div>
      </div>
      <p className="worker-model-help">
        The selected configuration is used whenever this Agent is invoked on its own or
        Team. Provider credentials stay on the server.
      </p>

      {loadingProviders && (
        <div className="worker-model-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> Loading worker providers…
        </div>
      )}

      {!loadingProviders && catalogRefreshing && (
        <div className="worker-model-inline-status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> Checking for running endpoints…
        </div>
      )}

      {catalogError && (
        <div className="worker-model-error" role="alert">
          <span>{catalogError}</span>
          {onRetry && (
            <button type="button" className="button button-ghost" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {!loadingProviders && supportedProviders.length === 0 && !catalogError && (
        <div className="worker-model-empty" role="status">
          <strong>No worker models are available</strong>
          <span>
            Ask the server operator to expose a running worker endpoint. Agents must carry an
            explicit persisted model assignment before they can be saved or edited.
          </span>
        </div>
      )}

      <div className="worker-model-grid">
        <label>
          Provider
          <select
            id="worker-model-provider"
            value={selectedProviderId}
            required={isNew && supportedProviders.length > 0}
            disabled={disabled || loadingProviders || supportedProviders.length === 0}
            onChange={(event) => onProviderChange(event.target.value)}
          >
            {!value?.providerId && <option value="">Select a running provider</option>}
            {value?.providerId &&
              !supportedProviders.some((provider) => provider.id === value.providerId) && (
                <option value={value.providerId} disabled>
                  {formatProviderLabel(value.providerId, providers)} (unavailable)
                </option>
              )}
            {supportedProviders.map((provider) => (
              <option value={provider.id} key={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Model
          <select
            id="worker-model-model"
            value={value?.modelId ?? ""}
            required={isNew && supportedProviders.length > 0}
            disabled={
              disabled ||
              !selectedProviderId ||
              loadingModels ||
              models.length === 0
            }
            onChange={(event) => onModelChange(event.target.value)}
          >
            <option value="">
              {loadingModels ? "Loading resolved models…" : "Select a resolved model"}
            </option>
            {value?.modelId && !selectedModel && (
              <option value={value.modelId} disabled>
                {value.modelId} (unavailable)
              </option>
            )}
            {models.map((model) => (
              <option value={model.id} key={`${model.providerId}:${model.id}`}>
                {optionLabel(model)}
              </option>
            ))}
          </select>
          {selectedProviderId && loadingModels && (
            <span className="worker-model-inline-status" role="status">
              <span className="spinner" aria-hidden="true" /> Checking models available to Codex…
            </span>
          )}
          {selectedProviderId && providerErrors[selectedProviderId] && !loadingModels && (
            <span className="worker-model-field-warning" role="status">
              Could not refresh this provider: {providerErrors[selectedProviderId]}
              {onRetry && (
                <button type="button" className="button button-ghost" onClick={() => void onRetry()}>
                  Retry
                </button>
              )}
            </span>
          )}
          {selectedProviderId && providerStale[selectedProviderId] && !loadingModels && !providerErrors[selectedProviderId] && (
            <span className="worker-model-field-warning" role="status">
              Showing the last successful endpoint list.
            </span>
          )}
          {selectedProviderId && !loadingModels && models.length === 0 && !catalogError && (
            <span className="worker-model-inline-status" role="status">
              No resolved worker models are available for this provider.
            </span>
          )}
          {selectedProviderId && value?.modelId && !selectedModel && !loadingModels && !catalogError && (
            <span className="worker-model-field-error" role="alert">
              The assigned model is no longer available to this worker.
            </span>
          )}
        </label>

        {reasoningSupported && (
          <label>
            Reasoning
            <select
              id="worker-model-reasoning"
              value={selectedEffort ?? ""}
              required
              disabled={disabled || loadingModels}
              aria-invalid={!selectedEffortIsValid}
              onChange={(event) =>
                onReasoningChange(
                  (event.target.value || undefined) as ReasoningEffort | undefined,
                )
              }
            >
              {!selectedEffort && <option value="">Select reasoning effort</option>}
              {efforts.map((effort) => (
                <option value={effort} key={effort}>
                  {formatReasoningEffort(effort)}
                </option>
              ))}
            </select>
            {!selectedEffortIsValid && (
              <span className="worker-model-field-error" role="alert">
                Select one of the efforts supported by this model.
              </span>
            )}
          </label>
        )}
      </div>

      {selectedEffort !== undefined && !reasoningSupported && (
        <p className="worker-model-field-error" role="alert">
          This Agent has a reasoning setting that the selected model cannot resolve. Choose a
          supported model and effort before saving.
        </p>
      )}

      {!value?.providerId && (
        <p className="worker-model-legacy" role="alert">
          This Agent has no persisted model assignment. Choose a running provider and model before
          saving; runtime defaults are not accepted for Create or Edit.
        </p>
      )}

      {(onAddFallback || fallbackValues.length > 0) && (
        <section className="worker-model-fallbacks" aria-labelledby="worker-model-fallback-heading">
          <div className="worker-model-heading">
            <div>
              <span className="eyebrow">Reliability</span>
              <h3 id="worker-model-fallback-heading">Fallback models</h3>
            </div>
            {onAddFallback && (
              <button
                type="button"
                className="button button-ghost"
                onClick={onAddFallback}
                disabled={disabled || supportedProviders.length === 0}
              >
                + Add fallback
              </button>
            )}
          </div>
          <p className="worker-model-help">
            Optional models tried in order if the primary model is unavailable. Fallbacks belong to
            this Agent and never change its capabilities.
          </p>
          {fallbackValues.length === 0 ? (
            <p className="worker-model-inline-status" role="status">
              No fallback models configured.
            </p>
          ) : (
            <div className="worker-model-fallback-list">
              {fallbackValues.map((fallback, index) => {
                const fallbackModels = fallback.providerId
                  ? modelsByProvider[fallback.providerId] ?? []
                  : [];
                const fallbackLoading = fallback.providerId
                  ? loadingByProvider[fallback.providerId] === true
                  : false;
                const fallbackError = fallback.providerId
                  ? providerErrors[fallback.providerId]
                  : null;
                const fallbackStale = fallback.providerId
                  ? providerStale[fallback.providerId] === true
                  : false;
                const fallbackModel = fallbackModels.find(
                  (model) =>
                    model.id === fallback.modelId && model.providerId === fallback.providerId,
                );
                return (
                  <div className="worker-model-grid" key={`${index}:${fallback.providerId}`}>
                    <label>
                      <span>Fallback {index + 1} provider</span>
                      <select
                        aria-label={`Fallback ${index + 1} provider`}
                        value={fallback.providerId}
                        required
                        disabled={disabled || loadingProviders || supportedProviders.length === 0}
                        onChange={(event) => onFallbackProviderChange?.(index, event.target.value)}
                      >
                        <option value="">Select a resolved provider</option>
                        {fallback.providerId &&
                          !supportedProviders.some((provider) => provider.id === fallback.providerId) && (
                            <option value={fallback.providerId} disabled>
                              {formatProviderLabel(fallback.providerId, providers)} (unavailable)
                            </option>
                          )}
                        {supportedProviders.map((provider) => (
                          <option value={provider.id} key={provider.id}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Fallback {index + 1} model</span>
                      <select
                        aria-label={`Fallback ${index + 1} model`}
                        value={fallback.modelId}
                        required
                        disabled={
                          disabled ||
                          !fallback.providerId ||
                          fallbackLoading ||
                          fallbackModels.length === 0
                        }
                        onChange={(event) => onFallbackModelChange?.(index, event.target.value)}
                      >
                        <option value={fallbackLoading ? "" : fallback.modelId && !fallbackModel ? fallback.modelId : ""}>
                          {fallbackLoading ? "Loading resolved models…" : "Select a resolved model"}
                        </option>
                        {fallback.modelId && !fallbackModel && !fallbackLoading && (
                          <option value={fallback.modelId} disabled>
                            {fallback.modelId} (unavailable)
                          </option>
                        )}
                        {fallbackModels.map((model) => (
                          <option value={model.id} key={`${model.providerId}:${model.id}`}>
                            {optionLabel(model)}
                          </option>
                        ))}
                      </select>
                      {fallback.providerId && fallbackLoading && (
                        <span className="worker-model-inline-status" role="status">
                          <span className="spinner" aria-hidden="true" /> Checking models available to Codex…
                        </span>
                      )}
                      {fallback.providerId && fallbackError && !fallbackLoading && (
                        <span className="worker-model-field-warning" role="status">
                          Could not refresh this provider: {fallbackError}
                          {onRetry && (
                            <button type="button" className="button button-ghost" onClick={() => void onRetry()}>
                              Retry
                            </button>
                          )}
                        </span>
                      )}
                      {fallback.providerId && fallbackStale && !fallbackLoading && !fallbackError && (
                        <span className="worker-model-field-warning" role="status">
                          Showing the last successful endpoint list.
                        </span>
                      )}
                      {fallback.providerId && !fallbackLoading && fallbackModels.length === 0 && !catalogError && (
                        <span className="worker-model-inline-status" role="status">
                          No resolved worker models are available for this provider.
                        </span>
                      )}
                      {fallback.providerId && fallback.modelId && !fallbackModel && !fallbackLoading && !catalogError && (
                        <span className="worker-model-field-error" role="alert">
                          This fallback model is no longer available.
                        </span>
                      )}
                    </label>
                    {onRemoveFallback && (
                      <button
                        type="button"
                        className="button button-danger"
                        onClick={() => onRemoveFallback(index)}
                        disabled={disabled}
                        aria-label={`Remove fallback ${index + 1}`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
