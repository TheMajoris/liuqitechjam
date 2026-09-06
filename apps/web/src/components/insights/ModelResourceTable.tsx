import type { Agent, ModelResourceSnapshot } from "../../types";
import type { ModelResourcesController } from "../../playground/use-model-resources";
import {
  modelResourceObservedLabel,
  modelResourceQuotaLabel,
  modelResourceStatusGlyph,
  modelResourceStatusLabel,
  modelResourceStatusTone,
  modelResourceRateLimitLabel,
  modelResourceUsageScopeLabel,
  modelResourceUsageSummary,
} from "../../model-resource-format";

interface ModelResourceTableProps {
  agents: Agent[];
  modelResources: ModelResourcesController;
}

interface ResourceRow {
  key: string;
  providerId: string;
  modelId: string;
  resource: ModelResourceSnapshot | null;
  agents: string[];
}

function resourceKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function usageValue(resource: ModelResourceSnapshot | null): string {
  if (!resource) return "Usage not reported";
  return `${modelResourceUsageSummary(resource)} · ${modelResourceUsageScopeLabel(resource)}`;
}

function quotaValue(resource: ModelResourceSnapshot | null): string {
  return modelResourceQuotaLabel(resource).replace("Remaining quota not reported by ModelArk", "Not reported");
}

function statusValue(resource: ModelResourceSnapshot | null): {
  label: string;
  glyph: string;
  tone: ReturnType<typeof modelResourceStatusTone>;
  freshness: string;
} {
  if (!resource) {
    return { label: "Unknown", glyph: "?", tone: "neutral", freshness: "No observation" };
  }
  return {
    label: modelResourceStatusLabel(resource.endpointStatus),
    glyph: modelResourceStatusGlyph(resource.endpointStatus),
    // A stale observation is not evidence of a healthy or degraded endpoint;
    // keep it neutral while retaining the explicit freshness label.
    tone: resource.freshness === "stale"
      ? "muted"
      : modelResourceStatusTone(resource.endpointStatus),
    freshness: modelResourceObservedLabel(resource),
  };
}

function buildRows(
  agents: Agent[],
  resources: ModelResourceSnapshot[],
  byKey: Map<string, ModelResourceSnapshot>,
): ResourceRow[] {
  const rows = new Map<string, ResourceRow>();
  for (const agent of agents) {
    const modelRef = agent.modelRef;
    if (!modelRef?.providerId || !modelRef.modelId) continue;
    const key = resourceKey(modelRef.providerId, modelRef.modelId);
    const current = rows.get(key) ?? {
      key,
      providerId: modelRef.providerId,
      modelId: modelRef.modelId,
      resource: byKey.get(key) ?? null,
      agents: [],
    };
    current.agents.push(agent.name);
    rows.set(key, current);
  }
  // Keep a visible fleet row for an observed endpoint that is not currently
  // assigned. It can still be useful to an operator when validating a catalog.
  for (const resource of resources) {
    const key = resourceKey(resource.providerId, resource.modelId);
    if (rows.has(key)) continue;
    rows.set(key, {
      key,
      providerId: resource.providerId,
      modelId: resource.modelId,
      resource,
      agents: [],
    });
  }
  return Array.from(rows.values()).sort((left, right) => left.key.localeCompare(right.key));
}

export function ModelResourceTable({ agents, modelResources }: ModelResourceTableProps) {
  const rows = buildRows(agents, modelResources.resources, modelResources.byKey);
  const hasSnapshot = modelResources.generatedAt !== null || modelResources.resources.length > 0;

  return (
    <section
      className="usage-section model-resource-section"
      aria-labelledby="model-resource-heading"
      aria-busy={modelResources.loading || modelResources.refreshing}
    >
      <div className="usage-section-head model-resource-head">
        <div>
          <span className="eyebrow">Current runtime</span>
          <h3 id="model-resource-heading">Model resources</h3>
          <p>Endpoint availability and recent provider-reported consumption.</p>
        </div>
        <button
          type="button"
          className="button button-ghost"
          onClick={() => void modelResources.refresh()}
          disabled={modelResources.refreshing}
          aria-label="Refresh model resources"
        >
          {modelResources.refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>

      {modelResources.loading && modelResources.resources.length === 0 && (
        <p className="model-resource-state" role="status" aria-live="polite">
          Loading running endpoints…
        </p>
      )}
      {modelResources.error && (
        <p className="model-resource-state is-warning" role="status">
          {hasSnapshot
            ? "Showing the last successful resource snapshot — "
            : "Live model resources are unavailable — "}{modelResources.error}
        </p>
      )}
      {!modelResources.loading && rows.length === 0 && !modelResources.error && (
        <p className="usage-empty">No explicit Agent model assignments or running endpoints were reported.</p>
      )}

      {rows.length > 0 && (
        <div className="usage-table-scroll">
          <table className="usage-table model-resource-table">
            <caption className="sr-only">Live model resource status</caption>
            <thead>
              <tr>
                <th scope="col">Agent / model</th>
                <th scope="col">Endpoint</th>
                <th scope="col">Consumed</th>
                <th scope="col">Quota</th>
                <th scope="col">Last observed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = statusValue(row.resource);
                return (
                  <tr key={row.key}>
                    <th scope="row">
                      <span className="model-resource-agents">
                        {row.agents.length > 0 ? row.agents.join(", ") : "Unassigned endpoint"}
                      </span>
                      <span className="usage-row-meta">
                        {row.providerId} / {row.resource?.name || row.modelId}
                      </span>
                    </th>
                    <td>
                      <span className={`model-resource-status is-${status.tone}`}>
                        <span aria-hidden="true">{status.glyph}</span>
                        {status.label}
                      </span>
                      <span className="model-resource-freshness">{status.freshness}</span>
                      {row.resource && modelResourceRateLimitLabel(row.resource) && (
                        <span className="model-resource-freshness">
                          {modelResourceRateLimitLabel(row.resource)}
                        </span>
                      )}
                    </td>
                    <td className="numeric">{usageValue(row.resource)}</td>
                    <td className="numeric">{quotaValue(row.resource)}</td>
                    <td>{row.resource ? modelResourceObservedLabel(row.resource) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
