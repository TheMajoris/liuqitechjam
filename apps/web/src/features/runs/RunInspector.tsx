import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { Span } from "../../api/contracts";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { StatusPill } from "../../shared/ui/StatusPill";
import {
  ErrorState,
  InlineError,
  LoadingState,
} from "../../shared/ui/states";
import {
  durationBetween,
  formatDateTime,
  formatDuration,
  formatTokens,
} from "../../shared/utils/format";
import { SecurityEnvelope } from "./SecurityEnvelope";

const TABS = ["overview", "trace", "logs", "usage", "security"] as const;
type Tab = (typeof TABS)[number];

const ACTIVE = new Set(["queued", "running"]);

function SpanRow({ span }: { span: Span }) {
  return (
    <tr>
      <td>
        <code>{span.kind}</code>
        <span className="cell-sub">{span.name}</span>
      </td>
      <td>
        <StatusPill status={span.status} />
      </td>
      <td>{formatDuration(span.durationMs)}</td>
      <td>{span.code ? <code>{span.code}</code> : "—"}</td>
      <td>{span.attempt ?? "—"}</td>
    </tr>
  );
}

export function RunInspector({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");

  const runFetcher = useCallback(() => api.getRun(runId), [runId]);
  const run = usePolledResource(`inspector:run:${runId}`, runFetcher, {
    intervalMs: 3000,
  });

  const isActive = run.data ? ACTIVE.has(run.data.run.status) : true;

  const obsFetcher = useCallback(
    () => api.runObservability(runId),
    [runId],
  );
  const obs = usePolledResource(`inspector:obs:${runId}`, obsFetcher, {
    intervalMs: isActive ? 3000 : undefined,
  });

  const spans = useMemo<Span[]>(() => obs.data?.spans ?? [], [obs.data]);

  const header = (
    <div className="inspector-head">
      <div>
        <span className="panel-eyebrow">Run Inspector</span>
        <h2>
          <code>{runId.slice(0, 8)}</code>
          {run.data ? (
            <StatusPill status={run.data.run.status} />
          ) : null}
        </h2>
      </div>
      <button
        type="button"
        className="icon-button"
        onClick={onClose}
        aria-label="Close Run Inspector"
      >
        ×
      </button>
    </div>
  );

  if (run.loading) {
    return (
      <aside className="inspector" aria-label="Run Inspector">
        {header}
        <LoadingState label="Loading run…" />
      </aside>
    );
  }
  if (run.error || !run.data) {
    return (
      <aside className="inspector" aria-label="Run Inspector">
        {header}
        <ErrorState
          message={run.error ?? "Run not found."}
          status={run.status}
          onRetry={run.refetch}
        />
      </aside>
    );
  }

  const r = run.data.run;
  const usage = obs.data?.usage ?? r.usage ?? {};
  const counts = obs.data?.counts;
  const securitySpans = spans.filter(
    (s) =>
      s.kind === "security.deny" ||
      s.kind === "security.kill" ||
      s.kind.startsWith("gateway."),
  );

  return (
    <aside className="inspector" aria-label="Run Inspector">
      {header}

      <div className="tab-row" role="tablist" aria-label="Run Inspector sections">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            id={`tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`panel-${name}`}
            className={`tab${tab === name ? " is-active" : ""}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {obs.error && obs.status === 404 ? (
        <div className="degraded-banner" role="status">
          <span className="degraded-dot" aria-hidden="true" />
          <span>Observability data is not available for this run.</span>
        </div>
      ) : null}

      {tab === "overview" ? (
        <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">
          <dl className="detail-grid">
            <div>
              <dt>Status</dt>
              <dd>
                <StatusPill status={r.status} />
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{durationBetween(r.startedAt, r.completedAt)}</dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd>{r.attempt ?? 1}</dd>
            </div>
            <div>
              <dt>Stage</dt>
              <dd>{r.stage ?? "—"}</dd>
            </div>
            <div>
              <dt>Agent</dt>
              <dd>
                <Link to={`/agents/${r.agentId}`} className="text-link">
                  {r.agentId.slice(0, 8)}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>
                {r.projectId ? (
                  <Link
                    to={`/projects/${r.projectId}`}
                    className="text-link"
                  >
                    {r.projectId.slice(0, 8)}
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Orchestration</dt>
              <dd>
                {r.orchestrationId ? (
                  <Link
                    to={`/orchestrations/${r.orchestrationId}`}
                    className="text-link"
                  >
                    {r.orchestrationId.slice(0, 8)}
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Trace</dt>
              <dd>{r.traceId ? <code>{r.traceId}</code> : "—"}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDateTime(r.createdAt)}</dd>
            </div>
          </dl>
          {r.error ? <InlineError message={r.error} /> : null}
          <h3 className="sub-head">Prompt</h3>
          <pre className="result-block">{r.prompt}</pre>
          {r.output ? (
            <>
              <h3 className="sub-head">Output preview</h3>
              <pre className="result-block">{r.output}</pre>
            </>
          ) : null}
        </div>
      ) : null}

      {tab === "trace" ? (
        <div id="panel-trace" role="tabpanel" aria-labelledby="tab-trace">
          {spans.length === 0 ? (
            <p className="cell-muted">No spans recorded for this run.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">Trace spans</caption>
                <thead>
                  <tr>
                    <th scope="col">Span</th>
                    <th scope="col">Status</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Code</th>
                    <th scope="col">Attempt</th>
                  </tr>
                </thead>
                <tbody>
                  {spans.map((s) => (
                    <SpanRow key={s.id} span={s} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {obs.data?.truncated ? (
            <p className="fine-print">
              Telemetry for this run hit the per-run record cap; older spans were
              dropped.
            </p>
          ) : null}
        </div>
      ) : null}

      {tab === "logs" ? (
        <div id="panel-logs" role="tabpanel" aria-labelledby="tab-logs">
          {spans.filter((s) => s.preview).length === 0 ? (
            <p className="cell-muted">No log previews for this run.</p>
          ) : (
            <ol className="log-list">
              {spans
                .filter((s) => s.preview)
                .map((s) => (
                  <li key={s.id} className="log-line">
                    <div className="log-meta">
                      <code>{s.kind}</code>
                      <StatusPill status={s.status} />
                      <span>{formatDateTime(s.startedAt)}</span>
                    </div>
                    <p className="log-preview">{s.preview}</p>
                  </li>
                ))}
            </ol>
          )}
          <p className="fine-print">
            Previews are redacted and capped before storage — no raw prompts,
            provider bodies, or chain-of-thought.
          </p>
        </div>
      ) : null}

      {tab === "usage" ? (
        <div id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
          <dl className="detail-grid">
            <div>
              <dt>Input tokens</dt>
              <dd>{formatTokens(usage.inputTokens)}</dd>
            </div>
            <div>
              <dt>Cached input tokens</dt>
              <dd>{formatTokens(usage.cachedInputTokens)}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{formatTokens(usage.outputTokens)}</dd>
            </div>
            {counts ? (
              <>
                <div>
                  <dt>Spans</dt>
                  <dd>{counts.total}</dd>
                </div>
                <div>
                  <dt>Errors</dt>
                  <dd>{counts.errors}</dd>
                </div>
                <div>
                  <dt>Denied</dt>
                  <dd>{counts.denied}</dd>
                </div>
              </>
            ) : null}
          </dl>
          <p className="fine-print">
            Usage is summed from <code>provider.responses</code> spans by the
            telemetry ledger.
          </p>
        </div>
      ) : null}

      {tab === "security" ? (
        <div
          id="panel-security"
          role="tabpanel"
          aria-labelledby="tab-security"
        >
          <SecurityEnvelope run={r} spans={spans} />
          <h3 className="sub-head">Security &amp; gateway events</h3>
          {securitySpans.length === 0 ? (
            <p className="cell-muted">
              No gateway or security events for this run.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">Security events</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Status</th>
                    <th scope="col">Code</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {securitySpans.map((s) => (
                    <tr key={s.id}>
                      <th scope="row">
                        <code>{s.kind}</code>
                      </th>
                      <td>
                        <StatusPill status={s.status} />
                      </td>
                      <td>{s.code ? <code>{s.code}</code> : "—"}</td>
                      <td>{formatDateTime(s.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
