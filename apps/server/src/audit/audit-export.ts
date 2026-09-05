import type { AuditEvent } from "./audit-types.js";

export const AUDIT_EXPORT_FORMATS = ["jsonl", "csv"] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

export const AUDIT_CSV_COLUMNS = [
  "sequence",
  "id",
  "createdAt",
  "traceId",
  "spanId",
  "parentSpanId",
  "category",
  "type",
  "status",
  "actorType",
  "principalKind",
  "principalId",
  "agentId",
  "projectId",
  "runId",
  "orchestrationId",
  "durationMs",
  "summary",
  "metadata",
] as const;

/**
 * A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
 * Prefixing a single quote keeps the value literal without losing characters.
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function csvField(value: unknown): string {
  const raw = value === undefined || value === null ? "" : String(value);
  return '"' + neutralizeFormula(raw).replace(/"/g, '""') + '"';
}

function csvRow(event: AuditEvent): string {
  const cells: Record<(typeof AUDIT_CSV_COLUMNS)[number], unknown> = {
    sequence: event.sequence,
    id: event.id,
    createdAt: event.createdAt,
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    category: event.category,
    type: event.type,
    status: event.status,
    actorType: event.actorType,
    principalKind: event.principal.kind,
    principalId: event.principal.id,
    agentId: event.agentId,
    projectId: event.projectId,
    runId: event.runId,
    orchestrationId: event.orchestrationId,
    durationMs: event.durationMs,
    summary: event.summary,
    metadata: JSON.stringify(event.metadata ?? {}),
  };
  return AUDIT_CSV_COLUMNS.map((column) => csvField(cells[column])).join(",");
}

/** Serialize already-filtered, already-redacted events. No new fields. */
export function exportAuditEvents(
  events: readonly AuditEvent[],
  format: AuditExportFormat,
): string {
  if (format === "jsonl") {
    return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
  }
  const header = AUDIT_CSV_COLUMNS.map((column) => csvField(column)).join(",");
  return [header, ...events.map(csvRow)].join("\n") + "\n";
}

export function auditExportContentType(format: AuditExportFormat): string {
  return format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8";
}

/** Stable, sortable attachment name: audit-yyyymmdd-hhmmss.<ext>. */
export function auditExportFilename(format: AuditExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `audit-${stamp}.${format}`;
}
