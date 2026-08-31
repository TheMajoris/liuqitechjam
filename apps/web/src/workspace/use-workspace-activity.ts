import { useEffect, useState } from "react";
import { api } from "../api";
import type { AuditEventRecord } from "../types";

/** Fast enough that a tool trip is visible; slow enough to stay cheap. */
const POLL_MS = 4000;

/**
 * The safe audit projection the room uses to see what a tool is doing.
 *
 * Read-only and best-effort: a failure leaves the last events in place and the
 * characters simply stay where they are, because the audit journal is evidence
 * about work that already happened, never a control input. Polling stops when
 * nothing is running, so an idle office costs no requests.
 */
export function useWorkspaceActivity(
  projectId: string | null,
  active: boolean,
): AuditEventRecord[] {
  const [events, setEvents] = useState<AuditEventRecord[]>([]);

  useEffect(() => {
    if (!projectId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      void api
        .projectActivity(projectId)
        .then((result) => {
          if (!cancelled) setEvents(result.events);
        })
        .catch(() => undefined);
    };
    load();
    if (!active) return () => {
      cancelled = true;
    };
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, active]);

  return events;
}
