import { useCallback } from "react";
import { api } from "../../api/client";
import type { Provider } from "../../api/contracts";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import {
  DegradedBanner,
  EmptyState,
  ErrorState,
  LoadingState,
} from "../../shared/ui/states";

export function ProvidersPage() {
  const fetcher = useCallback(() => api.listProviders(), []);
  const { data, error, loading, status, refetch } = usePolledResource(
    "providers",
    fetcher,
    { intervalMs: 15000 },
  );

  const providers: Provider[] = data?.providers ?? [];
  const degraded = providers.filter(
    (p) => p.health === "degraded" || p.health === "unknown",
  );

  return (
    <div className="page">
      <PageHeader
        title="Providers"
        lead="Responses-compatible model providers. Credentials are held only by the gateway sidecar — this catalog never carries a key or a base URL."
      />

      {loading ? (
        <LoadingState label="Loading providers…" />
      ) : error ? (
        <ErrorState message={error} status={status} onRetry={refetch} />
      ) : providers.length === 0 ? (
        <EmptyState
          title="No providers configured"
          hint="Add a Responses-compatible provider to the gateway configuration."
        />
      ) : (
        <>
          {degraded.length > 0 ? (
            <DegradedBanner>
              {degraded.length} provider{degraded.length > 1 ? "s" : ""} report
              non-nominal health ({degraded.map((p) => p.id).join(", ")}). Live
              providers stay <code>unknown</code> until their first gateway call.
            </DegradedBanner>
          ) : null}

          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">Configured model providers</caption>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Protocol</th>
                  <th scope="col">Models</th>
                  <th scope="col">Credential mode</th>
                  <th scope="col">Health</th>
                  <th scope="col">Kind</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">
                      <code>{p.id}</code>
                    </th>
                    <td>{p.protocol}</td>
                    <td>
                      <ul className="tag-list">
                        {p.models.map((m) => (
                          <li key={m} className="tag">
                            {m}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <span className="tag tag-lock">{p.credentialMode}</span>
                    </td>
                    <td>
                      <StatusPill status={p.health} />
                    </td>
                    <td>{p.live ? "live" : "deterministic mock"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="fine-print">
            The control plane deliberately withholds provider base URLs so this
            view cannot be used to route requests around the gateway.
          </p>
        </>
      )}
    </div>
  );
}
