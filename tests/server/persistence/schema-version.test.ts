import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION } from "../../../apps/server/src/persistence/schema-version.js";

/**
 * The database-backed persistence suite is opt-in and skips without a test
 * database, so nothing in the default run notices when the migration manifest
 * and the version the server asserts drift apart. That drift is not a subtle
 * bug: the server refuses to start against the database it just migrated
 * correctly. These checks need no database.
 */
const migrationsUrl = new URL(
  "../../../apps/server/src/persistence/migrations/",
  import.meta.url,
);

async function migrationVersions(): Promise<number[]> {
  const names = await readdir(migrationsUrl);
  return names
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
    .map((name) => Number(name.slice(0, name.indexOf("_"))))
    .sort((left, right) => left - right);
}

describe("PostgreSQL schema version", () => {
  it("matches the highest migration on disk", async () => {
    const versions = await migrationVersions();
    expect(versions.at(-1)).toBe(LATEST_SCHEMA_VERSION);
  });

  it("numbers migrations consecutively from 1", async () => {
    const versions = await migrationVersions();
    expect(versions).toEqual(
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
    );
  });

  it("is asserted by the runtime store rather than hardcoded there", async () => {
    // The store used to compare the applied version against a literal `1`, so
    // adding a migration broke startup for everyone who applied it. It must
    // read the constant instead.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../../apps/server/src/persistence/postgres-store.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(source).toContain("LATEST_SCHEMA_VERSION");
    expect(source).not.toMatch(/version\.rows\[0\]\?\.version \?\? 0\) !== \d/u);
  });

  it("provisions the Mastra approval schema for the runtime role", async () => {
    const migration = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../../apps/server/src/persistence/migrations/005_mastra_approval_schema.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(migration).toContain("CREATE SCHEMA IF NOT EXISTS mastra_approval");
    expect(migration).toContain(
      "GRANT USAGE, CREATE ON SCHEMA mastra_approval TO launchpad_runtime",
    );
  });
});
