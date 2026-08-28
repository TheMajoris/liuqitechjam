# Local POC: Docker, Colima, and rootless Podman

How to run the platform locally with a disposable container per Agent turn. This
is the recommended development and judging path
([agent-launchpad-challenge-context.md](../agent-launchpad-challenge-context.md)
section 3).

This page describes what [`scripts/start-local-poc.sh`](../scripts/start-local-poc.sh)
(invoked by `npm run poc`) does, plus the separate model-gateway process
(`npm run gateway`, implemented) that the secretless Kill Switch profile
requires. New developers: start at [docs/ONBOARDING.md](ONBOARDING.md).

## Prerequisites

- macOS or Linux.
- Node.js **22+** and npm **10+** (`node --version`, `npm --version`). The
  startup script refuses older Node.
- Exactly one container engine, reachable without `sudo`:
  - **Docker** Engine / Desktop, or
  - **Colima** (`colima start` - it exposes the Docker CLI, so use
    `CONTAINER_ENGINE=docker`), or
  - **rootless Podman** (see
    [Rootless Podman on Linux](#rootless-podman-on-linux)).
- A Volcengine Ark API key and a Responses-capable endpoint id (`ep-...`).
- Verify the engine is up before starting:

  ```bash
  docker info      # or: podman info
  ```

## 1. Configure `.env`

```bash
cp .env.example .env
```

Fill in at least:

```dotenv
# Provider credential (the protected asset)
ARK_API_KEY=<your-ark-model-api-key>
ARK_MODEL=ep-<your-endpoint-id>

# Optional shared control-plane token; may stay empty on a loopback host
APP_AUTH_TOKEN=

# Secretless gateway profile - set these to run the Kill Switch path.
# Setting MODEL_GATEWAY_ADMIN_TOKEN (with RUNTIME_PROVIDER=container, which
# `npm run poc` forces) activates the secretless profile.
MODEL_GATEWAY_URL=http://127.0.0.1:4000
MODEL_GATEWAY_ADMIN_TOKEN=<long-random-admin-token, 24+ URL-safe chars>
GATEWAY_PROVIDERS=ark,mock
PROVIDER_ARK_PROTOCOL=responses-http
PROVIDER_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
PROVIDER_ARK_MODELS=ep-<your-endpoint-id>
PROVIDER_ARK_KEY_ENV=ARK_API_KEY
PROVIDER_MOCK_PROTOCOL=mock
PROVIDER_MOCK_MODELS=mock-responses-1
RUNTIME_PROVIDER_ID=ark
```

See [.env.example](../.env.example) for every variable, grouped and commented.
`ARK_API_KEY` must be an Ark **model** API key, not a BytePlus account AK/SK -
wrong credentials return `401 Unauthorized`.

> `npm run poc` reads `ARK_API_KEY` / `ARK_MODEL` from the **process
> environment**, not from `.env`. Either `export` them, prefix the command, or
> use `set -a; . ./.env; set +a` first. The Docker Compose path
> (`docker compose up --build`) reads `.env` directly.

## 2. Start the platform

```bash
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

`npm run poc` runs [`scripts/start-local-poc.sh`](../scripts/start-local-poc.sh),
which:

1. Requires `ARK_API_KEY` and `ARK_MODEL` (exit `2` if missing) and Node 22+.
2. Detects the engine: honours `CONTAINER_ENGINE` if set; otherwise tries
   Docker, then starts Colima if only Colima is present, then Podman
   (starting the Podman machine on macOS).
3. Runs `npm ci` if `node_modules` is absent.
4. Resolves the state root (see
   [State directories](#state-directories)) and creates
   `data/`, `workspaces/`, `codex-home/` under it.
5. Builds the Runtime image `volc-agent-runtime:local` from
   [`Dockerfile.runtime`](../Dockerfile.runtime).
6. Runs a bind-mount write pre-flight in the image; exit `2` with guidance if
   the engine cannot mount the state root.
7. If `CODEX_SANDBOX_MODE=workspace-write` but Codex Landlock is unavailable in
   the container, falls back to `danger-full-access` **inside the disposable
   container boundary** and warns.
8. Exports `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3000`,
   `RUNTIME_PROVIDER=container`, `CONTAINER_ENGINE`, `CONTAINER_RUNTIME_IMAGE`,
   `CONTAINER_USER=$(id -u):$(id -g)`, and a per-checkout `RUNTIME_INSTANCE_ID`.
9. Installs an EXIT/INT/TERM trap that removes leftover Runtime containers
   labelled for this `RUNTIME_INSTANCE_ID` (and runs it once up front to recover
   from a previous crash).
10. Runs `npm run build`, then `npm start`.

Open <http://localhost:3000>.

Force a specific engine:

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Stop with `Ctrl+C`. The trap removes temporary Runtime containers; Agent
workspaces and Codex conversations under the state root are kept for next time.

## The gateway process

In the secretless profile the model-gateway is a **separate process** from the
control plane. It is the only process that reads provider keys
(`apps/server/src/gateway/config.ts`), and the Runtime containers are placed on
an internal network that can reach the gateway and nothing else.

```bash
# terminal 1 - model-gateway sidecar
set -a; . ./.env; set +a
npm run gateway -w @launchpad/server   # serves MODEL_GATEWAY_HOST:MODEL_GATEWAY_PORT (default 127.0.0.1:4000)

# terminal 2 - control plane + Runtime image
set -a; . ./.env; set +a
ARK_API_KEY=$ARK_API_KEY ARK_MODEL=$ARK_MODEL npm run poc

# health
curl -fsS "$MODEL_GATEWAY_URL/internal/health"
```

`npm run gateway` is defined in `apps/server/package.json`, so invoke it with
`-w @launchpad/server` from the repo root (or run `npm run gateway` inside
`apps/server/`). `gateway:dev` adds file-watch reload.

If `MODEL_GATEWAY_ADMIN_TOKEN` is **not** set, the platform runs as the starter
kit does: the control plane and the Runtime container both receive `ARK_API_KEY`
(see [docs/DEVIATIONS.md](DEVIATIONS.md)). Confirm which profile is active with
`curl -fsS http://localhost:3000/api/security/posture` - look for
`"profile":"secretless-gateway"`.

## State directories

`start-local-poc.sh` picks the state root in this order:

| Condition | State root |
| --- | --- |
| `LOCAL_POC_DATA_ROOT` is set | `$LOCAL_POC_DATA_ROOT` (uses `data/`, `workspaces/`, `codex-home/` under it; **overrides** `APP_DATA_DIR` etc.) |
| macOS, no override | `~/.volc-agent-launchpad` |
| Linux, no override | `<repo>/.local` |

`APP_DATA_DIR`, `AGENT_WORKSPACE_ROOT`, and `CODEX_HOME` are honoured on the
non-macOS/non-override branches if you export them yourself; when
`LOCAL_POC_DATA_ROOT` is set it wins.

Reset local state (safe to delete; it is regenerated):

```bash
rm -rf .local .data          # default Linux roots
# or, with an override:
rm -rf "$LOCAL_POC_DATA_ROOT"
```

## Docker Compose (alternative)

```bash
./scripts/bootstrap-local.sh     # creates .env
# edit .env: ARK_API_KEY, ARK_MODEL, APP_AUTH_TOKEN (24+ chars)
docker compose up --build
docker compose down              # stop, keep Agent data
```

Compose forces `HOST=0.0.0.0`, `NODE_ENV=production`, and in-container state
paths, and bind-mounts `./data`, `./workspaces`, `./codex-home`. Publish port is
`PUBLIC_PORT` (default `3000`).

## Rootless Podman on Linux

For a clean Linux host with no Docker:

1. Install Podman (`podman >= 4`) and enable rootless support:

   ```bash
   sudo apt-get install -y podman uidmap slirp4netns   # Debian/Ubuntu
   podman info                                         # must succeed WITHOUT sudo
   ```

2. Confirm subuid/subgid ranges exist for your user (usually automatic):

   ```bash
   grep "$USER" /etc/subuid /etc/subgid
   # if missing:
   sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"
   podman system migrate
   ```

3. Start the POC with Podman selected:

   ```bash
   CONTAINER_ENGINE=podman \
   ARK_API_KEY=your-ark-api-key \
   ARK_MODEL=ep-your-endpoint-id \
   npm run poc
   ```

   `start-local-poc.sh` and the container runner add `--userns keep-id` for
   Podman so bind-mounted files in `workspaces/` and `codex-home/` stay owned by
   your host user. `CONTAINER_USER` defaults to `$(id -u):$(id -g)`.

4. If the state root is under a path Podman cannot map, set
   `LOCAL_POC_DATA_ROOT` to a directory inside your home:

   ```bash
   LOCAL_POC_DATA_ROOT="$HOME/launchpad-state" \
   CONTAINER_ENGINE=podman ARK_API_KEY=... ARK_MODEL=ep-... npm run poc
   ```

Notes:

- Rootless Podman has no Landlock in many kernels; startup then falls back to
  `danger-full-access` **inside the container**. This is the disposable
  container boundary, not tenant isolation ([SECURITY.md](../SECURITY.md)).
- **[planned]** The gateway-only Runtime network is created as a rootless Podman
  network; `slirp4netns` (or `pasta`) provides the gateway's egress leg.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `ARK_API_KEY and ARK_MODEL are required` (exit 2) | Not exported into the environment. Prefix the command or `set -a; . ./.env; set +a`. |
| `Node.js 22+ is required` (exit 2) | Upgrade Node (`nvm install 22`). |
| `No running Docker, Colima, or Podman engine was found` | Start the engine (`colima start`, `systemctl --user start podman.socket`, open Docker Desktop) and re-run. |
| `The container engine cannot mount <root>` (exit 2) | State root is outside what the VM/engine shares. Set `LOCAL_POC_DATA_ROOT` to a shared path (e.g. under `$HOME`). |
| `Codex Landlock is unavailable ... Falling back to danger-full-access` | Expected on some kernels; the outer container is the boundary. Do not mount unrelated secrets or host dirs. |
| `401 Unauthorized` from the model call | Account AK/SK instead of an Ark model key, or wrong endpoint id. Check `ARK_API_KEY` / `ARK_MODEL`. |
| Port 3000 in use | `PORT=3001 npm run poc` (Compose: `PUBLIC_PORT=3001`). |
| Leftover Runtime containers after a crash | Re-run `npm run poc` (the startup trap reaps them by `RUNTIME_INSTANCE_ID`), or `docker ps -a --filter label=io.codejam.launchpad=agent-runtime`. |
| `/api/system` for a status snapshot | Open `http://localhost:3000/api/system`. |

## Related

- [README.md](../README.md) - Local browser SOP and configuration table.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) - components and trust zones.
- [docs/DEMO.md](DEMO.md) - three-minute operator demo.
- [.env.example](../.env.example) - every environment variable.
