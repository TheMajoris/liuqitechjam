import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type ToolApprovalListQuery } from "../../api";
import type { ToolApproval } from "../../types";
import {
  ACTIVE_APPROVAL_STATUSES,
  mergeToolApprovals,
} from "./approval-utils";

const POLL_INTERVAL_MS = 2_000;
const MAX_REMEMBERED_APPROVALS = 48;
const EMPTY_APPROVALS: readonly ToolApproval[] = [];

export interface UseToolApprovalsOptions {
  runId?: string | null;
  orchestrationId?: string | null;
  projectId?: string | null;
  active?: boolean;
  /** Newer activity/detail responses can seed terminal state immediately. */
  initialApprovals?: readonly ToolApproval[];
}

export interface UseToolApprovalsResult {
  approvals: ToolApproval[];
  loading: boolean;
  /** Read errors are non-fatal because approval routes are optional by rollout. */
  error: string | null;
  pendingDecisionId: string | null;
  pendingDecision: "approve" | "reject" | null;
  decisionErrors: Readonly<Record<string, string>>;
  refresh: () => Promise<void>;
  decide: (approvalId: string, approved: boolean, reason?: string) => Promise<void>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof ApiError ? reason.message : "Could not refresh approvals";
}

function isOptionalRouteUnavailable(reason: unknown): boolean {
  return reason instanceof ApiError && (reason.status === 404 || reason.status === 503);
}

function hasScope(options: UseToolApprovalsOptions): boolean {
  return Boolean(options.runId || options.orchestrationId || options.projectId);
}

function scopeQuery(options: UseToolApprovalsOptions): ToolApprovalListQuery {
  return {
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.orchestrationId ? { orchestrationId: options.orchestrationId } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
  };
}

function matchesScope(approval: ToolApproval, options: UseToolApprovalsOptions): boolean {
  if (options.runId && approval.runId !== options.runId) return false;
  if (options.orchestrationId && approval.orchestrationId !== options.orchestrationId) return false;
  if (options.projectId && approval.projectId !== options.projectId) return false;
  return true;
}

function isActive(approval: ToolApproval): boolean {
  return ACTIVE_APPROVAL_STATUSES.includes(approval.status);
}

/**
 * Poll the server-owned projection for one direct Run or Team scope.
 *
 * The collection route is pending-only by contract. Remembered IDs are
 * re-read through the detail route so a decision that just became terminal is
 * still visible, while a 404 removes a projection that is no longer visible.
 */
export function useToolApprovals({
  runId = null,
  orchestrationId = null,
  projectId = null,
  active = false,
  // Keep the absent-projection default referentially stable. The caller often
  // has no `approvals` field on an older activity response; allocating a new
  // array here on every render would retrigger the scope effect (and its state
  // writes) indefinitely.
  initialApprovals = EMPTY_APPROVALS,
}: UseToolApprovalsOptions = {}): UseToolApprovalsResult {
  const options = useMemo(
    () => ({ runId, orchestrationId, projectId }),
    [orchestrationId, projectId, runId],
  );
  const scopeKey = `${runId ?? ""}|${orchestrationId ?? ""}|${projectId ?? ""}`;
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const approvalsRef = useRef<ToolApproval[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDecisionId, setPendingDecisionId] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<"approve" | "reject" | null>(null);
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({});
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingDecisionRef = useRef<string | null>(null);

  const commit = useCallback((next: ToolApproval[]) => {
    approvalsRef.current = next.slice(0, MAX_REMEMBERED_APPROVALS);
    setApprovals(approvalsRef.current);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A direct Run/Team switch must never show the previous scope's approval.
  useEffect(() => {
    generationRef.current += 1;
    // A decision belongs to the scope that created it. Clear the local
    // single-flight guard when switching Runs/Teams so the new scope is not
    // blocked by an old request. An old request's finally block is fenced by
    // its captured generation below and cannot clear a new one.
    pendingDecisionRef.current = null;
    const seeded = (initialApprovals ?? EMPTY_APPROVALS).filter((approval) =>
      matchesScope(approval, options),
    );
    approvalsRef.current = seeded.slice(0, MAX_REMEMBERED_APPROVALS);
    setApprovals(approvalsRef.current);
    setError(null);
    setDecisionErrors({});
    setPendingDecisionId(null);
    setPendingDecision(null);
    setLoading(false);
  }, [initialApprovals, options, scopeKey]);

  const refresh = useCallback(async () => {
    if (!hasScope(options)) {
      commit([]);
      return;
    }
    const generation = generationRef.current;
    setLoading(true);
    try {
      const listed = await api.listApprovals(scopeQuery(options));
      if (!mountedRef.current || generation !== generationRef.current) return;

      const scoped = listed.approvals.filter((approval) => matchesScope(approval, options));
      const listedIds = new Set(scoped.map((approval) => approval.approvalId));
      const remembered = approvalsRef.current.filter(
        (approval) => matchesScope(approval, options) && !listedIds.has(approval.approvalId),
      );
      const detailResults = await Promise.allSettled(
        remembered.slice(0, MAX_REMEMBERED_APPROVALS).map((approval) =>
          api.getApproval(approval.approvalId),
        ),
      );
      if (!mountedRef.current || generation !== generationRef.current) return;

      const reconciled: ToolApproval[] = [];
      for (const [index, result] of detailResults.entries()) {
        if (result.status === "fulfilled") {
          const approval = result.value.approval;
          if (matchesScope(approval, options)) reconciled.push(approval);
        } else if (!isOptionalRouteUnavailable(result.reason)) {
          // Keep a known terminal projection when the detail request was a
          // transient failure; the next poll can replace it.
          const fallback = remembered[index];
          if (fallback) reconciled.push(fallback);
        }
      }
      const retainedIds = new Set([
        ...scoped.map((approval) => approval.approvalId),
        ...reconciled.map((approval) => approval.approvalId),
      ]);
      // Keep the newest local version if a poll raced with a decision. A
      // projection that disappeared and returned 404 is intentionally not
      // retained, because it is no longer visible to this human.
      const retained = approvalsRef.current.filter((approval) =>
        retainedIds.has(approval.approvalId),
      );
      commit(mergeToolApprovals(retained, [...scoped, ...reconciled]));
      setError(null);
    } catch (reason) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      // Approval mode is intentionally optional during rollout. A disabled
      // route is an empty projection, not an error for the whole workspace.
      if (isOptionalRouteUnavailable(reason)) {
        setError(null);
      } else {
        setError(errorMessage(reason));
      }
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
    }
  }, [commit, options]);

  useEffect(() => {
    void refresh();
  }, [refresh, scopeKey]);

  const hasLiveApprovals = approvals.some(isActive);
  useEffect(() => {
    if (!active && !hasLiveApprovals) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, hasLiveApprovals, refresh]);

  const decide = useCallback(async (
    approvalId: string,
    approved: boolean,
    reason?: string,
  ) => {
    const current = approvalsRef.current.find((approval) => approval.approvalId === approvalId);
    if (!current || pendingDecisionRef.current !== null) return;
    const generation = generationRef.current;
    pendingDecisionRef.current = approvalId;
    setPendingDecisionId(approvalId);
    setPendingDecision(approved ? "approve" : "reject");
    setDecisionErrors((existing) => {
      const next = { ...existing };
      delete next[approvalId];
      return next;
    });
    try {
      const result = await api.decideApproval(approvalId, {
        expectedVersion: current.version,
        approved,
        ...(reason?.trim() ? { reason: reason.trim().slice(0, 512) } : {}),
      });
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        pendingDecisionRef.current !== approvalId
      ) return;
      commit(mergeToolApprovals(approvalsRef.current, [result.approval]));
    } catch (cause) {
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        pendingDecisionRef.current !== approvalId
      ) return;
      // A 409 is expected when another tab decided first or the deadline
      // elapsed. Refresh and leave the authoritative server state visible.
      await refresh();
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        pendingDecisionRef.current !== approvalId
      ) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setDecisionErrors((existing) => ({
          ...existing,
          [approvalId]: "This approval changed while you were deciding. Showing the latest state.",
        }));
      } else if (cause instanceof ApiError && cause.status === 404) {
        setDecisionErrors((existing) => ({
          ...existing,
          [approvalId]: "This approval is no longer available.",
        }));
      } else {
        setDecisionErrors((existing) => ({
          ...existing,
          [approvalId]: errorMessage(cause),
        }));
      }
    } finally {
      if (
        mountedRef.current &&
        generation === generationRef.current &&
        pendingDecisionRef.current === approvalId
      ) {
        pendingDecisionRef.current = null;
        setPendingDecisionId(null);
        setPendingDecision(null);
      }
    }
  }, [commit, refresh]);

  return {
    approvals,
    loading,
    error,
    pendingDecisionId,
    pendingDecision,
    decisionErrors,
    refresh,
    decide,
  };
}
