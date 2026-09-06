# LQAM PostgreSQL persistence and audit evidence

Liu Qi Agent Management (LQAM) supports **one active Fastify backend**, with the existing
concurrent Agents and Runs. PostgreSQL is the production durable store.
`JsonStore` remains an explicit legacy/local adapter. Redis, BullMQ, Temporal,
distributed execution, and new observability platforms are not installed.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| PostgreSQL / `PostgresStore` | Durable platform records and atomic mutations |
| `JsonStore` | Existing local `APP_DATA_DIR/launchpad.json` format |
| `AuditService` | Agent/security semantics, redaction, correlation, investigation |
| `AuditStoreAdapter` | Audit read/append abstraction |
| PostgreSQL `audit_events` | Authoritative append-only audit evidence |
| OpenTelemetry | Existing operational traces and telemetry; not audit storage |
| Audit UI/API | Timeline, trace investigation, chain verification, evidence export |
| Workspace filesystem | Actual Agent/Project files |
| Git | Workspace checkpoints and history |
| Codex persistent sessions | Existing runtime/session continuity |
| Mastra | Existing orchestration |
| Temporal / Redis | Possible future workflow execution / distributed coordination |

Services continue to use `initialize`, synchronous `snapshot`, and serialized
`mutate` through `Storage`. PostgreSQL commits a mutation in one transaction and
publishes its in-memory snapshot only after commit. SQL remains in the persistence
adapter. This preserves the existing service and authorization boundaries.

A dedicated PostgreSQL connection holds an advisory lock for the active store.
A second backend or an offline import cannot acquire ownership while it is held.
The normal backend must use a direct/session connection, not a transaction-pooling
proxy. Connection loss makes the store fail closed; restart the server after
restoring PostgreSQL. There is no automatic JSON fallback.

The current synchronous reader contract means the backend retains platform state,
including audit events, in memory. It is suitable for this presentation scope,
not a claim of unlimited audit-volume scalability. A future paginated database
reader can replace that contract without changing the audit UI's semantics.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PERSISTENCE_BACKEND` | `postgres` or explicit legacy `json` |
| `DATABASE_URL` | Restricted application runtime login |
| `DATABASE_ADMIN_URL` | Schema owner connection, migration/import tools only |
| `DATABASE_RUNTIME_PASSWORD` | Password for explicit `db:provision` setup |
| `POSTGRES_PASSWORD` | Local/Compose PostgreSQL owner password |
| `POSTGRES_PORT` | Host port for local PostgreSQL; default 5432 |
| `APP_DATA_DIR` | Legacy JSON and local infrastructure credential location |

Development and production runtime configuration defaults to PostgreSQL and
requires a valid `DATABASE_URL`. Test processes may use the JSON default
internally for isolated unit tests; that does not change the user-facing
default. `.env.example` sets `PERSISTENCE_BACKEND=postgres`. Set
`PERSISTENCE_BACKEND=json` only for an explicit legacy/recovery run. Never use
the schema owner as the API login.
URL-encode passwords in connection URLs. Use your deployment's secret manager
and TLS configuration for a remote database.

## Local POC

Node.js 22+ remains supported. Install dependencies, set the existing Ark model
configuration, and run the PostgreSQL POC:

```bash
npm run poc
```

When `DATABASE_URL` is absent, the LQAM POC launcher starts PostgreSQL 17 using the
same Docker/Podman engine as the existing runtime. It creates a persistent named
volume, generates separate owner/runtime passwords in a mode-0600
`APP_DATA_DIR/local-postgres.env`, waits for database health, applies versioned
migrations, and provisions the runtime login. It removes owner credentials from
the environment before starting the API. Do not delete that credential file
while retaining its database volume.

If `DATABASE_URL` is supplied, the database is externally managed: provision it
and run migrations yourself before starting the POC. The launcher does not run
owner operations against that database.

If an existing `launchpad.json` is present while the launcher-managed local
PostgreSQL database is empty, `npm run poc` imports it transactionally before
starting the API and leaves the source file untouched. On later runs, the
launcher detects the populated database and skips the import. If
`DATABASE_URL` was supplied by the operator, the database is external and the
launcher never auto-imports into it; use the offline import instructions below
explicitly instead. The launcher never switches to JSON implicitly. Use
`PERSISTENCE_BACKEND=json` explicitly for a legacy/recovery run.

Ctrl-C stops the API and the existing disposable Agent runtimes. PostgreSQL and
its data volume remain, like the existing local search service. The launcher
prints the exact container name and stop command. Stop it without deleting data:

```bash
docker stop YOUR_POSTGRES_CONTAINER
```

## Managed database or Docker Compose

Use a dedicated database for this application. First set a private owner password
in your environment and start only PostgreSQL:

```bash
docker compose --profile postgres up -d postgres
```

Set `POSTGRES_PASSWORD`, `DATABASE_ADMIN_URL` to the owner connection on
`127.0.0.1:5432/launchpad`, and a distinct `DATABASE_RUNTIME_PASSWORD` of at
least 16 characters. Run the following in order:

```bash
npm run db:migrate
npm run db:provision
```

`db:provision` creates/updates the `launchpad_app` login and grants it the
`launchpad_runtime` role. Migrations own schema management; server startup never
creates tables. The owner must have permission to create the group role during
initial provisioning, or your DBA must arrange that role beforehand.

For the containerized API, set `PERSISTENCE_BACKEND=postgres` and `DATABASE_URL`
using the runtime login, **host `postgres`** and port 5432, then start the API
stack using its normal auth/model settings:

```bash
docker compose --profile postgres up -d --build
```

The host-run migration/provision commands use `127.0.0.1`; the API container
must use the service hostname `postgres`. Keep the same runtime password in the
URL and URL-encode it if you replace the generated hexadecimal value.

For the host-run API, the URL uses `127.0.0.1` instead. Compose blanks owner and
bootstrap secrets in the API container. Keep database volumes when stopping the
stack; `docker compose down -v` is destructive and is not a normal shutdown step.

## Offline JSON import

1. Stop the backend and ensure its Agent runtimes are stopped. Back up the JSON,
   workspaces, Git repositories, and Codex session directory together.
2. Create a dedicated empty PostgreSQL database; run migrations and provisioning.
3. Set `DATABASE_ADMIN_URL` for the import tool and run:

   ```bash
   npm run db:import -- /absolute/path/to/launchpad.json
   ```

4. Start with `PERSISTENCE_BACKEND=postgres` and the restricted `DATABASE_URL`.
   Keep the original workspace and Codex directory paths.

Import preserves IDs, timestamps, record relationships, record content, audit
ordering/hashes, and a legacy trimmed-chain anchor. The source file is only read;
it is never rewritten. Unsupported or inconsistent input fails clearly, and
the database transaction prevents partial imports. Import refuses a populated
target and cannot run against a store owned by a live backend. There is no
automatic merge, overwrite, rehash, or destructive cleanup of the source.

Existing unhashed legacy evidence remains legacy evidence; import does not invent
hash guarantees for those rows. `GET /api/audit/verify` reports how many hashed
records it checked. Review both `ok` and `checked` when demonstrating verification.

Rollback to `PERSISTENCE_BACKEND=json` uses the original JSON snapshot, which
**does not include writes made after switching to PostgreSQL**. Do not operate
the two backends against the same workspaces simultaneously. Restore coordinated
backups for a full rollback; there is no automatic reverse migration.

## Audit security model

Normal audit writes still follow:

```text
Security action → AuditService → AuditStoreAdapter → Storage → audit_events
```

Redaction happens before hashing/persistence. The adapter assigns a sequence and
computes the existing deterministic SHA-256 chain in the same serialized mutation
as the append. PostgreSQL has no normal runtime ring-buffer trimming.

| Role | Audit SELECT | INSERT | UPDATE / DELETE / TRUNCATE | Schema management |
| --- | --- | --- | --- | --- |
| `launchpad_runtime` / application login | Yes | Yes | No | No |
| Migration owner | Administrative access | Yes | Defense-in-depth triggers reject ordinary destructive statements | Yes |

The runtime must not own audit tables or inherit an owner/superuser role. Startup
checks the effective privileges and rejects an unsafe runtime connection. Database
triggers additionally reject audit modification/deletion/truncation. The adapter
also rejects changing or removing existing audit records. These are complementary
controls: privileges prevent ordinary runtime modification, hashes expose changes
to the recorded chain. A database administrator can still change schema/disable
triggers; this is not a claim of immunity to a compromised DBA.

Historical evidence references do not cascade away when a resource is deleted.
Any future archival/retention process must be separately privileged and preserve
verification anchors; it is not implemented here. A local hash chain alone cannot
detect a privileged rewrite of the entire chain or deletion of its tail without
an independently trusted head. External anchoring is future work.

The existing audit failure policy remains: `AuditService` reports/rethrows a failed
append, while some existing callers deliberately treat audit recording as best
effort. PostgreSQL failures are never acknowledged as successful audit writes;
this migration does not add a cross-service transaction/outbox or change which
actions are blocked by unavailable audit storage.

The existing audit API/UI remains the investigation surface: `/api/audit`,
`/api/audit/timeline`, `/api/audit/traces`, `/api/audit/traces/:traceId`,
`/api/audit/verify`, and `/api/audit/export`. Trace/span IDs correlate evidence with
OpenTelemetry, while Agent/Project/Run IDs retain application context. No event
details are invented and no audit records are converted to ordinary OTel logs.

## Pametan assessment: KEEP CUSTOM AUDIT

Evaluated against the upstream source during this migration:

| Area | Finding |
| --- | --- |
| Runtime/module compatibility | ESM and bundled TypeScript declarations fit. Node 24 is allowed by the challenge; the package requires it, while the current project baseline is Node >=22. Upgrading is possible, but does not resolve the integration costs below. |
| Adapter fit | Our reader is synchronous and exposes the existing flat `AuditEvent`; Pametan uses async sink reads and a different nested `AuditRecord`. |
| PostgreSQL sink | Takes a supplied queryable client, but `ensureSchema()` creates its own table at runtime. It does not supply this project's role/privilege migrations. |
| Hashes/verification | Different canonical hash input and zero-based sequencing; existing evidence/anchors are not directly interchangeable. |
| Concurrent appends | Serializes within one log instance. The sink's primary key rejects duplicate sequence values; it does not provide a distributed retry/ownership protocol. |
| Redaction | Generic PII handling of `event.data` does not replace our identifier, summary, correlation, sandbox, and runtime metadata rules. |
| Code reduction | Hashing and append code could theoretically be delegated, but compatibility mapping and migration would outweigh the removed code. No files can safely be removed wholesale. |
| Decision | Keep the tested custom chain/redaction/verification and add PostgreSQL storage behind existing boundaries. |

Sources: [package manifest](https://github.com/pametan/audit-log/blob/main/package.json),
[event types](https://github.com/pametan/audit-log/blob/main/src/types.ts),
[PostgreSQL sink](https://github.com/pametan/audit-log/blob/main/src/postgres.ts),
[sequencing and verification](https://github.com/pametan/audit-log/blob/main/src/log.ts),
[hash input](https://github.com/pametan/audit-log/blob/main/src/hash.ts),
[redaction](https://github.com/pametan/audit-log/blob/main/src/redact.ts).

Agent-specific audit categories, authorization outcomes, approvals, normalization,
runtime/sandbox observations, trace trees, timeline queries, and export stay in
their existing modules. The database migration does not require UI changes.

## Validation

The PostgreSQL integration file contains six focused tests and needs a disposable
PostgreSQL database. It skips when its database environment is not configured;
skipped database tests are not proof of persistence or role enforcement. See the
test file's environment setup before running it. Existing Agent/Project/audit/UI
tests remain part of `npm run check`.

Run focused integration checks during development, followed by `npm run check`
once the implementation is stable. Do not point integration tests at a POC or
production database.
