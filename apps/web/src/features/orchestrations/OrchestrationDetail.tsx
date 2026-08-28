import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import {
  ErrorState,
  InlineError,
  LoadingState,
} from "../../shared/ui/states";
import { formatDateTime } from "../../shared/utils/format";
import { HandoffTimeline } from "./HandoffTimeline";
import { StageStrip } from "./StageStrip";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function OrchestrationDetail() {
  const { orchestrationId = "" } = useParams();
  const [killBusy, setKillBusy] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [killOutcome, setKillOutcome] = useState<string | null>(null);

  const fetcher = useCallback(
    () => api.getOrchestration(orchestrationId),
    [orchestrationId],
  );
  const view = usePolledResource(
    `orchestration:${orchestrationId}`,
    fetcher,
    { intervalMs: 2500, enabled: orchestrationId !== "" },
  );

  const agentsFetcher = useCallback(() => api.listAgents(), []);
  const agents = usePolledResource("orch-detail:agents", agentsFetcher, {
    intervalMs: 30000,
  });

  if (view.loading) {
    return (
      <div className="page">
        <LoadingState label="Loading orchestration…" />
      </div>
    );
  }
  if (view.error || !view.data) {
    return (
      <div className="page">
        <PageHeader title="Orchestration" />
        <ErrorState
          message={view.error ?? "Orchestration not found."}
          status={view.status}
          onRetry={view.refetch}
        />
      </div>
    );
  }

  const { orchestration: o, queuePosition, messages } = view.data;
  const terminal = TERMINAL.has(o.status);
  const agentList = agents.data?.agents ?? [];

  const kill = async () => {
    if (
      !window.confirm(
        "Cancel this orchestration? Pending stages are cancelled and the active stage's model lease is revoked before its runtime is stopped. This cannot be undone.",
      )
    ) {
      return;
    }
    setKillBusy(true);
    setKillError(null);
    setKillOutcome(null);
    try {
      const result = await api.cancelOrchestration(o.id);
      const cancelledStages = result.orchestration.stages
        .filter((s) => s.status === "cancelled")
        .map((s) => s.stage);
      setKillOutcome(
        `Orchestration is now "${result.orchestration.status}". ` +
          (cancelledStages.length
            ? `Cancelled stage(s): ${cancelledStages.join(", ")}.`
            : "No stages required cancellation.") +
          " The active lease is revoked before the runtime is terminated.",
      );
      view.refetch();
    } catch (reason) {
      setKillError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setKillBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title={`Orchestration #${o.sequence}`}
        lead={o.prompt}
        meta={
          <p className="breadcrumb">
            <Link to="/orchestrations" className="text-link">
              Orchestrations
            </Link>
            <span aria-hidden="true"> / </span>#{o.sequence}
          </p>
        }
        actions={
          <div className="page-header-actions">
            <StatusPill status={o.status} />
            <button
              type="button"
              className="button button-danger button-kill"
              onClick={kill}
              disabled={killBusy || terminal}
              title={
                terminal
                  ? "This orchestration has already reached a terminal state"
                  : "Revoke the lease and terminate the active runtime"
              }
            >
              {killBusy ? "Cancelling…" : "Cancel / Kill"}
            </button>
          </div>
        }
      />

      {killError ? <InlineError message={killError} /> : null}
      {killOutcome ? (
        <div className="degraded-banner" role="status">
          <span className="degraded-dot" aria-hidden="true" />
          <span>{killOutcome}</span>
        </div>
      ) : null}

      <section className="panel">
        <h2>Pipeline</h2>
        <StageStrip stages={o.stages} />
        <dl className="detail-grid">
          <div>
            <dt>Queue position</dt>
            <dd>
              {queuePosition === null
                ? terminal
                  ? "—"
                  : "not queued"
                : queuePosition === 0
                  ? "0 · a stage is running"
                  : `${queuePosition} in line`}
            </dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>
              <Link
                to={`/projects/${o.projectId}`}
                className="text-link"
              >
                {o.projectId.slice(0, 8)}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>
              <code>{o.providerId}</code>
            </dd>
          </div>
          <div>
            <dt>Trace</dt>
            <dd>
              <code>{o.traceId}</code>
            </dd>
          </div>
          <div>
            <dt>Idempotency key</dt>
            <dd>{o.idempotencyKey ? <code>{o.idempotencyKey}</code> : "—"}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDateTime(o.createdAt)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDateTime(o.updatedAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>Stage runs</h2>
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Runs produced by each stage</caption>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">Status</th>
                <th scope="col">Attempt</th>
                <th scope="col">Started</th>
                <th scope="col">Completed</th>
                <th scope="col">Run</th>
              </tr>
            </thead>
            <tbody>
              {o.stages.map((s) => (
                <tr key={s.stage}>
                  <th scope="row">{s.stage}</th>
                  <td>
                    <StatusPill status={s.status} />
                  </td>
                  <td>{s.attempt}</td>
                  <td>{formatDateTime(s.startedAt)}</td>
                  <td>{formatDateTime(s.completedAt)}</td>
                  <td>
                    {s.runId ? (
                      <Link
                        to={`/runs?orchestrationId=${o.id}&run=${s.runId}`}
                        className="text-link"
                      >
                        open in inspector
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
      </section>

      {o.result || o.error ? (
        <section className="panel">
          <h2>Outcome</h2>
          {o.error ? (
            <p className="inline-error">{o.error}</p>
          ) : (
            <pre className="result-block">{o.result}</pre>
          )}
        </section>
      ) : null}

      <section className="panel">
        <h2>Handoff messages</h2>
        <HandoffTimeline messages={messages} agents={agentList} />
      </section>
    </div>
  );
}
