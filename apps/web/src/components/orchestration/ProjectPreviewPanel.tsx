import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { Preview } from "../../types";

type PanelError = { message: string; errorCode: string | null };

const statusCopy: Record<Preview["status"] | "not_started", string> = {
  not_started: "Not running",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  interrupted: "Interrupted",
};

function toPanelError(reason: unknown): PanelError {
  if (reason instanceof ApiError) {
    return { message: reason.message, errorCode: reason.errorCode };
  }
  return {
    message: "Unable to complete the preview request. Please try again.",
    errorCode: null,
  };
}

/**
 * The Team's canonical artifact.
 *
 * One Project preview serves the shared workspace, so it is deliberately
 * independent of whichever Agent is currently speaking: it survives turn
 * changes and is not stopped when the conversation stops.
 */
export function ProjectPreviewPanel({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<PanelError | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { preview: next } = await api.getProjectPreview(projectId);
      if (!mounted.current) return;
      setPreview(next);
      if (next.status === "running") {
        const result = await api.getProjectPreviewLogs(projectId, 100).catch(() => null);
        if (result && mounted.current) setLogs(result.logs);
      }
    } catch (reason) {
      // A Project with no preview yet is the normal empty state, not a failure.
      if (reason instanceof ApiError && reason.status === 404) {
        if (mounted.current) setPreview(null);
        return;
      }
      if (mounted.current) setError(toPanelError(reason));
    }
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // Poll while the runtime is between states so the panel settles on its own.
  useEffect(() => {
    const status = preview?.status;
    if (status !== "starting" && status !== "stopping") return;
    const interval = window.setInterval(() => void refresh(), 1_200);
    return () => window.clearInterval(interval);
  }, [preview?.status, refresh]);

  const act = async (action: "start" | "restart" | "stop") => {
    setBusy(action);
    setError(null);
    try {
      const call =
        action === "start"
          ? api.startProjectPreview
          : action === "restart"
            ? api.restartProjectPreview
            : api.stopProjectPreview;
      const { preview: next } = await call(projectId);
      if (!mounted.current) return;
      setPreview(next);
      if (next.status !== "running") setLogs([]);
    } catch (reason) {
      if (mounted.current) setError(toPanelError(reason));
      await refresh();
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

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
          <span className="orch-eyebrow">Shared Project</span>
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
            <strong>Project preview failed</strong>
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
                ? "Booting the shared Project app…"
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
                ? "No Project preview yet"
                : "The Project preview is " + statusCopy[status].toLowerCase()}
            </h3>
            <p>
              Every Agent on this Team writes to the same workspace. Start the preview to
              see their combined result.
            </p>
            <button
              type="button"
              className="button button-primary"
              onClick={() => void act(status === "not_started" ? "start" : "restart")}
              disabled={busy !== null}
            >
              {busy === null ? "Start Project Preview" : <span className="spinner" />}
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
          title="Stop the Project preview server. This does not stop the Team."
        >
          Stop Server
        </button>
      </footer>
    </section>
  );
}
