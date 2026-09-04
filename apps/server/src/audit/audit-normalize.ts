import { AUDIT_EVENT_CATEGORY, type AuditEvent } from "./audit-types.js";

/**
 * Legacy persisted events predate trace identity, actor type, and category.
 * Back-fill deterministic values on read so every event satisfies the
 * current shape without a store migration.
 */
export function normalizeAuditEvent(event: AuditEvent, index: number): AuditEvent {
  if (
    event.traceId !== undefined &&
    event.spanId !== undefined &&
    event.sequence !== undefined &&
    event.actorType !== undefined &&
    event.category !== undefined
  ) {
    return event;
  }
  return {
    ...event,
    traceId: event.traceId ?? event.orchestrationId ?? event.runId ?? event.id,
    spanId: event.spanId ?? event.id.replace(/-/g, "").slice(0, 16),
    sequence: event.sequence ?? index + 1,
    actorType: event.actorType ?? event.principal.kind,
    category: event.category ?? AUDIT_EVENT_CATEGORY[event.type],
  };
}
