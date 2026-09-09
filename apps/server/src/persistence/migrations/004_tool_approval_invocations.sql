-- Native Mastra workflow approval projection (schema version 4).
--
-- This table is deliberately independent from approval_requests,
-- capability_grants, and permit_approval_correlations.  Those collections are
-- historical compatibility data and never authorize a native workflow call.
-- Agent/Project/Run references are scalar evidence rather than foreign keys:
-- terminal approval history must remain readable after an owner is deleted,
-- and an application lifecycle hook fences active records before deletion.

CREATE TABLE IF NOT EXISTS launchpad.tool_approval_invocations (
  approval_id text PRIMARY KEY,
  invocation_id text NOT NULL UNIQUE,
  workflow_run_id text NOT NULL UNIQUE,
  agent_id text NOT NULL,
  project_id text,
  run_id text NOT NULL,
  orchestration_id text,
  turn_id text,
  session_id text,
  tool_id text NOT NULL,
  policy_version text NOT NULL,
  -- HMAC-like opaque binding.  Parsed input never belongs in this table.
  input_binding text NOT NULL,
  -- Random in-process state reference; it is not a bearer capability.
  private_input_handle text NOT NULL,
  safe_summary text NOT NULL,
  deadline_at timestamptz NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'requested', 'waiting', 'approved', 'resuming', 'executing',
      'succeeded', 'rejected', 'failed_pre_execution', 'failed',
      'expired', 'cancelled', 'revoked', 'uncertain'
    )
  ),
  version bigint NOT NULL CHECK (version > 0),
  owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
  decision text CHECK (decision IS NULL OR decision IN ('approved', 'rejected')),
  decision_actor jsonb CHECK (decision_actor IS NULL OR jsonb_typeof(decision_actor) = 'object'),
  decision_at timestamptz,
  decision_reason text,
  trace_refs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trace_refs) = 'object'),
  execution_started_at timestamptz,
  completed_at timestamptz,
  terminal_reason text,
  cancellation_requested_at timestamptz,
  cancellation_reason text,
  uncertain_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ordinal bigint NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  CONSTRAINT tool_approval_decision_fields_consistent CHECK (
    (decision IS NULL AND decision_actor IS NULL AND decision_at IS NULL)
    OR (decision IS NOT NULL AND decision_actor IS NOT NULL AND decision_at IS NOT NULL)
  ),
  CONSTRAINT tool_approval_status_decision_consistent CHECK (
    (status IN ('requested', 'waiting') AND decision IS NULL)
    OR (status IN (
      'approved', 'resuming', 'executing', 'succeeded',
      'failed_pre_execution', 'failed', 'uncertain'
    ) AND decision = 'approved')
    OR (status = 'rejected' AND decision = 'rejected')
    OR (status IN ('expired', 'cancelled', 'revoked') AND (decision IS NULL OR decision = 'approved'))
  )
);

CREATE INDEX IF NOT EXISTS tool_approval_invocations_agent_status_idx
  ON launchpad.tool_approval_invocations (agent_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS tool_approval_invocations_project_status_idx
  ON launchpad.tool_approval_invocations (project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS tool_approval_invocations_run_idx
  ON launchpad.tool_approval_invocations (run_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tool_approval_invocations_deadline_idx
  ON launchpad.tool_approval_invocations (deadline_at)
  WHERE status IN ('requested', 'waiting', 'approved', 'resuming');

GRANT SELECT, INSERT, UPDATE, DELETE ON launchpad.tool_approval_invocations TO launchpad_runtime;
