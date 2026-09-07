-- Runs are historical execution records, not Agent state.
--
-- `deleteAgent` deliberately retains a deleted Agent's runs and tombstones
-- them (`agentName` + `agentDeletedAt`) so their traces and audit evidence
-- stay readable. The relational mirror could not express that: `runs.agent_id`
-- carried a foreign key to `agents(id)`, so writing the snapshot back after a
-- delete failed with
--   insert or update on table "runs" violates foreign key constraint
--   "runs_agent_id_fkey"
-- and the delete was rejected. The same applies to `runs.conversation_id`,
-- whose parent rows are removed with the Agent.
--
-- Dropping both constraints makes the schema agree with the retention rule.
-- The columns, their indexes, and every read path are unchanged; a tombstoned
-- run simply no longer needs a live parent row.
ALTER TABLE launchpad.runs DROP CONSTRAINT IF EXISTS runs_agent_id_fkey;
ALTER TABLE launchpad.runs DROP CONSTRAINT IF EXISTS runs_conversation_id_fkey;

-- Messages are removed with their Agent, so `messages.run_id` keeps its
-- cascade. `messages.agent_id` and `messages.conversation_id` likewise stay:
-- nothing retains a message past its Agent.
