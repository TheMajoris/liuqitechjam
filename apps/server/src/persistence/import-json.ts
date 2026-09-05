import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import type { Database } from "../types.js";
import { verifyAuditChain } from "../audit/audit-hash.js";
import {
  POSTGRES_ADVISORY_LOCK_KEY,
  POSTGRES_SCHEMA,
  seedDatabaseSnapshot,
} from "./postgres-store.js";
import { normalizeDatabase } from "../store.js";

export interface ImportJsonOptions {
  /** Schema-owner connection used by the explicit offline import operation. */
  adminUrl?: string;
  /** Alias accepted for callers that already expose one database URL. */
  databaseUrl?: string;
  sourcePath: string;
}

const IMPORT_TABLES = [
  "app_metadata",
  "agents",
  "projects",
  "agent_conversations",
  "runs",
  "messages",
  "orchestrations",
  "orchestration_turns",
  "orchestration_events",
  "orchestration_continuation_prompts",
  "previews",
  "roles",
  "project_agents",
  "project_leases",
  "approval_requests",
  "capability_grants",
  "permit_approval_correlations",
  "installed_skills",
  "audit_events",
] as const;

function sourceRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Imported JSON database must be an object");
  }
  return value as Record<string, unknown>;
}

function assertNoSilentDiscard(source: unknown, normalized: unknown, location = "database"): void {
  if (Array.isArray(source)) {
    if (!Array.isArray(normalized) || normalized.length !== source.length) {
      throw new Error(`Imported ${location} was changed during normalization`);
    }
    source.forEach((value, index) => assertNoSilentDiscard(value, normalized[index], `${location}[${index}]`));
    return;
  }
  if (typeof source !== "object" || source === null) return;
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
    throw new Error(`Imported ${location} was changed during normalization`);
  }
  const normalizedRecord = normalized as Record<string, unknown>;
  for (const key of Object.keys(source as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(normalizedRecord, key)) {
      throw new Error(`Imported ${location}.${key} would be discarded during normalization`);
    }
    assertNoSilentDiscard(
      (source as Record<string, unknown>)[key],
      normalizedRecord[key],
      `${location}.${key}`,
    );
  }
}

function validateAuditChain(database: Database): void {
  for (const [index, value] of database.auditEvents.entries()) {
    const event = sourceRecord(value);
    const hasPreviousHash = Object.prototype.hasOwnProperty.call(event, "prevHash");
    const hasHash = Object.prototype.hasOwnProperty.call(event, "hash");
    if (hasPreviousHash !== hasHash) {
      throw new Error(`Imported audit event at index ${index} has an incomplete hash pair`);
    }
  }

  const verification = verifyAuditChain(
    database.auditEvents,
    database.auditChainAnchor?.hash,
  );
  if (!verification.ok) {
    throw new Error(
      `Imported audit chain is invalid at sequence ${verification.brokenAtSequence ?? "unknown"} (${verification.reason ?? "unknown"})`,
    );
  }
}

async function assertTargetEmpty(client: Client): Promise<void> {
  for (const table of IMPORT_TABLES) {
    const result = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${POSTGRES_SCHEMA}.${table}) AS present`,
    );
    if (result.rows[0]?.present) {
      throw new Error("PostgreSQL import target must be empty");
    }
  }
}

function importUrl(options: ImportJsonOptions): string {
  const url = options.adminUrl ?? options.databaseUrl;
  if (!url) throw new Error("DATABASE_ADMIN_URL is required for JSON import");
  return url;
}

/**
 * Import one legacy JSON snapshot into a migrated, empty PostgreSQL schema.
 * The source is read only and the target remains unchanged if validation or
 * any database statement fails.
 */
export async function importJsonToPostgres(options: ImportJsonOptions): Promise<void> {
  if (!options.sourcePath) throw new Error("A JSON source path is required for import");

  const sourceText = await readFile(options.sourcePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to parse JSON source ${options.sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Normalize before opening PostgreSQL. This also fills additive fields in
  // memory while leaving the source bytes untouched.
  const database = normalizeDatabase(parsed);
  assertNoSilentDiscard(parsed, database);
  validateAuditChain(database);

  const client = new Client({ connectionString: importUrl(options), connectionTimeoutMillis: 10_000 });
  let connected = false;
  let transactionStarted = false;
  let lockHeld = false;
  try {
    await client.connect();
    connected = true;

    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
      [POSTGRES_ADVISORY_LOCK_KEY.namespace, POSTGRES_ADVISORY_LOCK_KEY.lock],
    );
    lockHeld = Boolean(lock.rows[0]?.acquired);
    if (!lockHeld) {
      throw new Error("Another LQAM server already owns PostgreSQL persistence");
    }

    await client.query("BEGIN");
    transactionStarted = true;
    await assertTargetEmpty(client);
    await seedDatabaseSnapshot(client, database);
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (connected && lockHeld) {
      await client.query(
        "SELECT pg_advisory_unlock($1::integer, $2::integer)",
        [POSTGRES_ADVISORY_LOCK_KEY.namespace, POSTGRES_ADVISORY_LOCK_KEY.lock],
      ).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  const sourcePath = process.argv[2];
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl || !sourcePath) {
    process.stderr.write("DATABASE_ADMIN_URL and a JSON source path are required\n");
    process.exitCode = 1;
  } else {
    await importJsonToPostgres({ adminUrl, sourcePath }).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
