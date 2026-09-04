import type { AuditEvent, AuditQuery } from "./audit-types.js";

export const MAX_AUDIT_QUERY_LIMIT = 200;

function queryLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return 50;
  return Math.min(value, MAX_AUDIT_QUERY_LIMIT);
}

/** Pure bounded query logic; the store adapter stays out of HTTP concerns. */
export function queryAuditEvents(
  events: readonly AuditEvent[],
  filter: AuditQuery = {},
): AuditEvent[] {
  return events
    .filter((event) =>
      (filter.agentId === undefined || event.agentId === filter.agentId) &&
      (filter.projectId === undefined || event.projectId === filter.projectId) &&
      (filter.runId === undefined || event.runId === filter.runId) &&
      (filter.type === undefined || event.type === filter.type) &&
      (filter.traceId === undefined || event.traceId === filter.traceId) &&
      (filter.category === undefined || event.category === filter.category) &&
      (filter.actorType === undefined || event.actorType === filter.actorType),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, queryLimit(filter.limit))
    .map((event) => structuredClone(event));
}
