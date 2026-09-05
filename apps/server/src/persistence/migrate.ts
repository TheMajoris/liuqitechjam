import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const LATEST_SCHEMA_VERSION = 1;

export interface MigrationOptions {
  /** Administrator/owner URL. Never use the runtime application URL here. */
  adminUrl: string;
}

interface MigrationFile {
  version: number;
  name: string;
  url: URL;
}

async function migrationFiles(): Promise<MigrationFile[]> {
  const directory = new URL("./migrations/", import.meta.url);
  const names = await readdir(directory);
  const files = names
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
    .map((name) => ({
      version: Number(name.slice(0, name.indexOf("_"))),
      name,
      url: new URL(name, directory),
    }))
    .sort((left, right) => left.version - right.version);
  if (files.length === 0) throw new Error("No PostgreSQL migrations were found");
  if (files[files.length - 1]!.version !== LATEST_SCHEMA_VERSION) {
    throw new Error("PostgreSQL migration manifest is out of date");
  }
  return files;
}

/** Run versioned SQL as an explicit administrator operation. */
export async function runMigrations(options: MigrationOptions): Promise<void> {
  if (!options.adminUrl) throw new Error("DATABASE_ADMIN_URL is required for migrations");
  const files = await migrationFiles();
  const client = new Client({ connectionString: options.adminUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA IF NOT EXISTS launchpad");
    await client.query(`
      CREATE TABLE IF NOT EXISTS launchpad.schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const result = await client.query<{ version: number }>(
      "SELECT version FROM launchpad.schema_migrations ORDER BY version",
    );
    const applied = new Set(result.rows.map((row) => Number(row.version)));
    for (const file of files) {
      if (applied.has(file.version)) continue;
      const sql = await readFile(file.url, "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO launchpad.schema_migrations (version) VALUES ($1)",
        [file.version],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    process.stderr.write("DATABASE_ADMIN_URL is required\n");
    process.exitCode = 1;
  } else {
    await runMigrations({ adminUrl }).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
