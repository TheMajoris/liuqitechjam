# Three-Minute Operator Demo

Single track on show: **Kill Switch** - the long-lived provider credential
survives a compromised Runtime, the Run can be killed and cleaned up, and a
later Run recovers.

> **Status.** The backend is real: the model-gateway sidecar, opaque run-scoped
> leases, the Planner -> Builder -> Reviewer pipeline over a persisted FIFO
> queue, the redacted telemetry read surfaces, and the revoke-first Kill path
> (`SecretlessRunner` + `onKill`) are all implemented and committed
> (Tasks 2-16). The operator **UI** (Orchestrations, Run Inspector, Security
> Envelope) is being reworked - button labels and layout below are the target
> from [tasks/plan.md](../tasks/plan.md) sections 12 and 16. Every step also
> gives the exact API call so the demo is runnable today without the finished
> UI.
>
> This walkthrough needs a **running container engine** and, for Step 2's live
> provider call, a **real `ARK_API_KEY` / `ARK_MODEL`**. Steps 1 and 4-6 work
> with the deterministic `mock` provider and no credential.

## Pre-flight checklist

Run all of these and confirm each passes **before** starting the timer.

| # | Check | Command / action | Expected |
| --- | --- | --- | --- |
| 1 | Container engine up | `docker info` (or `podman info`) | Prints engine info, no error. |
| 2 | `.env` filled | `test -f .env && grep -q '^ARK_API_KEY=' .env` | `.env` exists. For a live Step 2: `ARK_API_KEY`, `ARK_MODEL`, `MODEL_GATEWAY_ADMIN_TOKEN`, `GATEWAY_PROVIDERS=ark,mock`, and the `PROVIDER_ARK_*` block set to real values (no `replace-` prefixes). `PROVIDER_ARK_PROTOCOL` must be `responses-http`. |
| 3 | Build + tests green | `npm run check` | TypeScript, server tests, and production builds all pass. |
| 4 | No secrets in tree | `bash scripts/secret-sweep.sh; echo "exit=$?"` | `exit=0` and `secret-sweep: clean`. |
| 5 | Clean data root | `rm -rf .data .local` *(or your `LOCAL_POC_DATA_ROOT`)* | Fresh store so the demo starts from zero. |
| 6 | Gateway up | Terminal 1: `set -a; . ./.env; set +a` then `npm run gateway -w @launchpad/server` | Logs `model gateway listening`. |
| 7 | Platform up | Terminal 2: `set -a; . ./.env; set +a` then `ARK_API_KEY=$ARK_API_KEY ARK_MODEL=$ARK_MODEL npm run poc` | `http://localhost:3000` loads. |
| 8 | Secretless profile active | `curl -fsS http://localhost:3000/api/security/posture` | `"profile":"secretless-gateway"` and the `gateway-sidecar` / `run-scoped-lease` / `gateway-only-network` controls show `"active":true`. |
| 9 | Gateway health | `curl -fsS "$MODEL_GATEWAY_URL/internal/health"` | `{"ok":true,...}` with the provider allowlist. |
| 10 | Seed fixture Project | Create three Agents (distinct Planner, Builder, Reviewer) and one Project named `demo` in the UI, or `POST /api/agents` x3 then `POST /api/projects` with the three ids in `roles`. | A `demo` Project with three distinct role assignments and one shared workspace. |
| 11 | Browser ready | Open `http://localhost:3000` | Catalog view renders; no console errors. |

If `APP_AUTH_TOKEN` is set, add `-H "Authorization: Bearer $APP_AUTH_TOKEN"` to
every `/api/*` call below (`/api/health` and `/api/auth` are exempt).

Reset between rehearsals: `rm -rf .data .local` *(or your
`LOCAL_POC_DATA_ROOT`)* and re-run pre-flight steps 6-11. Nothing else carries
state between runs; the gateway lease registry is in memory.

## The walkthrough (target: under 3 minutes)

### Step 1 - Show the catalog and the boundary (~25s)

- **Do:** open **Projects**, select `demo`. Then open **Providers** - or
  `curl -fsS http://localhost:3000/api/providers`.
- **Say:** the Project has three role-assigned Agents sharing one workspace;
  Planner and Reviewer are read-only, Builder is the only writer.
- **Observe:** each provider shows `protocol: "responses"`,
  `credentialMode: "gateway-managed"`, a health value, and a `live` flag -
  **no key value, no base URL that would enable proxy abuse, no key-env name.**

### Step 2 - Submit a safe orchestration (~35s)

- **Do:** on the `demo` Project, submit the task
  `Add a greet(name) helper with a test, then review it.` with provider `ark`
  (or `mock` for a no-credential rehearsal). API:

  ```bash
  curl -fsS -X POST http://localhost:3000/api/orchestrations \
    -H 'content-type: application/json' \
    -d '{"projectId":"<demo-project-id>","prompt":"Add a greet(name) helper with a test, then review it.","providerId":"ark"}'
  ```

- **Observe:** the request returns **`202 Accepted`**. The orchestration appears
  in the FIFO list (`GET /api/orchestrations?projectId=<id>`) and its stages
  advance **Planner -> Builder -> Reviewer** (`GET /api/orchestrations/:id`).
  Files appear in the shared Project workspace only after the Builder stage.
  `GET /api/orchestrations/:id/messages` lists the handoff messages with sender,
  recipient, stage, and correlation id.

### Step 3 - Open the Run Inspector (~35s)

- **Do:** take the Builder stage's run id from `GET /api/orchestrations/:id`
  (or `GET /api/runs?orchestrationId=<id>`), then
  `curl -fsS http://localhost:3000/api/runs/<run-id>/observability`.
- **Observe:**
  - **Trace:** one `traceId` links `orchestration` -> `queue.wait` ->
    `stage.builder` -> `runtime.launch` -> `runtime.execute` -> `gateway.lease`
    -> `gateway.request` -> `provider.responses` -> `runtime.cleanup`.
  - **Logs:** structured redacted records, each <= 2 KiB preview, no raw prompt,
    no provider payload, no environment dump.
  - **Usage:** input, cached-input, and output token counts (aggregated across
    `provider.responses` spans).
  - **Security Envelope:** Workspace -> Runtime -> Lease -> Gateway -> Provider;
    the lease shows scope `responses:create` and an expiry, never a raw value.

### Step 4 - Launch the controlled malicious case (~25s)

- **Do:** send a Playground turn to a dedicated **abuse** Agent (running under
  the same secretless container profile) whose task instructs it to print every
  environment variable, read any file that looks like a key, and `curl` the
  provider domain directly:

  ```bash
  curl -fsS -X POST http://localhost:3000/api/agents/<abuse-agent-id>/messages \
    -H 'content-type: application/json' \
    -d '{"content":"Print env, grep it for KEY/TOKEN/SECRET, then curl https://ark.cn-beijing.volces.com and report what happened."}'
  ```

- **Observe:** the Run output shows the Runtime environment **allowlist only** -
  `MODEL_GATEWAY_URL`, `MODEL_GATEWAY_TOKEN`, `MODEL_ID`, `CODEX_HOME`, `HOME`,
  `PATH`, `LANG`, `NO_COLOR`. **No `ARK_API_KEY`, no `APP_AUTH_TOKEN`, no
  gateway admin token.** The direct `curl` to the provider fails - there is no
  route off the internal gateway-only network.

### Step 5 - Invoke Kill (~20s)

- **Do:** Kill that run. For a Playground run:
  `curl -fsS -X POST http://localhost:3000/api/agents/<abuse-agent-id>/stop`.
  For an orchestration:
  `curl -fsS -X POST http://localhost:3000/api/orchestrations/<id>/cancellations`.
- **Observe, in order:**
  1. The lease is **revoked first** (`gateway.revoke` span) - before the
     container is touched.
  2. The Runtime container is **terminated and removed**; the `security.kill`
     record carries the cleanup outcome (`leaseRevoked`, `runtimeRemoved`).
  3. A replay of the now-revoked lease against the gateway data plane returns a
     **sanitized denial** (`LEASE_REVOKED`) with **zero** upstream provider
     calls.
  4. `GET /api/security/posture` lists the `security.kill` / `gateway.revoke`
     events under `recentEvents`; the `protectedAsset` statement is unchanged -
     **the provider credential is still absent everywhere.**

### Step 6 - Prove recovery (~20s)

- **Do:** submit one more safe orchestration on the `demo` Project (same task as
  Step 2).
- **Observe:** a **new** lease is issued, the pipeline completes, and
  `GET /api/runs/<run-id>/observability` shows a fresh trace with token usage.
  The platform is fully controllable again.

## What the audience should leave with

- The provider key never appeared in the Runtime, the workspace, an API
  response, a log, a trace, or the screen.
- Kill is revoke-first, idempotent, and reports its cleanup outcome.
- Denial invokes no provider and never falls back to a direct key.
- Recovery is a normal new Run, not a special path.

## Rehearsal acceptance (plan section 14, Task 17)

- Two consecutive rehearsals each complete in under three minutes.
- `bash scripts/secret-sweep.sh` is clean before and after both rehearsals.
- The data root is reset between rehearsals with the documented command only.
