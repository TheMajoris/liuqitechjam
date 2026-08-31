import { useState } from "react";
import type { Preview } from "../../types";
import type { ProjectPreviewController } from "../../workspace/use-project-preview";

const statusCopy: Record<Preview["status"] | "not_started", string> = {
  not_started: "Not running",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  interrupted: "Interrupted",
};

/**
 * The Team's canonical artifact.
 *
 * One Project preview serves the shared workspace, so it is deliberately
 * independent of whichever Agent is currently speaking: it survives turn
 * changes and is not stopped when the conversation stops. Lifecycle lives in
 * `useProjectPreview`, shared with the room and the header, so the preview is
 * shown in three places at the cost of one request loop.
 */
export function ProjectPreviewPanel({
  controller,
  projectName,
}: {
  controller: ProjectPreviewController;
  projectName: string;
}) {
  const { preview, logs, busy, error, act } = controller;
  const [logsOpen, setLogsOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const status = preview?.status ?? "not_started";
  const running = status === "running";
  const transitioning = status === "starting" || status === "stopping";
  const stoppable = running || transitioning || status === "interrupted";
  const persisted =
    preview && (preview.errorMessage || preview.errorCode)
      ? {
          message: preview.errorMessage || "The preview could not be started.",
          errorCode: preview.errorCode,
        }
      : null;
  const shown = persisted ?? error;

  return (
    <section className="project-preview" aria-label={"Shared preview for " + projectName}>
      <header className="project-preview-head">
        <div className="project-preview-title">
          <span className="orch-eyebrow">Workspace preview</span>
          <h3>{projectName}</h3>
        </div>
        <span className={"preview-status preview-status-" + status}>
          <span className="status-dot" aria-hidden="true" />
          {statusCopy[status]}
        </span>
      </header>

      {shown && (
        <div className="preview-error" role="alert">
          <div className="preview-error-heading">
            <strong>Workspace preview failed</strong>
            {shown.errorCode && <code className="preview-error-code">{shown.errorCode}</code>}
          </div>
          <p>{shown.message}</p>
        </div>
      )}

      <div className="project-preview-stage">
        {running && preview?.url ? (
          <iframe
            key={reloadToken}
            className="preview-frame"
            src={preview.url}
            title={"Live preview of " + projectName}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
          />
        ) : transitioning ? (
          <div className="sidecar-placeholder" role="status">
            <span className="spinner" aria-hidden="true" />
            <p>
              {status === "starting"
                ? "Booting the shared Workspace app…"
                : "Shutting the server down…"}
            </p>
          </div>
        ) : (
          <div className="sidecar-placeholder">
            <div className="sidecar-glyph" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <h3>
              {status === "not_started"
                ? "No Workspace preview yet"
                : "The Workspace preview is " + statusCopy[status].toLowerCase()}
            </h3>
            <p>
              Every Agent on this Team writes to the same workspace. Start the preview to
              see the combined result.
            </p>
            <button
              type="button"
              className="button button-primary"
              onClick={() => void act(status === "not_started" ? "start" : "restart")}
              disabled={busy !== null}
            >
              {busy === null ? "Start Workspace Preview" : <span className="spinner" />}
            </button>
          </div>
        )}
      </div>

      {running && preview?.url && (
        <a
          className="preview-url"
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {preview.url}
        </a>
      )}

      <section className="sidecar-logs">
        <button
          type="button"
          className="sidecar-logs-toggle"
          aria-expanded={logsOpen}
          aria-controls="project-preview-logs"
          onClick={() => setLogsOpen((value) => !value)}
        >
          <span className={"disclosure " + (logsOpen ? "is-open" : "")} aria-hidden="true">
            ▸
          </span>
          Logs
          {logs.length > 0 && <span className="sidecar-logs-count">{logs.length}</span>}
        </button>
        {logsOpen && (
          <div id="project-preview-logs" className="sidecar-logs-body" aria-live="polite">
            {logs.length > 0 ? (
              <pre>{logs.join("\n")}</pre>
            ) : (
              <span className="preview-logs-empty">No runtime logs yet.</span>
            )}
          </div>
        )}
      </section>

      <footer className="project-preview-actions">
        {running && (
          <button
            type="button"
            className="button button-ghost"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            Reload
          </button>
        )}
        <button
          type="button"
          className="button button-ghost"
          onClick={() => void act("restart")}
          disabled={busy !== null || status === "stopping"}
        >
          Restart
        </button>
        <button
          type="button"
          className="button button-ghost"
          onClick={() => preview?.url && window.open(preview.url, "_blank", "noopener")}
          disabled={!running || !preview?.url}
        >
          Open External ↗
        </button>
        {/* Distinct from the Team header's Stop, which ends the conversation. */}
        <button
          type="button"
          className="button button-danger"
          onClick={() => void act("stop")}
          disabled={busy !== null || !stoppable}
          title="Stop the Workspace preview server. This does not stop the Team."
        >
          Stop Server
        </button>
      </footer>
    </section>
  );
}
