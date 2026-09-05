// Owner-only, explicit setup step. The API never loads this script.
import pg from "pg";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.DATABASE_RUNTIME_PASSWORD;
if (!adminUrl || !password || password.length < 16) {
  throw new Error("Set DATABASE_ADMIN_URL and DATABASE_RUNTIME_PASSWORD (at least 16 characters)");
}
const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  await client.query("BEGIN");
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'launchpad_app'");
  if (existing.rowCount === 0) {
    await client.query("CREATE ROLE launchpad_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  }
  // Let PostgreSQL quote the password; never interpolate an unescaped secret.
  const quoted = await client.query("SELECT quote_literal($1::text) AS password", [password]);
  await client.query("ALTER ROLE launchpad_app PASSWORD " + quoted.rows[0].password);
  await client.query("GRANT launchpad_runtime TO launchpad_app");
  await client.query("COMMIT");
  console.log("Provisioned the LQAM runtime login; owner credentials are only for migrations/import.");
} catch {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error("PostgreSQL runtime-role provisioning failed. Check owner access and run migrations first.");
  process.exitCode = 1;
} finally {
  await client.end();
}
