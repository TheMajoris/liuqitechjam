import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Preview } from "../types";

export type PreviewAction = "start" | "restart" | "stop";

export interface PreviewError {
  message: string;
  errorCode: string | null;
}

export interface ProjectPreviewController {
  preview: Preview | null;
  logs: string[];
  busy: PreviewAction | null;
  error: PreviewError | null;
  refresh: () => Promise<void>;
  act: (action: PreviewAction) => Promise<void>;
}

function toPreviewError(reason: unknown): PreviewError {
  if (reason instanceof ApiError) {
    return { message: reason.message, errorCode: reason.errorCode };
  }
  return {
    message: "Unable to complete the preview request. Please try again.",
    errorCode: null,
  };
}

/**
 * One Project preview controller for the whole workspace.
 *
 * The scene, the header and the Preview panel all read this single hook, so
 * showing the preview in three places still costs one request loop — and that
 * loop only runs while the runtime is mid-transition.
 */
export function useProjectPreview(projectId: string | null): ProjectPreviewController {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<PreviewAction | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setPreview(null);
      setLogs([]);
      return;
    }
    try {
      const { preview: next } = await api.getProjectPreview(projectId);
      if (!mounted.current) return;
      setPreview(next);
      if (next.status === "running" || next.status === "failed") {
        const result = await api.getProjectPreviewLogs(projectId, 100).catch(() => null);
        if (result && mounted.current) setLogs(result.logs);
      } else if (mounted.current) {
        setLogs([]);
      }
    } catch (reason) {
      // A Project with no preview yet is the normal empty state, not a failure.
      if (reason instanceof ApiError && reason.status === 404) {
        if (mounted.current) {
          setPreview(null);
          setLogs([]);
        }
        return;
      }
      if (mounted.current) setError(toPreviewError(reason));
    }
  }, [projectId]);

  useEffect(() => {
    setPreview(null);
    setLogs([]);
    setError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const status = preview?.status;
    if (status !== "starting" && status !== "stopping") return;
    const interval = window.setInterval(() => void refresh(), 1_200);
    return () => window.clearInterval(interval);
  }, [preview?.status, refresh]);

  const act = useCallback(
    async (action: PreviewAction) => {
      if (!projectId) return;
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
        if (mounted.current) setError(toPreviewError(reason));
        await refresh();
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [projectId, refresh],
  );

  return { preview, logs, busy, error, refresh, act };
}
