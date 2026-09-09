-- Native Mastra workflow snapshot schema (schema version 5).
--
-- The approval bridge stores suspend/resume snapshots through the pinned
-- @mastra/pg adapter, which owns its own DDL inside a dedicated schema.  That
-- schema is deliberately separate from `launchpad`: nothing here is
-- application data, and the adapter must be free to evolve its own tables
-- without a hand-written migration tracking them.
--
-- The adapter is constructed with `disableInit: false`, so on first boot it
-- creates its tables itself as the runtime login.  It only issues
-- `CREATE SCHEMA` when the schema is not already visible to that login, and
-- `launchpad_runtime` is intentionally NOCREATEDB with no CREATE on the
-- database.  Creating the schema here, before the runtime starts, is what
-- keeps the adapter on its no-op path instead of a permission failure that
-- fails the whole bridge closed at startup.
--
-- The name must match MCP_TOOL_APPROVAL_SCHEMA (default `mastra_approval`).
-- A deployment that overrides that variable must provision its schema the
-- same way before enabling MCP_TOOL_APPROVAL_ENABLED.

CREATE SCHEMA IF NOT EXISTS mastra_approval;

-- USAGE is what makes the schema visible to the runtime login through
-- information_schema.schemata (its PostgreSQL 17 definition admits a schema on
-- has_schema_privilege(oid, 'CREATE, USAGE'), not ownership alone), which is
-- the check the adapter uses to decide whether it must create the schema
-- itself. CREATE is what lets it then build its own tables there. Ownership is
-- deliberately left with the migration owner: reassigning it would require
-- every deployment's migration admin to be a member of launchpad_runtime.
GRANT USAGE, CREATE ON SCHEMA mastra_approval TO launchpad_runtime;
