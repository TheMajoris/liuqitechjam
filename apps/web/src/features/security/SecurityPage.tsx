import { useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import {
  DegradedBanner,
  ErrorState,
  LoadingState,
} from "../../shared/ui/states";
import { formatDateTime } from "../../shared/utils/format";

const DEMO_STEPS = [
  "Open a configured project and confirm the Planner, Builder and Reviewer assignments plus the gateway-managed providers.",
  "Submit a safe orchestration and watch FIFO admission and the fixed stage progression over the shared workspace.",
  "Open the Run Inspector and read the correlated runtime, gateway and provider spans, the redacted logs, the duration and the token usage.",
  "Launch the controlled malicious case: have the runtime try to read the provider credential and reach the provider directly.",
  "Invoke Cancel / Kill. Confirm lease revocation, the sanitized provider denial, runtime termination and cleanup, with the credential still absent.",
  "Start a new safe run and show it obtains a fresh lease and succeeds — recovery without weakening the boundary.",
];

export function SecurityPage() {
  const fetcher = useCallback(() => api.securityPosture(), []);
  const { data, error, loading, status, refetch } = usePolledResource(
    "security:posture",
    fetcher,
    { intervalMs: 5000 },
  );

  return (
    <div className="page">
      <PageHeader
        title="Security"
        lead="Kill Switch posture: what is protected, which controls are active, and the most recent denials and kills."
      />

      {loading ? (
        <LoadingState label="Loading security posture…" />
      ) : error ? (
        <ErrorState message={error} status={status} onRetry={refetch} />
      ) : data ? (
        <>
          {data.profile !== "secretless-gateway" ? (
            <DegradedBanner>
              Running in the <code>{data.profile}</code> profile — the secretless
              gateway is not the active enforcement path. This is a developer
              fallback and is excluded from the security claim.
            </DegradedBanner>
          ) : null}

          <section className="panel panel-accent">
            <h2>Protected asset</h2>
            <p className="protected-statement">{data.protectedAsset}</p>
            <p className="fine-print">
              Track: {data.track}. It must never enter a workspace, a runtime
              environment, a browser response, a log, a trace, or a screenshot.
            </p>
          </section>

          <section className="panel">
            <h2>Gateway</h2>
            <dl className="detail-grid">
              <div>
                <dt>Mode</dt>
                <dd>{data.gateway.mode}</dd>
              </div>
              <div>
                <dt>Management URL</dt>
                <dd>
                  {data.gateway.url ? (
                    <code>{data.gateway.url}</code>
                  ) : (
                    "not exposed"
                  )}
                </dd>
              </div>
              <div>
                <dt>Profile</dt>
                <dd>
                  <StatusPill
                    status={
                      data.profile === "secretless-gateway" ? "ok" : "degraded"
                    }
                    label={data.profile}
                  />
                </dd>
              </div>
            </dl>
          </section>

          <section className="panel">
            <h2>Active controls</h2>
            <ul className="control-list">
              {data.controls.map((control) => (
                <li key={control.id} className="control-item">
                  <span
                    className={`control-flag ${
                      control.active ? "is-on" : "is-off"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="control-label">{control.label}</span>
                  <StatusPill
                    status={control.active ? "ok" : "blocked"}
                    label={control.active ? "active" : "inactive"}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <h2>Recent denials &amp; kills</h2>
            {data.recentEvents.length === 0 ? (
              <p className="cell-muted">
                No denial, kill or revocation events recorded yet.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="sr-only">
                    Recent security events
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Event</th>
                      <th scope="col">Status</th>
                      <th scope="col">Code</th>
                      <th scope="col">Correlation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentEvents.map((event, index) => (
                      <tr key={`${event.at}-${index}`}>
                        <td>{formatDateTime(event.at)}</td>
                        <th scope="row">
                          <code>{event.kind}</code>
                        </th>
                        <td>
                          <StatusPill status={event.status} />
                        </td>
                        <td>{event.code ? <code>{event.code}</code> : "—"}</td>
                        <td>
                          {event.runId ? (
                            <Link
                              to={`/runs?run=${event.runId}`}
                              className="text-link"
                            >
                              run {event.runId.slice(0, 8)}
                            </Link>
                          ) : event.orchestrationId ? (
                            <Link
                              to={`/orchestrations/${event.orchestrationId}`}
                              className="text-link"
                            >
                              orchestration {event.orchestrationId.slice(0, 8)}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Controlled demo guide</h2>
            <ol className="demo-steps">
              {DEMO_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="fine-print">
              Run this only against the deterministic mock or an explicitly
              disposable workspace. No step should surface a secret or a raw
              lease in any view, log, or screenshot.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
