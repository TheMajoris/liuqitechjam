#!/usr/bin/env bash
# Sourced by start-local-poc.sh after its state directories and engine exist.
# Credentials and database volume survive server shutdown; no data is removed.
start_local_postgres() {
  # These flags are deliberately explicit so the caller can distinguish the
  # launcher-managed database from an externally supplied DATABASE_URL. The
  # latter must never receive an automatic legacy-data import.
  export LQAM_LOCAL_POSTGRES_MANAGED=0
  export LQAM_LOCAL_POSTGRES_EMPTY=0
  export PERSISTENCE_BACKEND="${PERSISTENCE_BACKEND:-postgres}"
  [[ "$PERSISTENCE_BACKEND" == "postgres" ]] || return 0
  if [[ -n "${DATABASE_URL:-}" ]]; then
    log "Using configured PostgreSQL; run npm run db:migrate separately before startup."
    return 0
  fi

  local credentials_file="$APP_DATA_DIR/local-postgres.env"
  local pg_container="${POSTGRES_CONTAINER_NAME:-launchpad-postgres-$RUNTIME_INSTANCE_ID}"
  local pg_volume="${POSTGRES_VOLUME_NAME:-$pg_container-data}"
  local pg_port="${POSTGRES_PORT:-5432}"
  if [[ ! -f "$credentials_file" ]]; then
    if "$engine" container inspect "$pg_container" >/dev/null 2>&1 \
      || "$engine" volume inspect "$pg_volume" >/dev/null 2>&1; then
      log "PostgreSQL state exists but $credentials_file is missing; restore its credentials or configure DATABASE_URL."
      return 1
    fi
    (umask 077; node --input-type=module - "$credentials_file" "$pg_port" <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const owner = randomBytes(24).toString('hex');
const runtime = randomBytes(24).toString('hex');
const port = Number(process.argv[3]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid POSTGRES_PORT');
writeFileSync(process.argv[2], [
  'POSTGRES_PASSWORD=' + owner,
  'DATABASE_RUNTIME_PASSWORD=' + runtime,
  'POSTGRES_PORT=' + port,
  `DATABASE_ADMIN_URL=postgresql://launchpad_owner:${owner}@127.0.0.1:${port}/launchpad`,
  `DATABASE_URL=postgresql://launchpad_app:${runtime}@127.0.0.1:${port}/launchpad`,
  '',
].join('\n'), { mode: 0o600, flag: 'wx' });
NODE
    )
  fi
  chmod 600 "$credentials_file"
  set -a
  # shellcheck disable=SC1090
  source "$credentials_file"
  set +a
  pg_port="${POSTGRES_PORT:-$pg_port}"
  : "${POSTGRES_PASSWORD:?local PostgreSQL owner password is missing}"
  : "${DATABASE_RUNTIME_PASSWORD:?local PostgreSQL runtime password is missing}"
  : "${DATABASE_ADMIN_URL:?local PostgreSQL owner URL is missing}"
  : "${DATABASE_URL:?local PostgreSQL runtime URL is missing}"
  if "$engine" container inspect "$pg_container" >/dev/null 2>&1; then
    if "$engine" ps --format '{{.Names}}' | grep -Fxq "$pg_container"; then
      log "Using running PostgreSQL container: $pg_container"
    else
      log "Starting existing PostgreSQL container: $pg_container"
      "$engine" start "$pg_container" >/dev/null
    fi
  else
    "$engine" run --detach --name "$pg_container" \
      --publish "127.0.0.1:$pg_port:5432" \
      --env POSTGRES_USER=launchpad_owner --env POSTGRES_DB=launchpad \
      --env POSTGRES_PASSWORD \
      --mount "type=volume,src=$pg_volume,dst=/var/lib/postgresql/data" \
      --health-cmd 'pg_isready -U launchpad_owner -d launchpad' \
      --health-interval 2s --health-timeout 3s --health-retries 30 \
      --security-opt no-new-privileges:true \
      postgres:17-alpine >/dev/null
  fi
  local ready=0
  for ((attempt = 0; attempt < 30; attempt++)); do
    if [[ "$("$engine" inspect --format '{{.State.Health.Status}}' "$pg_container")" == "healthy" ]]; then
      ready=1
      break
    fi
    sleep 2
  done
  [[ "$ready" == 1 ]] || { log "PostgreSQL did not become healthy; inspect container $pg_container."; return 1; }
  npm run db:migrate
  npm run db:provision
  export LQAM_LOCAL_POSTGRES_MANAGED=1

  # The import command verifies emptiness inside its own transaction. This
  # lightweight preflight lets the launcher skip it on later runs after the
  # first successful import, so an already-populated local database does not
  # repeatedly produce the empty-target error.
  if [[ -s "$APP_DATA_DIR/launchpad.json" ]]; then
    local target_state
    if ! target_state="$(node --input-type=module - "$DATABASE_ADMIN_URL" <<'NODE'
import pg from 'pg';

const connectionString = process.argv[2];
if (!connectionString) throw new Error('DATABASE_ADMIN_URL is required');
const tables = [
  'app_metadata',
  'agents',
  'projects',
  'agent_conversations',
  'runs',
  'messages',
  'orchestrations',
  'orchestration_turns',
  'orchestration_events',
  'orchestration_continuation_prompts',
  'previews',
  'roles',
  'project_agents',
  'project_leases',
  'approval_requests',
  'capability_grants',
  'permit_approval_correlations',
  'installed_skills',
  'audit_events',
];
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  let hasData = false;
  for (const table of tables) {
    const result = await client.query(`SELECT EXISTS (SELECT 1 FROM launchpad.${table}) AS present`);
    if (result.rows[0]?.present) {
      hasData = true;
      break;
    }
  }
  process.stdout.write(hasData ? 'nonempty' : 'empty');
} finally {
  await client.end().catch(() => undefined);
}
NODE
)"; then
      log "Could not inspect local PostgreSQL before importing launchpad.json."
      return 1
    fi
    case "$target_state" in
      empty)
        export LQAM_LOCAL_POSTGRES_EMPTY=1
        ;;
      nonempty)
        export LQAM_LOCAL_POSTGRES_EMPTY=0
        ;;
      *)
        log "Local PostgreSQL emptiness check returned an unexpected result."
        return 1
        ;;
    esac
  fi
  log "LQAM PostgreSQL ready. Credentials: $credentials_file (private). Volume: $pg_volume."
  log "PostgreSQL stays running after the API exits; stop it with: $engine stop $pg_container"
}
