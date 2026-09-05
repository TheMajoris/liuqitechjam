-- Launchpad PostgreSQL schema, version 1.
--
-- This migration is intentionally owned by the administrator connection. The
-- application LOGIN is provisioned separately. The NOLOGIN group below owns
-- no objects and receives only the runtime privileges it needs.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'launchpad_runtime') THEN
    CREATE ROLE launchpad_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS launchpad;

CREATE TABLE IF NOT EXISTS launchpad.schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS launchpad.app_metadata (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  database_version integer NOT NULL,
  model_catalog jsonb,
  audit_chain_anchor jsonb,
  record jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record) = 'object'),
  CONSTRAINT app_metadata_anchor_object CHECK (
    audit_chain_anchor IS NULL OR jsonb_typeof(audit_chain_anchor) = 'object'
  )
);

CREATE TABLE IF NOT EXISTS launchpad.agents (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'busy', 'stopped', 'error')),
  workspace_path text NOT NULL,
  codex_thread_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS agents_status_idx ON launchpad.agents (status);

CREATE TABLE IF NOT EXISTS launchpad.projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  workspace_path text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS projects_status_idx ON launchpad.projects (status);

CREATE TABLE IF NOT EXISTS launchpad.agent_conversations (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES launchpad.agents(id) ON DELETE CASCADE,
  title text NOT NULL,
  codex_thread_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS agent_conversations_agent_idx
  ON launchpad.agent_conversations (agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS launchpad.runs (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES launchpad.agents(id) ON DELETE CASCADE,
  conversation_id text REFERENCES launchpad.agent_conversations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS runs_agent_created_idx ON launchpad.runs (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_status_idx ON launchpad.runs (status);

CREATE TABLE IF NOT EXISTS launchpad.messages (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES launchpad.agents(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES launchpad.runs(id) ON DELETE CASCADE,
  conversation_id text REFERENCES launchpad.agent_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  origin text NOT NULL CHECK (origin IN ('direct', 'orchestration')),
  created_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS messages_agent_created_idx ON launchpad.messages (agent_id, created_at);
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON launchpad.messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS launchpad.orchestrations (
  id text PRIMARY KEY,
  project_id text REFERENCES launchpad.projects(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (
    status IN ('draft', 'queued', 'running', 'completed', 'failed', 'stopping', 'stopped', 'interrupted')
  ),
  current_run_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS orchestrations_project_idx ON launchpad.orchestrations (project_id);
CREATE INDEX IF NOT EXISTS orchestrations_status_idx ON launchpad.orchestrations (status);

CREATE TABLE IF NOT EXISTS launchpad.orchestration_turns (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES launchpad.orchestrations(id) ON DELETE CASCADE,
  -- Turns are retained as historical evidence when an Agent/Run is deleted;
  -- these IDs therefore remain relational lookup fields rather than FKs.
  agent_id text NOT NULL,
  run_id text NOT NULL,
  position integer NOT NULL,
  step_index integer,
  status text NOT NULL CHECK (status IN ('dispatched', 'completed', 'failed', 'cancelled', 'timed_out')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS orchestration_turns_session_idx
  ON launchpad.orchestration_turns (session_id, position);

CREATE TABLE IF NOT EXISTS launchpad.orchestration_events (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES launchpad.orchestrations(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  UNIQUE (session_id, sequence)
);
CREATE INDEX IF NOT EXISTS orchestration_events_session_idx
  ON launchpad.orchestration_events (session_id, sequence);

CREATE TABLE IF NOT EXISTS launchpad.orchestration_continuation_prompts (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES launchpad.orchestrations(id) ON DELETE CASCADE,
  cycle_index integer NOT NULL,
  created_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  UNIQUE (session_id, cycle_index)
);

CREATE TABLE IF NOT EXISTS launchpad.previews (
  id text PRIMARY KEY,
  agent_id text REFERENCES launchpad.agents(id) ON DELETE CASCADE,
  project_id text REFERENCES launchpad.projects(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('starting', 'running', 'stopping', 'stopped', 'failed', 'interrupted')),
  host text NOT NULL CHECK (host = '127.0.0.1'),
  host_port integer,
  container_port integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  CONSTRAINT previews_one_owner CHECK ((agent_id IS NULL) <> (project_id IS NULL))
);
CREATE INDEX IF NOT EXISTS previews_agent_idx ON launchpad.previews (agent_id);
CREATE INDEX IF NOT EXISTS previews_project_idx ON launchpad.previews (project_id);

-- Roles are declared before project_agents because the attachment may point at
-- a reusable role template.
CREATE TABLE IF NOT EXISTS launchpad.roles (
  id text PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('system', 'user')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE IF NOT EXISTS launchpad.project_agents (
  project_id text NOT NULL REFERENCES launchpad.projects(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES launchpad.agents(id) ON DELETE CASCADE,
  codex_thread_id text,
  role text CHECK (role IS NULL OR role IN ('owner', 'editor', 'viewer')),
  role_id text REFERENCES launchpad.roles(id) ON DELETE SET NULL,
  updated_at timestamptz,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (project_id, agent_id)
);
CREATE INDEX IF NOT EXISTS project_agents_agent_idx ON launchpad.project_agents (agent_id);

CREATE TABLE IF NOT EXISTS launchpad.project_leases (
  project_id text PRIMARY KEY REFERENCES launchpad.projects(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES launchpad.runs(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES launchpad.agents(id) ON DELETE CASCADE,
  acquired_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE IF NOT EXISTS launchpad.approval_requests (
  id text PRIMARY KEY,
  -- Approval records are security history and outlive deleted runtime rows.
  agent_id text NOT NULL,
  project_id text,
  run_id text,
  tool_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed', 'revoked')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS approval_requests_agent_idx ON launchpad.approval_requests (agent_id, status);
CREATE INDEX IF NOT EXISTS approval_requests_project_idx ON launchpad.approval_requests (project_id, status);

CREATE TABLE IF NOT EXISTS launchpad.capability_grants (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  project_id text NOT NULL,
  tool_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('once', 'project')),
  uses_remaining integer,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS capability_grants_lookup_idx
  ON launchpad.capability_grants (agent_id, project_id, tool_id);

CREATE TABLE IF NOT EXISTS launchpad.permit_approval_correlations (
  permit_request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('operation_approval', 'access_request')),
  agent_id text NOT NULL,
  project_id text,
  run_id text,
  tool_id text NOT NULL,
  last_known_status text NOT NULL CHECK (
    last_known_status IN ('pending', 'approved', 'denied', 'expired', 'consumed', 'revoked', 'unknown')
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (permit_request_id, kind)
);
CREATE INDEX IF NOT EXISTS permit_approval_correlations_agent_idx
  ON launchpad.permit_approval_correlations (agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS launchpad.installed_skills (
  id text PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('built-in', 'user', 'installed')),
  version text NOT NULL,
  installed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);

CREATE TABLE IF NOT EXISTS launchpad.audit_events (
  id text PRIMARY KEY,
  sequence bigint NOT NULL UNIQUE,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'failure')),
  agent_id text,
  project_id text,
  run_id text,
  orchestration_id text,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  category text NOT NULL,
  trace_id text NOT NULL,
  span_id text NOT NULL,
  prev_hash text,
  hash text,
  created_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  principal jsonb NOT NULL CHECK (jsonb_typeof(principal) = 'object'),
  resource jsonb,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON launchpad.audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_agent_idx ON launchpad.audit_events (agent_id, sequence DESC);
CREATE INDEX IF NOT EXISTS audit_events_project_idx ON launchpad.audit_events (project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS audit_events_run_idx ON launchpad.audit_events (run_id, sequence DESC);
CREATE INDEX IF NOT EXISTS audit_events_trace_idx ON launchpad.audit_events (trace_id, sequence);

CREATE OR REPLACE FUNCTION launchpad.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'launchpad.audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update_delete ON launchpad.audit_events;
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON launchpad.audit_events
  FOR EACH ROW EXECUTE FUNCTION launchpad.reject_audit_mutation();

DROP TRIGGER IF EXISTS audit_events_no_truncate ON launchpad.audit_events;
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON launchpad.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION launchpad.reject_audit_mutation();

CREATE OR REPLACE FUNCTION launchpad.reject_audit_anchor_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.audit_chain_anchor IS NOT NULL
     AND OLD.audit_chain_anchor IS DISTINCT FROM NEW.audit_chain_anchor THEN
    RAISE EXCEPTION 'launchpad audit_chain_anchor is immutable once established';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_metadata_anchor_immutable ON launchpad.app_metadata;
CREATE TRIGGER app_metadata_anchor_immutable
  BEFORE UPDATE ON launchpad.app_metadata
  FOR EACH ROW EXECUTE FUNCTION launchpad.reject_audit_anchor_change();

GRANT USAGE ON SCHEMA launchpad TO launchpad_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA launchpad TO launchpad_runtime;

-- Schema history and audit evidence are not normal mutable application data.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON launchpad.schema_migrations FROM launchpad_runtime;
GRANT SELECT ON launchpad.schema_migrations TO launchpad_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON launchpad.audit_events FROM launchpad_runtime;
GRANT SELECT, INSERT ON launchpad.audit_events TO launchpad_runtime;

-- The legacy audit anchor is written only by the offline owner import. Runtime
-- can create a fresh NULL metadata row and update non-audit metadata columns.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON launchpad.app_metadata FROM launchpad_runtime;
GRANT SELECT ON launchpad.app_metadata TO launchpad_runtime;
GRANT INSERT (id, database_version, model_catalog, record)
  ON launchpad.app_metadata TO launchpad_runtime;
GRANT UPDATE (database_version, model_catalog, record)
  ON launchpad.app_metadata TO launchpad_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA launchpad
  REVOKE ALL ON TABLES FROM launchpad_runtime;
