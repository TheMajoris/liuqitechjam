import type { QueryResultRow } from "pg";
import { Client } from "pg";
import type { Storage } from "../store.js";
import { emptyDatabase, normalizeDatabase } from "../store.js";
import type { Database } from "../types.js";
import { normalizeAuditEvent } from "../audit/audit-normalize.js";
import type { AuditEvent } from "../audit/audit-types.js";

/** The runtime adapter deliberately has no migration side effects. */
export const POSTGRES_SCHEMA = "launchpad";
export const POSTGRES_RUNTIME_ROLE = "launchpad_runtime";
export const POSTGRES_ADVISORY_LOCK_KEY = { namespace: 19_812, lock: 1_001 } as const;

type JsonRecord = Record<string, unknown>;
type CollectionName = Exclude<keyof Database, "version" | "modelCatalog" | "auditChainAnchor">;

interface Queryable {
  query: Client["query"];
}

interface TableDescriptor {
  collection: CollectionName;
  table: string;
  columns: string;
  keyColumns: readonly string[];
  keyValues(record: JsonRecord): unknown[];
  values(record: JsonRecord, ordinal: number): unknown[];
}

interface MetadataRow extends QueryResultRow {
  database_version: number;
  model_catalog: unknown;
  audit_chain_anchor: unknown;
  record: unknown;
}

interface VersionRow extends QueryResultRow {
  version: number | string | null;
}

interface LockRow extends QueryResultRow {
  acquired: boolean;
}

interface RuntimeCheckRow extends QueryResultRow {
  current_user: string;
  is_superuser: boolean;
  can_create_role: boolean;
  owns_schema: boolean;
  owns_table: boolean;
  owns_audit: boolean;
  schema_create: boolean;
  schema_usage: boolean;
  audit_select: boolean;
  audit_insert: boolean;
  audit_update: boolean;
  audit_delete: boolean;
  audit_truncate: boolean;
  regular_select: boolean;
  regular_insert: boolean;
  regular_update: boolean;
  regular_delete: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown, collection: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${collection} record must be an object`);
  return value;
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Persisted record field ${key} must be a string`);
  return value;
}

function nullableString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Persisted record field ${key} must be a string or null`);
  return value;
}

function requiredNumber(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Persisted record field ${key} must be a finite number`);
  }
  return value;
}

function nullableNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Persisted record field ${key} must be a finite number or null`);
  }
  return value;
}

function valueOr<T>(record: JsonRecord, key: string, fallback: T): T {
  return record[key] === undefined ? fallback : (record[key] as T);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function cloneRecord(record: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(record)) as JsonRecord;
}

function time(record: JsonRecord, key: string): string {
  return requiredString(record, key);
}

const TABLES: readonly TableDescriptor[] = [
  {
    collection: "roles",
    table: "roles",
    columns: "id, name, source, created_at, updated_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "name"), requiredString(record, "source"),
      time(record, "createdAt"), time(record, "updatedAt"), ordinal, record,
    ],
  },
  {
    collection: "agents",
    table: "agents",
    columns: "id, name, status, workspace_path, codex_thread_id, created_at, updated_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "name"), requiredString(record, "status"),
      requiredString(record, "workspacePath"), nullableString(record, "codexThreadId"),
      time(record, "createdAt"), time(record, "updatedAt"), ordinal, record,
    ],
  },
  {
    collection: "projects",
    table: "projects",
    columns: "id, name, status, workspace_path, created_at, updated_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "name"), requiredString(record, "status"),
      requiredString(record, "workspacePath"), time(record, "createdAt"), time(record, "updatedAt"), ordinal, record,
    ],
  },
  {
    collection: "agentConversations",
    table: "agent_conversations",
    columns: "id, agent_id, title, codex_thread_id, created_at, updated_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "agentId"), requiredString(record, "title"),
      nullableString(record, "codexThreadId"), time(record, "createdAt"), time(record, "updatedAt"), ordinal, record,
    ],
  },
  {
    collection: "runs",
    table: "runs",
    columns: "id, agent_id, conversation_id, status, created_at, started_at, completed_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "agentId"), nullableString(record, "conversationId"),
      requiredString(record, "status"), time(record, "createdAt"), nullableString(record, "startedAt"),
      nullableString(record, "completedAt"), ordinal, record,
    ],
  },
  {
    collection: "orchestrations",
    table: "orchestrations",
    columns: "id, project_id, status, current_run_id, created_at, updated_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), nullableString(record, "projectId"), requiredString(record, "status"),
      nullableString(record, "currentRunId"), time(record, "createdAt"), time(record, "updatedAt"), ordinal, record,
    ],
  },
  {
    collection: "messages",
    table: "messages",
    columns: "id, agent_id, run_id, conversation_id, role, origin, created_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "agentId"), requiredString(record, "runId"),
      nullableString(record, "conversationId"), requiredString(record, "role"), valueOr(record, "origin", "direct"),
      time(record, "createdAt"), ordinal, record,
    ],
  },
  {
    collection: "orchestrationTurns",
    table: "orchestration_turns",
    columns: "id, session_id, agent_id, run_id, position, step_index, status, created_at, completed_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "sessionId"), requiredString(record, "agentId"),
      requiredString(record, "runId"), requiredNumber(record, "position"), nullableNumber(record, "stepIndex"),
      requiredString(record, "status"), time(record, "createdAt"), nullableString(record, "completedAt"), ordinal, record,
    ],
  },
  {
    collection: "orchestrationEvents",
    table: "orchestration_events",
    columns: "id, session_id, sequence, type, status, created_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "sessionId"), requiredNumber(record, "sequence"),
      requiredString(record, "type"), requiredString(record, "status"), time(record, "createdAt"), ordinal, record,
    ],
  },
  {
    collection: "orchestrationContinuationPrompts",
    table: "orchestration_continuation_prompts",
    columns: "id, session_id, cycle_index, created_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "sessionId"), requiredNumber(record, "cycleIndex"),
      time(record, "createdAt"), ordinal, record,
    ],
  },
  {
    collection: "previews",
    table: "previews",
    columns: "id, agent_id, project_id, status, host, host_port, container_port, created_at, updated_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), nullableString(record, "agentId"), nullableString(record, "projectId"),
      requiredString(record, "status"), requiredString(record, "host"), nullableNumber(record, "hostPort"),
      nullableNumber(record, "containerPort"), time(record, "createdAt"), time(record, "updatedAt"), ordinal, record,
    ],
  },
  {
    collection: "projectAgents",
    table: "project_agents",
    columns: "project_id, agent_id, codex_thread_id, role, role_id, updated_at, ordinal, record",
    keyColumns: ["project_id", "agent_id"],
    keyValues: (record) => [requiredString(record, "projectId"), requiredString(record, "agentId")],
    values: (record, ordinal) => [
      requiredString(record, "projectId"), requiredString(record, "agentId"), nullableString(record, "codexThreadId"),
      nullableString(record, "role"), nullableString(record, "roleId"), nullableString(record, "updatedAt"), ordinal, record,
    ],
  },
  {
    collection: "projectLeases",
    table: "project_leases",
    columns: "project_id, run_id, agent_id, acquired_at, ordinal, record",
    keyColumns: ["project_id"],
    keyValues: (record) => [requiredString(record, "projectId")],
    values: (record, ordinal) => [
      requiredString(record, "projectId"), requiredString(record, "runId"), requiredString(record, "agentId"),
      time(record, "acquiredAt"), ordinal, record,
    ],
  },
  {
    collection: "approvalRequests",
    table: "approval_requests",
    columns: "id, agent_id, project_id, run_id, tool_id, status, created_at, expires_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "agentId"), nullableString(record, "projectId"),
      nullableString(record, "runId"), requiredString(record, "toolId"), requiredString(record, "status"),
      time(record, "createdAt"), time(record, "expiresAt"), ordinal, record,
    ],
  },
  {
    collection: "capabilityGrants",
    table: "capability_grants",
    columns: "id, agent_id, project_id, tool_id, scope, uses_remaining, expires_at, revoked_at, created_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "agentId"), requiredString(record, "projectId"),
      requiredString(record, "toolId"), requiredString(record, "scope"), nullableNumber(record, "usesRemaining"),
      nullableString(record, "expiresAt"), nullableString(record, "revokedAt"), time(record, "createdAt"), ordinal, record,
    ],
  },
  {
    collection: "permitApprovalCorrelations",
    table: "permit_approval_correlations",
    columns: "permit_request_id, kind, agent_id, project_id, run_id, tool_id, last_known_status, created_at, updated_at, ordinal, record",
    keyColumns: ["permit_request_id", "kind"],
    keyValues: (record) => [requiredString(record, "permitRequestId"), requiredString(record, "kind")],
    values: (record, ordinal) => [
      requiredString(record, "permitRequestId"), requiredString(record, "kind"), requiredString(record, "agentId"),
      nullableString(record, "projectId"), nullableString(record, "runId"), requiredString(record, "toolId"),
      requiredString(record, "lastKnownStatus"), time(record, "createdAt"), time(record, "updatedAt"), ordinal, record,
    ],
  },
  {
    collection: "installedSkills",
    table: "installed_skills",
    columns: "id, name, source, version, installed_at, updated_at, ordinal, record",
    keyColumns: ["id"],
    keyValues: (record) => [requiredString(record, "id")],
    values: (record, ordinal) => [
      requiredString(record, "id"), requiredString(record, "name"), requiredString(record, "source"),
      requiredString(record, "version"), time(record, "installedAt"), time(record, "updatedAt"), ordinal, record,
    ],
  },
];

// The order is child-first for deletes so ordinary runtime roles never need
// TRUNCATE or owner privileges. Inserts run in the reverse dependency order.
const DELETE_TABLES = [
  "orchestration_continuation_prompts", "orchestration_events", "orchestration_turns",
  "permit_approval_correlations", "approval_requests", "capability_grants", "previews",
  "project_leases", "project_agents", "messages", "runs", "agent_conversations",
  "orchestrations", "installed_skills", "roles", "projects", "agents",
] as const;

const INSERT_TABLES = [
  "roles", "agents", "projects", "agent_conversations", "runs", "orchestrations", "messages",
  "orchestration_turns", "orchestration_events", "orchestration_continuation_prompts", "previews",
  "project_agents", "project_leases", "approval_requests", "capability_grants",
  "permit_approval_correlations", "installed_skills",
] as const;

const TABLE_BY_NAME = new Map(TABLES.map((descriptor) => [descriptor.table, descriptor]));

const KNOWN_DATABASE_KEYS = new Set([
  "version", "modelCatalog", "agents", "agentConversations", "messages", "runs", "orchestrations",
  "orchestrationTurns", "orchestrationEvents", "orchestrationContinuationPrompts", "previews", "projects",
  "projectAgents", "projectLeases", "approvalRequests", "capabilityGrants", "auditEvents", "auditChainAnchor",
  "permitApprovalCorrelations", "roles", "installedSkills",
]);

function topLevelExtras(database: Database): JsonRecord {
  const extras: JsonRecord = {};
  for (const [key, value] of Object.entries(database as unknown as JsonRecord)) {
    if (!KNOWN_DATABASE_KEYS.has(key)) extras[key] = value;
  }
  return extras;
}

async function queryRecords(client: Queryable, descriptor: TableDescriptor): Promise<unknown[]> {
  const result = await client.query<{ record: unknown }>(
    `SELECT record FROM ${POSTGRES_SCHEMA}.${descriptor.table} ORDER BY ordinal ASC`,
  );
  return result.rows.map((row) => row.record);
}

async function loadMetadata(client: Queryable): Promise<MetadataRow | null> {
  const result = await client.query<MetadataRow>(
    `SELECT database_version, model_catalog, audit_chain_anchor, record
       FROM ${POSTGRES_SCHEMA}.app_metadata WHERE id = true`,
  );
  return result.rows[0] ?? null;
}

/** Load the relational snapshot while retaining each row's complete JSONB record. */
export async function loadDatabaseSnapshot(client: Queryable): Promise<Database> {
  const metadata = await loadMetadata(client);
  if (!metadata) {
    for (const descriptor of TABLES) {
      const rowCounts = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${POSTGRES_SCHEMA}.${descriptor.table}`,
      );
      if (Number(rowCounts.rows[0]?.count ?? "0") !== 0) {
        throw new Error("PostgreSQL contains data but no launchpad metadata row");
      }
    }
    const auditCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${POSTGRES_SCHEMA}.audit_events`,
    );
    if (Number(auditCount.rows[0]?.count ?? "0") !== 0) {
      throw new Error("PostgreSQL contains data but no launchpad metadata row");
    }
    return normalizeDatabase(emptyDatabase());
  }
  if (Number(metadata.database_version) !== 1) throw new Error("Unsupported PostgreSQL database format");

  const extras = isRecord(metadata.record) ? metadata.record : {};
  const candidate: JsonRecord = {
    ...extras,
    version: 1,
    modelCatalog: metadata.model_catalog ?? null,
    auditChainAnchor: metadata.audit_chain_anchor ?? null,
  };
  for (const descriptor of TABLES) candidate[descriptor.collection] = await queryRecords(client, descriptor);
  const audit = await client.query<{ record: unknown }>(
    `SELECT record FROM ${POSTGRES_SCHEMA}.audit_events ORDER BY ordinal ASC`,
  );
  // Preserve the source JSONB records exactly. The audit adapter derives
  // missing legacy sequence fields only while calculating the next append.
  candidate.auditEvents = audit.rows.map((row) => row.record);
  return normalizeDatabase(candidate);
}

function insertSql(table: string, columns: string): string {
  const count = columns.split(",").length;
  const placeholders = Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ");
  return `INSERT INTO ${POSTGRES_SCHEMA}.${table} (${columns}) VALUES (${placeholders})`;
}

function recordKey(descriptor: TableDescriptor, value: unknown): string {
  return JSON.stringify(descriptor.keyValues(recordOf(value, descriptor.collection)));
}

function upsertSql(descriptor: TableDescriptor): string {
  const columns = descriptor.columns.split(", ");
  const updates = columns
    .filter((column) => !descriptor.keyColumns.includes(column))
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ");
  return `${insertSql(descriptor.table, descriptor.columns)} ON CONFLICT (${descriptor.keyColumns.join(", ")}) DO UPDATE SET ${updates}`;
}

function deleteSql(descriptor: TableDescriptor): string {
  const where = descriptor.keyColumns.map((column, index) => `${column} = $${index + 1}`).join(" AND ");
  return `DELETE FROM ${POSTGRES_SCHEMA}.${descriptor.table} WHERE ${where}`;
}

/**
 * Synchronize only changed rows. This keeps normal Agent/Run traffic cheap and
 * avoids rewriting unrelated JSONB records on every mutation. Child removals
 * happen before parent removals; inserts/upserts follow the dependency order.
 */
async function replaceRegularTables(
  client: Queryable,
  previous: Database,
  database: Database,
): Promise<void> {
  const previousMaps = new Map<string, Map<string, { record: JsonRecord; ordinal: number }>>();
  const nextMaps = new Map<string, Map<string, { record: JsonRecord; ordinal: number }>>();
  for (const descriptor of TABLES) {
    const oldMap = new Map<string, { record: JsonRecord; ordinal: number }>();
    const newMap = new Map<string, { record: JsonRecord; ordinal: number }>();
    for (const [ordinal, value] of (previous[descriptor.collection] as unknown[]).entries()) {
      const record = recordOf(value, descriptor.collection);
      oldMap.set(recordKey(descriptor, record), { record, ordinal });
    }
    for (const [ordinal, value] of (database[descriptor.collection] as unknown[]).entries()) {
      const record = recordOf(value, descriptor.collection);
      const key = recordKey(descriptor, record);
      if (newMap.has(key)) throw new Error(`Duplicate ${descriptor.collection} persistence key`);
      newMap.set(key, { record, ordinal });
    }
    previousMaps.set(descriptor.table, oldMap);
    nextMaps.set(descriptor.table, newMap);
  }

  for (const table of DELETE_TABLES) {
    const descriptor = TABLE_BY_NAME.get(table);
    if (!descriptor) throw new Error(`Missing persistence descriptor for ${table}`);
    const oldMap = previousMaps.get(table)!;
    const newMap = nextMaps.get(table)!;
    for (const [key, old] of oldMap) {
      if (!newMap.has(key)) await client.query(deleteSql(descriptor), descriptor.keyValues(old.record));
    }
  }

  for (const table of INSERT_TABLES) {
    const descriptor = TABLE_BY_NAME.get(table);
    if (!descriptor) throw new Error(`Missing persistence descriptor for ${table}`);
    const oldMap = previousMaps.get(table)!;
    const statement = upsertSql(descriptor);
    for (const [key, next] of nextMaps.get(table)!) {
      const old = oldMap.get(key);
      if (old && old.ordinal === next.ordinal && jsonEqual(old.record, next.record)) continue;
      await client.query(statement, descriptor.values(next.record, next.ordinal));
    }
  }
}

function auditInsertValues(
  record: JsonRecord,
  ordinal: number,
  sequenceOverride?: number,
): unknown[] {
  // Legacy audit records predate trace/category/actor/sequence fields. Derive
  // the relational projection for those rows while retaining the original
  // JSONB record byte-for-byte in the final column.
  const projected = normalizeAuditEvent(record as unknown as AuditEvent, ordinal) as unknown as JsonRecord;
  if (sequenceOverride !== undefined && record.sequence === undefined) {
    projected.sequence = sequenceOverride;
  }
  const principal = projected.principal;
  if (!isRecord(principal)) throw new Error("Audit event principal must be an object");
  const metadata = projected.metadata ?? {};
  if (!isRecord(metadata)) throw new Error("Audit event metadata must be an object");
  return [
    requiredString(projected, "id"), requiredNumber(projected, "sequence"), requiredString(projected, "type"),
    requiredString(projected, "status"), nullableString(projected, "agentId"), nullableString(projected, "projectId"),
    nullableString(projected, "runId"), nullableString(projected, "orchestrationId"),
    requiredString(projected, "actorType"), requiredString(projected, "category"), requiredString(projected, "traceId"),
    requiredString(projected, "spanId"), nullableString(projected, "prevHash"), nullableString(projected, "hash"),
    time(projected, "createdAt"), ordinal, principal, projected.resource ?? null, metadata, record,
  ];
}

const AUDIT_COLUMNS =
  "id, sequence, type, status, agent_id, project_id, run_id, orchestration_id, actor_type, category, trace_id, span_id, prev_hash, hash, created_at, ordinal, principal, resource, metadata, record";

async function appendAuditEvents(
  client: Queryable,
  events: readonly unknown[],
  start: number,
  anchorSequence?: number,
): Promise<void> {
  const statement = insertSql("audit_events", AUDIT_COLUMNS);
  for (let index = start; index < events.length; index += 1) {
    const record = recordOf(events[index], "auditEvents");
    const sequenceOverride = anchorSequence === undefined || record.sequence !== undefined
      ? undefined
      : anchorSequence + index + 1;
    await client.query(statement, auditInsertValues(record, index, sequenceOverride));
  }
}

async function upsertMetadata(
  client: Queryable,
  database: Database,
  options: { allowAuditAnchorWrite: boolean },
): Promise<void> {
  const insertColumns = options.allowAuditAnchorWrite
    ? "id, database_version, model_catalog, audit_chain_anchor, record"
    : "id, database_version, model_catalog, record";
  const insertValues = options.allowAuditAnchorWrite
    ? "VALUES (true, 1, $1, $2, $3)"
    : "VALUES (true, 1, $1, $2)";
  const conflictUpdate = options.allowAuditAnchorWrite
    ? `database_version = EXCLUDED.database_version,
       model_catalog = EXCLUDED.model_catalog,
       audit_chain_anchor = EXCLUDED.audit_chain_anchor,
       record = EXCLUDED.record`
    : `database_version = EXCLUDED.database_version,
       model_catalog = EXCLUDED.model_catalog,
       record = EXCLUDED.record`;
  await client.query(
    `INSERT INTO ${POSTGRES_SCHEMA}.app_metadata
       (${insertColumns})
     ${insertValues}
     ON CONFLICT (id) DO UPDATE SET ${conflictUpdate}`,
    options.allowAuditAnchorWrite
      ? [database.modelCatalog ?? null, database.auditChainAnchor ?? null, topLevelExtras(database)]
      : [database.modelCatalog ?? null, topLevelExtras(database)],
  );
}

/** Seed an empty, already-migrated database in one caller-owned transaction. */
export async function seedDatabaseSnapshot(client: Queryable, database: Database): Promise<void> {
  const normalized = normalizeDatabase(database);
  await replaceRegularTables(client, normalizeDatabase(emptyDatabase()), normalized);
  await appendAuditEvents(client, normalized.auditEvents, 0, normalized.auditChainAnchor?.sequence);
  await upsertMetadata(client, normalized, { allowAuditAnchorWrite: true });
}

function assertAuditAppendOnly(previous: Database, next: Database): void {
  if (!jsonEqual(previous.auditChainAnchor ?? null, next.auditChainAnchor ?? null)) {
    throw new Error("PostgreSQL auditChainAnchor is immutable at runtime");
  }
  if (next.auditEvents.length < previous.auditEvents.length) {
    throw new Error("PostgreSQL audit_events is append-only; events cannot be removed");
  }
  for (let index = 0; index < previous.auditEvents.length; index += 1) {
    if (!jsonEqual(previous.auditEvents[index], next.auditEvents[index])) {
      throw new Error("PostgreSQL audit_events is append-only; existing events cannot be changed or reordered");
    }
  }
}

async function persistDatabase(client: Queryable, previous: Database, next: Database): Promise<void> {
  const normalized = normalizeDatabase(next);
  assertAuditAppendOnly(previous, normalized);
  await replaceRegularTables(client, previous, normalized);
  await appendAuditEvents(client, normalized.auditEvents, previous.auditEvents.length);
  await upsertMetadata(client, normalized, { allowAuditAnchorWrite: false });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * PostgreSQL-backed implementation of the existing synchronous-snapshot
 * contract. It deliberately uses one connection so the advisory lock and all
 * transactions belong to the same backend session.
 */
export class PostgresStore implements Storage {
  readonly auditRetention = "append-only" as const;
  private client: Client | null = null;
  private data: Database | null = null;
  private fatalError: Error | null = null;
  private closed = false;
  private initialization: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly databaseUrl: string) {}

  async initialize(): Promise<void> {
    if (this.data) return;
    if (this.fatalError) throw this.fatalError;
    if (this.closed) throw new Error("PostgresStore is closed");
    if (!this.initialization) {
      this.initialization = this.start().catch((error) => {
        this.failClosed(error);
        throw asError(error);
      });
    }
    await this.initialization;
  }

  snapshot(): Database {
    this.requireReady();
    return structuredClone(this.data!);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    this.requireReady();
    let result!: T;
    const operation = this.queue.then(async () => {
      this.requireReady();
      const client = this.client!;
      try {
        await client.query("BEGIN");
      } catch (error) {
        this.failClosed(error);
        throw error;
      }
      const next = structuredClone(this.data!);
      try {
        result = await mutation(next);
        await persistDatabase(client, this.data!, next);
      } catch (error) {
        const rollbackSucceeded = await client.query("ROLLBACK").then(() => true).catch(() => false);
        if (!rollbackSucceeded) this.failClosed(error);
        throw error;
      }
      try {
        await client.query("COMMIT");
      } catch (error) {
        // A failed COMMIT is ambiguous: PostgreSQL may have committed even
        // though the client did not receive the acknowledgement.
        this.failClosed(error);
        throw error;
      }
      try {
        // Publishing after COMMIT is the key invariant: readers never observe
        // a snapshot that PostgreSQL rolled back.
        this.data = normalizeDatabase(next);
      } catch (error) {
        this.failClosed(error);
        throw error;
      }
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.initialization?.catch(() => undefined);
    await this.queue.catch(() => undefined);
    const client = this.client;
    this.client = null;
    this.data = null;
    if (!client) return;
    await client.query(
      "SELECT pg_advisory_unlock($1::integer, $2::integer)",
      [POSTGRES_ADVISORY_LOCK_KEY.namespace, POSTGRES_ADVISORY_LOCK_KEY.lock],
    ).catch(() => undefined);
    await client.end().catch(() => undefined);
  }

  private requireReady(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.closed) throw new Error("PostgresStore is closed");
    if (!this.client || !this.data) throw new Error("PostgresStore has not been initialized");
  }

  private failClosed(error: unknown): void {
    if (this.fatalError) return;
    this.fatalError = asError(error);
    const client = this.client;
    this.client = null;
    this.data = null;
    void client?.end().catch(() => undefined);
  }

  private async start(): Promise<void> {
    const client = new Client({ connectionString: this.databaseUrl, connectionTimeoutMillis: 10_000 });
    client.on("error", (error) => {
      if (!this.closed && this.client === client) this.failClosed(error);
    });
    client.on("end", () => {
      if (!this.closed && this.client === client) this.failClosed(new Error("PostgreSQL connection ended unexpectedly"));
    });
    try {
      await client.connect();
      const lock = await client.query<LockRow>(
        "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
        [POSTGRES_ADVISORY_LOCK_KEY.namespace, POSTGRES_ADVISORY_LOCK_KEY.lock],
      );
      if (!lock.rows[0]?.acquired) {
        throw new Error("Another Launchpad server already owns PostgreSQL persistence");
      }
      await this.verifyRuntimeRole(client);
      const version = await client.query<VersionRow>(
        `SELECT max(version) AS version FROM ${POSTGRES_SCHEMA}.schema_migrations`,
      );
      if (Number(version.rows[0]?.version ?? 0) !== 1) {
        throw new Error("PostgreSQL schema is not migrated; run the migration command with DATABASE_ADMIN_URL");
      }
      this.client = client;
      const loaded = await loadDatabaseSnapshot(client);
      if (this.closed) throw new Error("PostgresStore is closed");
      if (this.fatalError) throw this.fatalError;
      this.data = loaded;
    } catch (error) {
      await client.query(
        "SELECT pg_advisory_unlock($1::integer, $2::integer)",
        [POSTGRES_ADVISORY_LOCK_KEY.namespace, POSTGRES_ADVISORY_LOCK_KEY.lock],
      ).catch(() => undefined);
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  private async verifyRuntimeRole(client: Client): Promise<void> {
    const result = await client.query<RuntimeCheckRow>(
      `SELECT
         current_user,
         (current_setting('is_superuser') = 'on') AS is_superuser,
         EXISTS (
           SELECT 1
           FROM pg_roles r
           WHERE r.rolname = current_user
             AND r.rolcreaterole
         ) OR EXISTS (
           SELECT 1
           FROM pg_auth_members membership
           JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
           WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
             AND granted_role.rolcreaterole
             AND pg_has_role(current_user, granted_role.rolname, 'member')
         ) AS can_create_role,
         EXISTS (
           SELECT 1 FROM pg_namespace n
           JOIN pg_roles owner_role ON owner_role.oid = n.nspowner
           WHERE n.nspname = $1
             AND (owner_role.rolname = current_user OR pg_has_role(current_user, owner_role.rolname, 'member'))
         ) AS owns_schema,
         EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_roles owner_role ON owner_role.oid = c.relowner
           WHERE n.nspname = $1
             AND c.relkind IN ('r', 'p')
             AND (owner_role.rolname = current_user OR pg_has_role(current_user, owner_role.rolname, 'member'))
         ) AS owns_table,
         EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_roles owner_role ON owner_role.oid = c.relowner
           WHERE n.nspname = $1 AND c.relname = 'audit_events'
             AND (owner_role.rolname = current_user OR pg_has_role(current_user, owner_role.rolname, 'member'))
         ) AS owns_audit,
         has_schema_privilege(current_user, $1, 'USAGE') AS schema_usage,
         has_schema_privilege(current_user, $1, 'CREATE') AS schema_create,
         has_table_privilege(current_user, $2, 'SELECT') AS audit_select,
         has_table_privilege(current_user, $2, 'INSERT') AS audit_insert,
         has_table_privilege(current_user, $2, 'UPDATE') AS audit_update,
         has_table_privilege(current_user, $2, 'DELETE') AS audit_delete,
         has_table_privilege(current_user, $2, 'TRUNCATE') AS audit_truncate,
         has_table_privilege(current_user, $3, 'SELECT') AS regular_select,
         has_table_privilege(current_user, $3, 'INSERT') AS regular_insert,
         has_table_privilege(current_user, $3, 'UPDATE') AS regular_update,
         has_table_privilege(current_user, $3, 'DELETE') AS regular_delete`,
      [POSTGRES_SCHEMA, `${POSTGRES_SCHEMA}.audit_events`, `${POSTGRES_SCHEMA}.agents`],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Unable to inspect PostgreSQL runtime privileges");
    if (
      row.is_superuser ||
      row.can_create_role ||
      row.owns_schema ||
      row.owns_table ||
      row.owns_audit ||
      row.schema_create
    ) {
      throw new Error("PostgresStore requires a non-owner, non-superuser runtime role");
    }
    if (!row.schema_usage || !row.audit_select || !row.audit_insert || row.audit_update || row.audit_delete || row.audit_truncate) {
      throw new Error("PostgreSQL runtime role must have audit SELECT/INSERT only");
    }
    if (!row.regular_select || !row.regular_insert || !row.regular_update || !row.regular_delete) {
      throw new Error("PostgreSQL runtime role lacks required regular table privileges");
    }
  }
}

export { persistDatabase };
