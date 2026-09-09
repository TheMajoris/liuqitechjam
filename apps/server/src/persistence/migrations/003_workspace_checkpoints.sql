-- Workspace source checkpoints, execution cycles, and durable Project
-- reservations (schema version 3).
--
-- A checkpoint is a product record whose private Git identity lives inside its
-- JSONB record; nothing here references Agent, Run, or turn rows as foreign
-- keys, because historical checkpoints must survive the deletion of the
-- conversation or Agent that produced them. Project deletion owns cleanup.

CREATE TABLE IF NOT EXISTS launchpad.workspace_execution_cycles (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES launchpad.projects(id) ON DELETE CASCADE,
  -- Historical scalar; the conversation may be deleted while evidence remains.
  orchestration_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'stopped', 'interrupted')
  ),
  created_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX IF NOT EXISTS workspace_execution_cycles_orchestration_idx
  ON launchpad.workspace_execution_cycles (orchestration_id, created_at);

CREATE TABLE IF NOT EXISTS launchpad.workspace_checkpoints (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES launchpad.projects(id) ON DELETE CASCADE,
  checkpoint_ordinal bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('baseline', 'turn_success', 'safety')),
  state text NOT NULL CHECK (state IN ('preparing', 'captured', 'ready', 'failed', 'invalid')),
  run_id text,
  orchestration_id text,
  created_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  UNIQUE (project_id, checkpoint_ordinal)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_checkpoints_turn_run_idx
  ON launchpad.workspace_checkpoints (run_id)
  WHERE kind = 'turn_success' AND run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_checkpoints_project_created_idx
  ON launchpad.workspace_checkpoints (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_checkpoints_orchestration_idx
  ON launchpad.workspace_checkpoints (orchestration_id, created_at);

CREATE TABLE IF NOT EXISTS launchpad.workspace_operations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES launchpad.projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('cycle', 'recovery')),
  stage text NOT NULL CHECK (
    stage IN ('reserved', 'preparing', 'backed_up', 'restoring', 'restored',
              'resume_accepted', 'settled', 'failed', 'recovery_required')
  ),
  reservation_held boolean NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
-- One held reservation per Project: the database enforces what the
-- application's serialized mutation already guarantees.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_operations_held_idx
  ON launchpad.workspace_operations (project_id)
  WHERE reservation_held;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_operations_request_idx
  ON launchpad.workspace_operations (project_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_operations_project_created_idx
  ON launchpad.workspace_operations (project_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON launchpad.workspace_execution_cycles TO launchpad_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON launchpad.workspace_checkpoints TO launchpad_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON launchpad.workspace_operations TO launchpad_runtime;
