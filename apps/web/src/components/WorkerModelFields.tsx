import type {
  Agent,
  ModelDescriptor,
  ModelProviderDescriptor,
  ModelRef,
  ReasoningEffort,
} from "../types";

export interface WorkerModelFieldsProps {
  providers: ModelProviderDescriptor[];
  models: ModelDescriptor[];
  value?: ModelRef | null;
  loadingProviders?: boolean;
  loadingModels?: boolean;
  catalogError?: string | null;
  disabled?: boolean;
  /** New Agents must use an explicit resolved default when one is available. */
  isNew?: boolean;
  onProviderChange: (providerId: string) => void;
  onModelChange: (modelId: string) => void;
  onReasoningChange: (effort: ReasoningEffort | undefined) => void;
  onRetry?: () => void;
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
    return "Default runtime configuration";
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
  value,
  loadingProviders = false,
  loadingModels = false,
  catalogError = null,
  disabled = false,
  isNew = false,
  onProviderChange,
  onModelChange,
  onReasoningChange,
  onRetry,
}: WorkerModelFieldsProps) {
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
    <section className="worker-model-fields" aria-labelledby="worker-model-heading">
      <div className="worker-model-heading">
        <div>
          <span className="eyebrow">Worker model</span>
          <h3 id="worker-model-heading">Choose how this Agent runs</h3>
        </div>
        <span className="worker-model-lock" aria-hidden="true">Backend resolved</span>
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
            Ask the server operator to configure a worker-compatible Codex model. Existing Agents
            can continue on the default runtime configuration.
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
            {!isNew && !value?.providerId && (
              <option value="">Default runtime configuration</option>
            )}
            {isNew && <option value="">Select a resolved provider</option>}
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
                {model.label || model.id}
              </option>
            ))}
          </select>
          {selectedProviderId && loadingModels && (
            <span className="worker-model-inline-status" role="status">
              <span className="spinner" aria-hidden="true" /> Checking models available to Codex…
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

      {!isNew && !value?.providerId && (
        <p className="worker-model-legacy" role="note">
          This legacy Agent has no explicit assignment and will use the server’s default runtime
          configuration until you choose a resolved provider and model.
        </p>
      )}
    </section>
  );
}
