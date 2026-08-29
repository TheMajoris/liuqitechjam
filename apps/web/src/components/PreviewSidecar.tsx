import { useEffect, useRef, useState } from "react";
import type { Preview } from "../types";

export type PreviewActionError = {
  message: string;
  errorCode: string | null;
};

const statusCopy: Record<Preview["status"] | "not_started", string> = {
  not_started: "Not running",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  interrupted: "Interrupted",
};

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function PreviewStatusPill({ status }: { status: Preview["status"] | "not_started" }) {
  return (
    <span className={"preview-status preview-status-" + status}>
      <span className="status-dot" aria-hidden="true" />
      {statusCopy[status]}
    </span>
  );
}

/**
 * Live artifact frame.
 *
 * Keyed on `reloadToken` so a manual reload remounts the element: a same-origin
 * navigation would otherwise be blocked from the parent document.
 */
function PreviewFrame({ url, reloadToken }: { url: string; reloadToken: number }) {
  return (
    <iframe
      key={reloadToken}
      className="preview-frame"
      src={url}
      title="Live preview of the Agent workspace app"
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
      loading="lazy"
    />
  );
}

export function PreviewSidecar({
  open,
  preview,
  logs,
  busy,
  actionError,
  onClose,
  onStart,
  onRestart,
  onStop,
  onOpenExternal,
}: {
  open: boolean;
  preview: Preview | null;
  logs: string[];
  busy: string | null;
  actionError: PreviewActionError | null;
  onClose: () => void;
  onStart: () => void;
  onRestart: () => void;
  onStop: () => void;
  onOpenExternal: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const autoExpandedFor = useRef<string | null>(null);

  const status = preview?.status ?? "not_started";
  const running = status === "running";
  const transitioning = status === "starting" || status === "stopping";
  // A runtime that holds resources can always be stopped, even after a failure.
  const stoppable = running || transitioning || status === "interrupted";

  // Persisted backend failures outrank the transient error from the last click.
  const persistedError =
    preview && (preview.errorMessage || preview.errorCode)
      ? {
          message: preview.errorMessage || "The preview could not be started.",
          errorCode: preview.errorCode,
        }
      : null;
  const displayedError = persistedError ?? actionError;

  // Reveal logs once per failure so the cause is visible without a second click,
  // while still respecting a manual collapse afterwards.
  useEffect(() => {
    if (!displayedError) {
      autoExpandedFor.current = null;
      return;
    }
    const signature = (displayedError.errorCode ?? "") + displayedError.message;
    if (autoExpandedFor.current === signature) return;
    autoExpandedFor.current = signature;
    setLogsOpen(true);
  }, [displayedError]);

  if (!open) return null;

  return (
    <aside id="preview-sidecar" className="preview-sidecar" aria-labelledby="preview-sidecar-title">
      <header className="sidecar-head">
        <div className="sidecar-title">
          <h2 id="preview-sidecar-title">Preview</h2>
          <PreviewStatusPill status={status} />
        </div>
        <div className="sidecar-head-actions">
          {running && preview?.url && (
            <button
              type="button"
              className="icon-button"
              onClick={() => setReloadToken((value) => value + 1)}
              aria-label="Reload preview frame"
              title="Reload preview"
            >
              <span aria-hidden="true">↻</span>
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close preview panel"
            title="Close panel — the server keeps running"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </header>

      <div className="sidecar-body">
        {displayedError && (
          <div className="preview-error" role="alert">
            <div className="preview-error-heading">
              <strong>Preview failed</strong>
              {displayedError.errorCode && (
                <code className="preview-error-code">{displayedError.errorCode}</code>
              )}
            </div>
            <p>{displayedError.message}</p>
          </div>
        )}

        <div className="sidecar-stage">
          {running && preview?.url ? (
            <PreviewFrame url={preview.url} reloadToken={reloadToken} />
          ) : transitioning ? (
            <div className="sidecar-placeholder" role="status">
              <Spinner />
              <p>{status === "starting" ? "Booting the workspace app…" : "Shutting the server down…"}</p>
            </div>
          ) : (
            <div className="sidecar-placeholder">
              <div className="sidecar-glyph" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <h3>{status === "not_started" ? "No preview server yet" : "The preview server is " + statusCopy[status].toLowerCase()}</h3>
              <p>Run the app from this Agent&apos;s persistent workspace to see it live here.</p>
              <button
                type="button"
                className="button button-primary"
                onClick={status === "not_started" ? onStart : onRestart}
                disabled={busy !== null}
              >
                {busy === "start" || busy === "restart" ? (
                  <Spinner />
                ) : status === "not_started" ? (
                  "Start Preview"
                ) : (
                  "Start again"
                )}
              </button>
            </div>
          )}
        </div>

        {preview?.url && running && (
          <a
            className="preview-url"
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              onOpenExternal();
            }}
          >
            {preview.url}
          </a>
        )}

        <section className="sidecar-logs">
          <button
            type="button"
            className="sidecar-logs-toggle"
            aria-expanded={logsOpen}
            aria-controls="preview-logs-body"
            onClick={() => setLogsOpen((value) => !value)}
          >
            <span className={"disclosure " + (logsOpen ? "is-open" : "")} aria-hidden="true">
              ▸
            </span>
            Logs
            {logs.length > 0 && <span className="sidecar-logs-count">{logs.length}</span>}
          </button>
          {logsOpen && (
            <div id="preview-logs-body" className="sidecar-logs-body" aria-live="polite">
              {logs.length > 0 ? (
                <pre>{logs.join("\n")}</pre>
              ) : (
                <span className="preview-logs-empty">No runtime logs yet.</span>
              )}
            </div>
          )}
        </section>
      </div>

      <footer className="sidecar-actions">
        <button
          type="button"
          className="button button-ghost"
          onClick={onRestart}
          disabled={busy !== null || status === "stopping"}
        >
          {busy === "restart" ? <Spinner /> : "Restart"}
        </button>
        <button
          type="button"
          className="button button-ghost"
          onClick={onOpenExternal}
          disabled={!running || !preview?.url}
        >
          Open External ↗
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={onStop}
          disabled={busy !== null || !stoppable}
          title="Stop the Preview server. This does not stop the Agent."
        >
          {busy === "stop" ? <Spinner /> : "Stop Server"}
        </button>
      </footer>
    </aside>
  );
}
