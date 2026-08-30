# Volc Agent Launchpad

## Overview

Volc Agent Launchpad is a local-first Agent platform for middleware-focused
hackathons. It provides Agent CRUD, lifecycle controls, chat, persistent
workspaces and Codex sessions, asynchronous runs, Team orchestration,
per-Agent model configuration, and local application previews.

## Screenshots

![Agent Playground](docs/assets/playground.jpg)

![Create an Agent](docs/assets/create-agent.jpg)

## Local-first quickstart

Use the local container-backed path first. You need Node.js 22+, Docker
Desktop/Colima or Podman, and an Ark API key/model. No Permit account, Permit
API key, or cloud PDP is required for this development/POC path.

```bash
git clone <repository-url>
cd liuqitechjam
npm install
export ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
export ARK_API_KEY=your-ark-api-key
export ARK_MODEL=ep-your-endpoint-id

npm run poc
```

`npm run poc` invokes [scripts/start-local-poc.sh](scripts/start-local-poc.sh),
selects a running Docker/Colima/Podman engine, builds
[Dockerfile.runtime](Dockerfile.runtime), persists local state, builds the
application, and serves the bundled Web UI at
[`http://localhost:3000`](http://localhost:3000). It sets
`AUTHORIZATION_MODE=local`, ignores stale Permit variables in the shell, and
does not start or contact a Permit PDP.

A PDP (Policy Decision Point) is the service Permit uses to answer policy
allow/deny checks. In local POC mode, the repository itself is the policy
authority: active Projects and their `owner`, `editor`, and `viewer`
Agent roles are read from the local JSON store. Project membership and role
checks still protect Project-scoped Agent execution, preview, skill, and tool
operations. The
Permit-specific second approval step for Agent tools is automatically
acknowledged locally so a demo does not block on a cloud approval workflow;
this does not grant access to an Agent that its Project role does not allow.
There is no real Permit approval UI or approval API in local mode.

Local mode is deliberately loopback-only. The launcher binds the control plane
to `127.0.0.1` by default, and the server rejects
`AUTHORIZATION_MODE=local` with a non-loopback `HOST`. Set
`LOCAL_POC_DATA_ROOT` to move persistent state, `CONTAINER_ENGINE` to
force `docker` or `podman`, or `APP_AUTH_TOKEN` to require an app token.

The runtime container includes Codex. The launcher also configures the
engine-specific `MCP_CONTAINER_URL` (`host.docker.internal` for Docker or
`host.containers.internal` for Podman). Set `MCP_CONTAINER_URL` yourself
when using custom container networking.

### Roles, skills, and local research

Open **Roles & skills** in the sidebar to create reusable Agent roles. A role
combines explicit Project access, a user-selected set of tools, and installed
instruction-only skills. Assign one role to each Agent in a Project from the
same screen. Editing an assigned role asks for confirmation because the change
propagates to every Agent using it.

The skill catalog is searchable in that screen. Installing a catalog skill
copies bounded instructions into the local store; it does not execute code or
grant tools. Users still choose the tools that belong to each role.

Local web research defaults to a self-hosted SearXNG container, so no Brave API
key is required. `npm run poc` reads `.env`, starts SearXNG on loopback when
needed, and gives roles two separately selectable tools: `web.search` for
keyword search and `web.fetch` for a supplied public URL. See
[the local research guide](docs/LOCAL_SEARCH.md) for provider and safety
settings.

### Permit production path

Production keeps `AUTHORIZATION_MODE=permit` (the secure default) and
requires a Permit project/environment, API key, PDP URL, tenant key, and
operation-approval configuration. Configure the resources, actions, roles,
and approval settings described in [the Permit policy setup
guide](docs/PERMIT_POLICY_SETUP.md), then start the server outside
`npm run poc`:

```bash
export NODE_ENV=production
export AUTHORIZATION_MODE=permit
export PERMIT_API_KEY=your-permit-environment-api-key
export PERMIT_PDP_URL=https://your-pdp-host
export PERMIT_PROJECT_ID=your-permit-project-key-or-id
export PERMIT_ENVIRONMENT_ID=your-permit-environment-key-or-id
export PERMIT_TENANT_KEY=your-permit-tenant-key
export PERMIT_OPERATION_APPROVAL_CONFIG_ID=your-operation-approval-config-id

npm run build
npm run start -w @launchpad/server
```

Use a separately hosted or self-hosted PDP at `PERMIT_PDP_URL`; the
[PDP container guide](https://docs.permit.io/overview/run-pdp) explains that
deployment. Keep Permit credentials out of source control. The local POC
launcher always forces `AUTHORIZATION_MODE=local`; this keeps `npm run poc`
deterministic and cloud-free. Use the normal server start path for Permit.

## Development and checks

For contributor iteration, after `npm install`, run the Web UI and API on the
host with the same Ark settings:

```bash
export ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
export ARK_API_KEY=your-ark-api-key
export ARK_MODEL=ep-your-endpoint-id
npm run dev
```

The Web UI runs at `http://localhost:5173`; the API runs at
`http://localhost:3000`; and the health endpoint is
`GET http://localhost:3000/api/health`.

Default local-process development requires a `codex` executable on the host.
The POC container image includes Codex, so the container-backed quickstart does
not require a host Codex installation.

Run the project check with:

```bash
npm run check
```

## Current progress — 2026-08-30

Implemented:

- 2D collaborative Agent Workspace: a PixiJS room that projects real
  orchestration, Project, preview, and approval state, with per-Agent
  inspection and lifecycle control. See
  [the workspace guide](docs/AGENT_WORKSPACE_2D.md).
- Agent CRUD/lifecycle/chat; persistent workspaces and Codex sessions; async
  runs; local/container execution.
- Orchestration foundation with sequential/supervisor modes, bounded steps,
  shared Team context, continuation and deletion.
- Per-Agent provider/model/reasoning configuration.
- Wave 7 preview runtime including supported npm app detection, static root
  `index.html` fallback, lifecycle/logs/error UI.

Next/planned: Wave 8 roles/skills/tools/permission enforcement, then
observability, failure/recovery, demo hardening, optional expansion.

## Limitations

- Single-user proof of concept.
- The loopback POC uses repository-backed roles; production authorization
  requires Permit.io configuration.
- No automatic dependency installation.
- Preview is loopback/open-new-window oriented.

## Links

- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
- [Overall implementation plan](docs/AGENT_MIDDLEWARE_OVERALL_IMPLEMENTATION_PLAN_V4.md)
- [Wave 5 shared conversation context handoff](docs/WAVE_5_SHARED_CONVERSATION_CONTEXT_HANDOFF.md)
- [Wave 7 preview runtime](docs/WAVE_7_PREVIEW_RUNTIME.md)
- [Wave 7 static HTML preview and error UI plan](docs/WAVE_7_STATIC_HTML_PREVIEW_AND_ERROR_UI_IMPLEMENTATION_PLAN.md)
- [Permit policy setup and resource scope](docs/PERMIT_POLICY_SETUP.md)
- [2D Agent Workspace](docs/AGENT_WORKSPACE_2D.md)
- [Dockerfile](Dockerfile) · [Dockerfile.runtime](Dockerfile.runtime) · [docker-compose.yml](docker-compose.yml)
- [Local POC script](scripts/start-local-poc.sh)
