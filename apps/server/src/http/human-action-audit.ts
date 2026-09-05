import type { AuditEvent, AuditEventInput } from "../audit/audit-types.js";

/** Minimal logger seam so callers can pass Fastify's request.log or console. */
export interface HumanActionAuditLogger {
  warn(obj: unknown, msg?: string): void;
}

/** The route layer only needs to append events; readers stay untouched. */
export interface HumanActionAuditWriter {
  record(input: AuditEventInput): Promise<AuditEvent>;
}

/**
 * Records a human-intent audit event from the HTTP route layer.
 *
 * This is deliberately called from routes (not services) so that
 * Agent-initiated calls into the same services are never mislabelled as
 * human actions. A write failure never fails the request it accompanies.
 */
export async function recordHumanAction(
  audit: Partial<HumanActionAuditWriter> | undefined,
  input: AuditEventInput,
  log?: HumanActionAuditLogger,
): Promise<void> {
  if (!audit?.record) return;
  try {
    await audit.record(input);
  } catch (error) {
    log?.warn({ error }, "Failed to record human action audit event");
  }
}
