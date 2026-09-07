import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type {
  ModelDescriptor,
  ModelResourceSnapshot,
  SupervisorModelReassignment,
  SupervisorModelResponse,
} from "../../types";
import type { ModelResourcesController } from "../../playground/use-model-resources";
import { modelOptionLabel, modelResourceUsageSummary } from "../../model-resource-format";

const ARK_PROVIDER_ID = "volcengine_ark";

interface SupervisorModelPanelProps {
  modelResources: ModelResourcesController;
  /** Agents may be reassigned by a change, so the caller reloads them. */
  onAgentsChanged?: () => void | Promise<void>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof ApiError ? reason.message : String(reason);
}

function sourceLabel(current: SupervisorModelResponse): string {
  if (current.source === "override") {
    return current.environmentModelId === null
      ? "Set here. SUPERVISOR_MODEL is not configured."
      : `Set here, overriding SUPERVISOR_MODEL (${current.environmentModelId}).`;
  }
  if (current.source === "environment") {
    return "Inherited from SUPERVISOR_MODEL in the environment.";
  }
  return "No supervisor endpoint is configured; supervisor routing cannot start.";
}

function reassignmentLabel(entry: SupervisorModelReassignment): string {
  if (entry.skippedReason !== undefined) {
    return `${entry.agentName} could not be moved — ${entry.skippedReason}`;
  }
  const parts = [
    entry.movedPrimaryTo === undefined ? null : `moved to ${entry.movedPrimaryTo}`,
    entry.droppedFallbacks > 0
      ? `${entry.droppedFallbacks} fallback${entry.droppedFallbacks === 1 ? "" : "s"} removed`
      : null,
  ].filter((part): part is string => part !== null);
  return `${entry.agentName} — ${parts.join(", ")}`;
}

/**
 * Server-wide supervisor endpoint control.
 *
 * The list is every running ModelArk endpoint, including the one currently
 * reserved, so re-selecting the active endpoint is always possible. Choosing
 * an endpoint here withholds it from Agent (worker) selection, which is why
 * the response's reassignments are surfaced rather than applied silently.
 */
export function SupervisorModelPanel({
  modelResources,
  onAgentsChanged,
}: SupervisorModelPanelProps) {
  const [current, setCurrent] = useState<SupervisorModelResponse | null>(null);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [supervisor, listing] = await Promise.all([
        api.supervisorModel(),
        api.listProviderModels(ARK_PROVIDER_ID, "supervisor"),
      ]);
      setCurrent(supervisor);
      setModels(listing.models);
      setSelected(supervisor.modelRef?.modelId ?? "");
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resourceFor = (modelId: string): ModelResourceSnapshot | null =>
    modelResources.byKey.get(`${ARK_PROVIDER_ID}:${modelId}`) ?? null;

  const dirty = current !== null && selected !== (current.modelRef?.modelId ?? "");

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await api.setSupervisorModel(
        selected === "" ? null : { providerId: ARK_PROVIDER_ID, modelId: selected },
      );
      setCurrent(result);
      setSelected(result.modelRef?.modelId ?? "");
      setError(null);
      setNotice(
        result.reassignments.length === 0
          ? ["No Agent was assigned to this endpoint."]
          : result.reassignments.map(reassignmentLabel),
      );
      // The reserved endpoint left the worker catalog, so both the Agent list
      // and the resource snapshot are now out of date.
      await Promise.all([
        onAgentsChanged?.(),
        modelResources.refresh(),
      ]);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const activeResource = current?.modelRef
    ? resourceFor(current.modelRef.modelId)
    : null;

  return (
    <section
      className="usage-section model-resource-section"
      aria-labelledby="supervisor-model-heading"
      aria-busy={loading || saving}
    >
      <div className="usage-section-head model-resource-head">
        <div>
          <span className="eyebrow">Routing</span>
          <h3 id="supervisor-model-heading">Supervisor model</h3>
          <p>
            The endpoint that decides who speaks next. It is reserved for
            routing, so it is not offered as an Agent worker model.
          </p>
        </div>
      </div>

      {loading && (
        <p className="model-resource-state" role="status" aria-live="polite">
          Loading running endpoints…
        </p>
      )}
      {error && (
        <p className="model-resource-state is-warning" role="alert">
          {error}
        </p>
      )}

      {!loading && current && (
        <>
          <div className="supervisor-model-row">
            <label className="supervisor-model-field">
              Endpoint
              <select
                id="supervisor-model-endpoint"
                value={selected}
                disabled={saving || models.length === 0}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">
                  {current.environmentModelId === null
                    ? "No supervisor endpoint"
                    : `Use SUPERVISOR_MODEL (${current.environmentModelId})`}
                </option>
                {selected !== "" &&
                  !models.some((model) => model.id === selected) && (
                    <option value={selected} disabled>
                      {selected} (not running)
                    </option>
                  )}
                {models.map((model) => (
                  <option value={model.id} key={model.id}>
                    {modelOptionLabel(model, resourceFor(model.id))}
                  </option>
                ))}
              </select>
              <span className="worker-model-help">{sourceLabel(current)}</span>
            </label>
            <button
              type="button"
              className="button button-primary supervisor-model-save"
              onClick={() => void save()}
              disabled={!dirty || saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>

          {activeResource && (
            <p className="model-resource-state" role="status">
              Current endpoint consumption: {modelResourceUsageSummary(activeResource)}.
            </p>
          )}
          {models.length === 0 && (
            <p className="model-resource-state is-warning" role="status">
              No running ModelArk endpoint was reported, so the supervisor
              cannot be changed right now.
            </p>
          )}
          {notice && (
            <ul className="model-resource-state" role="status">
              {notice.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
