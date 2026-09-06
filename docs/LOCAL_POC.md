# Liu Qi Agent Management (LQAM) local POC

Use Node.js 22+ and a running Docker Desktop, Colima, or Podman engine.
Install dependencies, copy `.env.example` to `.env`, and fill in your Ark API
key/model. Run `npm run poc` to build and start the existing containerized Agent
runtime and local Web/API. This launcher uses local authorization and binds the
API to loopback by default.

The recommended POC sets `PERSISTENCE_BACKEND=postgres`: a fresh state
provisions local PostgreSQL with a persistent volume and separate generated
owner/runtime credentials. If a non-empty existing JSON store is present while
the database is empty, startup stops and directs you to the offline import;
the JSON file is never overwritten or silently bypassed. Set
`PERSISTENCE_BACKEND=json` only for an explicit legacy/recovery run.

See [PostgreSQL setup, migration, and audit security](POSTGRESQL.md) for the
import procedure, environment variables, database permissions, and shutdown.
The broader runtime/model configuration remains in the [README](../README.md).
