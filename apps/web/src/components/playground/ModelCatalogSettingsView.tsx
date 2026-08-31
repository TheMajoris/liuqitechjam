import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import type {
  ModelCatalogResponse,
  ModelDescriptor,
  ModelProviderDescriptor,
  ModelRef,
} from "../../types";

interface ModelCatalogSettingsViewProps {
  /** Called after an atomic catalog update so the surrounding app can refresh. */
  onCatalogChanged?: () => Promise<void> | void;
}

interface CatalogState {
  providers: ModelProviderDescriptor[];
  models: ModelDescriptor[];
  defaultModelRef: ModelRef | null;
  revision?: number;
}

function modelKey(model: Pick<ModelDescriptor, "providerId" | "id">): string {
  return `${model.providerId}:${model.id}`;
}

function modelRefKey(modelRef: ModelRef | null | undefined): string {
  return modelRef?.providerId && modelRef.modelId
    ? `${modelRef.providerId}:${modelRef.modelId}`
    : "";
}

function parseModelIds(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\r?\n/)
    .map((modelId) => modelId.trim())
    .filter((modelId) => modelId.length > 0)
    .filter((modelId) => {
      if (seen.has(modelId)) return false;
      seen.add(modelId);
      return true;
    });
}

function workerModels(models: ModelDescriptor[]): ModelDescriptor[] {
  return models.filter((model) => model.capabilities.scopes.includes("worker"));
}

function normalizeAggregate(response: ModelCatalogResponse): CatalogState | null {
  const aggregate = response.models ?? Object.values(response.modelsByProvider ?? {}).flat();
  // An explicit empty aggregate is a valid operator configuration (all models
  // may be disabled), whereas an older server simply omits aggregate fields.
  if (response.models === undefined && response.modelsByProvider === undefined) return null;
  const seen = new Set<string>();
  const models = workerModels(aggregate).filter((model) => {
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    providers: response.providers,
    models,
    defaultModelRef: response.defaultModelRef,
    ...(response.revision === undefined ? {} : { revision: response.revision }),
  };
}

async function loadReadOnlyCatalog(): Promise<CatalogState> {
  const providerResponse = await api.listModelProviders("worker");
  const workerProviders = providerResponse.providers.filter(
    (provider) => provider.capabilities.worker,
  );
  const results = await Promise.all(
    workerProviders.map(async (provider) => {
      const response = await api.listProviderModels(provider.id, "worker");
      return workerModels(response.models).filter(
        (model) => model.providerId === provider.id,
      );
    }),
  );
  const seen = new Set<string>();
  const models = results.flat().filter((model) => {
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    providers: workerProviders,
    models,
    defaultModelRef: providerResponse.defaultModelRef,
  };
}

/**
 * Operator-facing Ark catalog editor. The server remains the authority for
 * credentials and model validation; this view only edits the enabled model
 * IDs and default assignment through the atomic catalog endpoint.
 */
export function ModelCatalogSettingsView({ onCatalogChanged }: ModelCatalogSettingsViewProps) {
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [modelIdText, setModelIdText] = useState("");
  const [defaultKey, setDefaultKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      let state: CatalogState | null = null;
      try {
        state = normalizeAggregate(await api.getModelCatalog());
      } catch (reason) {
        // Older servers expose only the read-only provider routes. Keep this
        // page useful there while still surfacing failures from the update
        // operation if an operator presses Save.
        if (!(reason instanceof ApiError) || reason.status !== 404) throw reason;
      }
      const next = state ?? await loadReadOnlyCatalog();
      setCatalog(next);
      setModelIdText(next.models.map((model) => model.id).join("\n"));
      const nextDefaultKey = modelRefKey(next.defaultModelRef);
      setDefaultKey(nextDefaultKey ? next.defaultModelRef?.modelId ?? "" : "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const editedModelIds = useMemo(() => parseModelIds(modelIdText), [modelIdText]);

  const knownModels = useMemo(() => {
    const knownById = new Map(catalog?.models.map((model) => [model.id, model]) ?? []);
    return editedModelIds.map((modelId) => knownById.get(modelId));
  }, [catalog?.models, editedModelIds]);

  const defaultOptions = useMemo(
    () => editedModelIds.map((modelId) => ({
      id: modelId,
      label: catalog?.models.find((model) => model.id === modelId)?.label || modelId,
    })),
    [catalog?.models, editedModelIds],
  );

  const defaultProviderId =
    catalog?.defaultModelRef?.providerId ||
    catalog?.providers.find((provider) => provider.capabilities.worker)?.id ||
    "volcengine_ark";

  const selectedDefaultId = editedModelIds.includes(defaultKey) ? defaultKey : "";

  const updateModelIds = (value: string) => {
    setModelIdText(value);
    setNotice(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!catalog || busy) return;
    if (editedModelIds.length === 0) {
      setNotice("Enter at least one Ark deployment ID before saving the catalog.");
      return;
    }
    if (!defaultKey || !editedModelIds.includes(defaultKey)) {
      setNotice("Choose an enabled default worker model before saving the catalog.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.updateModelCatalog({
        modelIds: editedModelIds,
        defaultModelRef: {
          providerId:
            catalog.models.find((model) => model.id === defaultKey)?.providerId || defaultProviderId,
          modelId: defaultKey,
        },
        ...(catalog.revision === undefined ? {} : { revision: catalog.revision }),
      });
      const next = normalizeAggregate(response);
      if (next) {
        setCatalog(next);
        setModelIdText(next.models.map((model) => model.id).join("\n"));
        setDefaultKey(next.defaultModelRef?.modelId ?? "");
      }
      setNotice("Model catalog updated. New runs use the new assignments; active runs keep their snapshots.");
      await onCatalogChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="access-view model-catalog-view">
      <header className="access-head">
        <div className="access-head-copy">
          <span className="eyebrow">Operator settings</span>
          <h1>Ark model catalog</h1>
          <p>
            Control which server-owned Ark worker models Agents can use. Credentials stay in the
            server environment, and catalog changes apply only to future runs.
          </p>
        </div>
        <span className="access-safety-chip">Ark only · server-owned</span>
      </header>

      {error && (
        <div className="access-notice is-error" role="alert">
          <span aria-hidden="true">!</span>
          <p>{error}</p>
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>×</button>
        </div>
      )}
      {notice && (
        <div className="access-notice is-success" role="status">
          <span aria-hidden="true">✓</span>
          <p>{notice}</p>
          <button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      {loading ? (
        <div className="access-card access-loading" role="status">Loading the Ark model catalog…</div>
      ) : !catalog ? (
        <div className="access-card access-empty-state" role="status">
          <div className="access-empty-icon" aria-hidden="true">◇</div>
          <h3>No Ark worker models available</h3>
          <p>Ask the server operator to configure at least one worker-compatible Ark model.</p>
          <button type="button" className="button button-ghost" onClick={() => void loadCatalog()}>
            Reload catalog
          </button>
        </div>
      ) : (
        <form className="access-card" onSubmit={save}>
          <div className="access-panel-heading">
            <div>
              <span className="access-kicker">Runtime allowlist</span>
              <h2>Configured worker models</h2>
              <p>Agents can select any enabled model directly, with ordered fallbacks per Agent.</p>
            </div>
              <span className="access-count-label">{editedModelIds.length} configured</span>
          </div>

          <label className="access-field">
            Default worker model
            <select
              value={selectedDefaultId}
              required
              disabled={busy || editedModelIds.length === 0}
              onChange={(event) => {
                setDefaultKey(event.target.value);
                setNotice(null);
              }}
            >
              <option value="">Select a configured default</option>
              {defaultOptions.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          <label className="access-field">
            Ark deployment IDs
            <textarea
              rows={Math.min(Math.max(editedModelIds.length + 1, 4), 12)}
              value={modelIdText}
              disabled={busy}
              spellCheck={false}
              aria-describedby="model-catalog-model-ids-help"
              onChange={(event) => updateModelIds(event.target.value)}
              placeholder="ep-your-ark-deployment-id\nAnother deployment ID"
            />
            <span className="access-muted" id="model-catalog-model-ids-help">
              One Ark deployment ID per line. Existing catalog entries are shown here; add new IDs
              directly when the operator creates another deployment. Duplicate and blank lines are
              removed when saving.
            </span>
          </label>

          {knownModels.some((model) => model === undefined) && (
            <p className="access-muted">
              New IDs are pending server validation and may not have a friendly label until the
              catalog is reloaded.
            </p>
          )}

          <div className="access-actions">
            <span className="access-action-note">Updates are validated and applied atomically by the server.</span>
            <button type="button" className="button button-ghost" disabled={busy} onClick={() => void loadCatalog()}>
              Reload
            </button>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? "Saving…" : "Save catalog"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
