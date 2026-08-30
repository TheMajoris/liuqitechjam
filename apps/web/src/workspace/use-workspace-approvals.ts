import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { ApprovalRecord } from "../types";

export interface WorkspaceApprovalsController {
  /** `null` means the approvals API is not configured for this deployment. */
  approvals: ApprovalRecord[] | null;
  loading: boolean;
  error: string | null;
  busyId: string | null;
  approve: (id: string, scope: "once" | "project") => Promise<void>;
  deny: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 4_000;

/**
 * Reads the Permit-backed approval projection for one Project.
 *
 * The frontend never decides anything here: it lists what the server already
 * recorded and forwards the human's answer to the existing approve/deny
 * routes. A 503 means approvals are not configured, which leaves the feature
 * dormant — it never means "allowed".
 */
export function useWorkspaceApprovals(
  projectId: string | null,
  active: boolean,
): WorkspaceApprovalsController {
  const [approvals, setApprovals] = useState<ApprovalRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(true);
  const unavailable = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId || unavailable.current) return;
    setLoading(true);
    try {
      const { approvals: next } = await api.listApprovals({ projectId });
      if (!mounted.current) return;
      setApprovals(next);
      setError(null);
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError && (reason.status === 503 || reason.status === 404)) {
        unavailable.current = true;
        setApprovals(null);
        setError(null);
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    unavailable.current = false;
    setApprovals(null);
    void refresh();
  }, [refresh]);

  // Only a running Team can raise a new approval, so the loop is scoped to it.
  useEffect(() => {
    if (!projectId || !active) return;
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, projectId, refresh]);

  const decide = useCallback(
    async (id: string, run: () => Promise<unknown>) => {
      setBusyId(id);
      setError(null);
      try {
        await run();
        await refresh();
      } catch (reason) {
        if (mounted.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (mounted.current) setBusyId(null);
      }
    },
    [refresh],
  );

  const approve = useCallback(
    (id: string, scope: "once" | "project") => decide(id, () => api.approveApproval(id, scope)),
    [decide],
  );

  const deny = useCallback((id: string) => decide(id, () => api.denyApproval(id)), [decide]);

  return { approvals, loading, error, busyId, approve, deny, refresh };
}
