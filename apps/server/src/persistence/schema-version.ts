/**
 * The PostgreSQL schema version this build is written against.
 *
 * It lives on its own so the runtime store can assert it without importing the
 * migration runner — the runtime has no business loading admin tooling, and
 * the two used to disagree: the store compared against a hardcoded `1`, so
 * adding a migration made every server refuse to start against the database it
 * had just correctly migrated.
 *
 * Raise this in the same commit that adds `NNN_*.sql` under `migrations/`.
 */
export const LATEST_SCHEMA_VERSION = 5;
