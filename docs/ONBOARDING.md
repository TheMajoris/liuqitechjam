# Onboarding: new developer starts here

This fork of the Volc Agent Launchpad enters the hackathon under **one track:
Kill Switch**. It protects the long-lived model-provider credential from a
compromised Agent Runtime, and proves a Run can be killed, contained, and
recovered. See [tasks/plan.md](../tasks/plan.md) for the canonical plan and
[docs/ARCHITECTURE.md](ARCHITECTURE.md) for the target design.

Backend Tasks 0-16 are implemented and committed. The frontend (`apps/web/`) is
being reworked in parallel - coordinate before touching it.

## 5-minute quickstart

```bash
git clone <repository-url> liuqitechjam
cd liuqitechjam
npm install
cp .env.example .env
npm run dev
```

- Web UI: <http://localhost:5173>
- Control plane API: <http://localhost:3000>

`npm run dev` runs the control plane with the **host-process** Codex runner
(`RUNTIME_PROVIDER=local-process`) - no containers, no gateway. It is enough for
UI work and API work. For a real model turn on this path, install the Codex CLI
on the host:

```bash
npm install --global @openai/codex@0.111.0
```

### The container / secretless path (two processes)

This is the path the Kill Switch story runs on. It needs a container engine
(Docker, Colima, or rootless Podman) and two terminals.

```bash
# terminal 1 - trusted model-gateway sidecar (the only holder of provider keys)
set -a; . ./.env; set +a
npm run gateway -w @launchpad/server
# serves MODEL_GATEWAY_HOST:MODEL_GATEWAY_PORT (default 127.0.0.1:4000)
curl -fsS http://127.0.0.1:4000/internal/health

# terminal 2 - control plane + disposable Runtime containers
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
# http://localhost:3000
```

> `npm run gateway` is defined in `apps/server/package.json`, not the repo root,
> so run it with `-w @launchpad/server` (or from `apps/server/`). `gateway:dev`
> is the same process with file-watch reload.

The **secretless profile** activates only when both are true:

- `RUNTIME_PROVIDER=container` - `npm run poc` forces this.
- `MODEL_GATEWAY_ADMIN_TOKEN` is set in the control plane's environment - export
  it yourself (the `set -a; . ./.env; set +a` line above does this) together
  with the gateway `PROVIDER_*` variables.

If `MODEL_GATEWAY_ADMIN_TOKEN` is missing, the container runner falls back to
injecting `ARK_API_KEY` directly into the Runtime - the exact gap this MVP
closes ([docs/DEVIATIONS.md](DEVIATIONS.md)).

See [docs/LOCAL_POC.md](LOCAL_POC.md) for engine selection, state directories,
and rootless Podman.

## How the pieces fit

The **control plane** (`apps/server/src/index.ts`, Fastify) owns domain state,
the JSON store, the FIFO orchestration queue, and the gateway management client.
It never reads a provider key in the secretless profile. The **gateway sidecar**
(`apps/server/src/gateway/main.ts`, a separate process) is the only holder of
provider credentials: it issues opaque run-scoped leases, validates them on
every call, injects the real key, forwards to the provider, and returns a
sanitized response. Each Agent turn executes in a **disposable Runtime**
container that receives only a lease plus a gateway URL, on a network that can
reach the gateway and nothing else. When an operator invokes Kill, the control
plane revokes the lease first, then terminates and removes the Runtime.

Full component table, trust zones, and data flow: [docs/ARCHITECTURE.md](ARCHITECTURE.md).

## Repo map

### Top-level

| Path | Purpose |
| --- | --- |
| `apps/` | npm workspaces root. |
| `apps/server/` | Fastify control plane, the gateway sidecar, domain modules, Runtime adapters, all server tests. |
| `apps/web/` | React + TypeScript operator console (Vite). Frontend rework in progress - do not edit without coordinating. |
| `docs/` | Architecture, this onboarding page, demo script, deployment, local POC, middleware mapping, deviations. |
| `scripts/` | `start-local-poc.sh`, `secret-sweep.sh`, `security-checkpoint.sh`, `bootstrap-local.sh`, inherited `deploy-*.sh`. |
| `tasks/` | `plan.md` - the canonical, design-locked implementation plan. |
| `deploy/` | Inherited Volcengine ECS Terraform (`deploy/volcengine/*.tf`). Out of scope for the Kill Switch MVP - see [docs/DEPLOYMENT.md](DEPLOYMENT.md). |
| `docker-compose.yml` | Two-network local topology (`control-plane` + internal-only `runtime-gateway`). |
| `Dockerfile` / `Dockerfile.runtime` | Application image / disposable Runtime image. |
| `.env.example` | Every environment variable, grouped and commented, with `[baseline]` / `[planned]` markers. |
| `agent-launchpad-challenge-context.md` | The challenge brief. |
| `implementation.md` | Superseded early proposal - kept for history; `tasks/plan.md` wins. |

### `apps/server/src/` (baseline files)

| Path | Purpose |
| --- | --- |
| `app.ts` | Fastify composition, baseline routes, optional `AppModules` wiring, error handler. |
| `index.ts` | Control-plane composition root: constructs the store, ledger, provider directory, runner, services, pipeline, and app. |
| `agent-service.ts` | Agent CRUD, lifecycle (`start`/`stop`), Playground `sendMessage`, Run persistence, cancel/kill. |
| `config.ts` | Control-plane env schema, `isSecretlessProfile`, Codex `config.toml` writers (baseline and gateway). |
| `store.ts` | `JsonStore` with one atomic `mutate()` path; lossless v1 -> v2 migration. |
| `types.ts` | Baseline + v2 domain record types and correlation fields. |
| `workspace.ts` | Per-Agent workspace directory management. |
| `codex-runner.ts` | Host-process Codex runner (ungoverned developer fallback). |
| `container-codex-runner.ts` | Disposable per-turn container runner; secretless branch omits the provider key and stays gateway-only. |
| `runner-factory.ts` | Composition-root adapter selection: host-process, plain container, or `SecretlessRunner`. |
| `errors.ts` | `HttpError` and shared error helpers. |

### `apps/server/src/modules/*`

| Path | Purpose |
| --- | --- |
| `modules/projects/` | `ProjectService` CRUD, three distinct role assignments (planner/builder/reviewer), Project-owned shared workspace with path containment and archive (`project-workspace.ts`), `project-routes.ts`. |
| `modules/orchestration/` | `OrchestrationControl` (persisted FIFO admission, idempotency, monotonic sequence, queue limit, one global atomic claim, restart reconciliation, cancel), `FixedPipeline` (Planner -> Builder -> Reviewer state machine, role sandboxes, correlated handoffs), `retry-policy.ts` (locked retry matrix + backoff), `orchestration-routes.ts`. |
| `modules/model-access/` | `GatewayModelAccess.withSession` - lease issue/use/revoke with guaranteed `finally` cleanup and fail-closed errors; `HttpGatewayManagementClient` - management HTTP client with fail-closed status mapping and request timeout. |
| `modules/telemetry/` | `redactor.ts` (pre-persistence redaction: sensitive key names, configured secret values, `Bearer` / `glease_` / `sk-` tokens, depth cap, byte cap), `TelemetryLedger` (structured `append` / `inspectRun`, 2 KiB preview cap, 500 records per Run, `(startedAt, sequence)` ordering, usage aggregation), `telemetry-routes.ts` (`/api/providers`, `/api/runs/:id/observability`, `/api/security/posture`). |
| `modules/providers/` | `ProviderDirectory` - config-derived safe provider descriptors for `GET /api/providers`: id, `protocol: "responses"`, models, `credentialMode: "gateway-managed"`, health, `live`. No base URL, no key-env name, no credential value. |

### `apps/server/src/gateway/` (separate sidecar process)

| Path | Purpose |
| --- | --- |
| `gateway/main.ts` | Gateway composition root and entry point (`npm run gateway`). |
| `gateway/app.ts` | Management API (`/internal/leases`, `/internal/leases/:id/revocations`, `/internal/health`) and the Runtime data plane (`POST /p/:providerId/v1/responses`). |
| `gateway/config.ts` | The **only** module allowed to read provider credential values. Parses `GATEWAY_PROVIDERS` and `PROVIDER_<ID>_*`. |
| `gateway/lease-registry.ts` | In-memory hashed opaque lease store; TTL default 900s, max 3600s; scope/expiry/revocation checks. |
| `gateway/provider-catalog.ts` | Allowlist resolution: known provider ids and their permitted models. |
| `gateway/providers/deterministic-mock-provider.ts` | Reproducible Responses-compatible mock (no credential). |
| `gateway/providers/responses-http-provider.ts` | Live Responses-compatible HTTP adapter; maps upstream status to safe codes without leaking the body or key. |

### `apps/server/src/runtime/`

| Path | Purpose |
| --- | --- |
| `runtime/secretless-runner.ts` | The protected Runtime seam. Per turn: acquire a run-scoped lease, write a run-scoped gateway Codex home, hand the inner container runner the lease (never a key), revoke in `finally`. Kill is revoke-first with an `onKill` outcome hook. Fails closed - the inner runner never starts without a lease. |

## The dev loop

Before every commit:

```bash
npm run check                 # typecheck + test + build (the phase gate)
bash scripts/secret-sweep.sh  # must print "secret-sweep: clean" and exit 0
```

When a container engine is available, run the live Kill Switch boundary proof:

```bash
bash scripts/security-checkpoint.sh
```

It builds the app image, starts the gateway on an isolated network with the mock
provider, proves a Runtime-network container can reach the gateway but not the
public internet, and asserts a generated secretless container invocation names
no provider key. Record sign-off in [docs/DEVIATIONS.md](DEVIATIONS.md).

### What each test suite covers

Run from the repo root with `npm test`, or `npm run test -w @launchpad/server`.

| Suite | Covers |
| --- | --- |
| `store.test.ts` | v1 -> v2 migration losslessness and determinism, corrupt / invalid-JSON file guard, `JsonStore.mutate` atomicity (no in-memory publish when persistence fails). |
| `app.test.ts` | HTTP boundary: shared-token auth on `/api/*`, Fastify client-error status passthrough. |
| `agent-service.test.ts` | Agent CRUD and lifecycle, Playground conversation persistence, one concurrent Run per Agent, kill-an-active-Run-then-recover, `start` cannot reset a busy Agent. |
| `codex-runner.test.ts` | Host-process Codex runner argv and thread resume. |
| `container-codex-runner.test.ts` | Container argv/env: isolated invocation, thread resume in the mounted workspace, secretless turn omits the provider key and stays gateway-only. |
| `runner-factory.test.ts` | Adapter selection: host-process outside container mode, plain container with no gateway-admin token, `SecretlessRunner` when the profile is active. |
| `runtime/secretless-runner.test.ts` | Lease issue -> wire inner runner -> revoke -> cleanup; fail-closed (inner runner never starts) when no lease can be issued. |
| `modules/model-access/model-access.test.ts` | `withSession` issue/use/revoke, revoke on thrown callback, result still returned when revoke fails, fail-closed `GATEWAY_UNAVAILABLE`, `LEASE_REQUEST_REJECTED` on deterministic 4xx, one session per run, idempotent `revoke`. |
| `modules/model-access/gateway-client.test.ts` | Management HTTP contract: admin bearer, 4xx -> `LEASE_REQUEST_REJECTED`, 5xx / transport failure / malformed body -> `GATEWAY_UNAVAILABLE`, request timeout, 404 revoke treated as already-gone. |
| `modules/telemetry/redactor.test.ts` | Redaction by sensitive key name (case-insensitive, substring), configured secret values as substrings, `Bearer` / `glease_` / `sk-` tokens in free text, depth-8 truncation, byte-cap without splitting a multibyte character, plain-string vs JSON preview. |
| `modules/telemetry/telemetry-ledger.test.ts` | `(startedAt, sequence)` ordering, 500-records-per-Run cap, 2048-byte preview cap, usage aggregation across `provider.responses` spans only, totals / errors / denials counts, persistence through `store.mutate`. |
| `modules/telemetry/telemetry-routes.test.ts` | `/api/providers` safe descriptors only, `/api/runs/:id/observability` ordered spans + usage + counts, `/api/security/posture` protected-asset statement and recent events. |
| `modules/orchestration/orchestration-control.test.ts` | Enqueue persistence + monotonic sequence, idempotency-key replay, distinct sequences under concurrency, `429` at the queue-depth limit, unknown project, `claimNext` claims exactly the lowest-sequence job one at a time, restart reconciliation fails the interrupted job and frees its Agent, `cancel` moves queued work to a terminal state. |
| `modules/orchestration/fixed-pipeline.test.ts` | Planner -> Builder -> Reviewer with correct sandboxes and correlated records, later stages blocked on planner failure, no stage after cancellation, FIFO across orchestrations, one transient planner retry, no builder retry after process start, redacted per-stage spans, cancelled stage recorded once. |
| `modules/orchestration/retry-policy.test.ts` | Table-driven retry matrix and backoff (pre-launch retries once; builder post-start never retries; security denials never retry). |
| `modules/projects/project-service.test.ts` | Contained workspace creation, three-distinct-existing-Agents rule, archive moves the workspace out of the active root, path-traversal containment. |
| `gateway/app.test.ts` | Health safe descriptors, admin token required to issue, unknown provider / disallowed model rejected, idempotent revoke, deterministic mock output, provider invoked exactly once on the happy path, every deny path (`LEASE_INVALID` / `LEASE_EXPIRED` / `LEASE_REVOKED` / `LEASE_SCOPE_MISMATCH` / `PROVIDER_NOT_FOUND`) with zero provider calls, admin token / provider key / raw lease kept out of logs and bodies. |
| `gateway/lease-registry.test.ts` | Prefixed opaque token, TTL clamp (900s default, 3600s max), expired / revoked / malformed / scope-mismatch denials, idempotent revoke by id or token, raw token and hash never exposed, `sweepExpired`. |
| `gateway/providers/deterministic-mock-provider.test.ts` | Identical output + usage for identical input, output changes with input, deterministic flattening of structured input, pre-aborted signal rejected. |
| `gateway/providers/responses-http-provider.test.ts` | Mocked-`fetch` contract, upstream status -> safe code mapping, no body or key leak on error. |

## Where to make a change

| Change | Where |
| --- | --- |
| **Add a provider** | Gateway configuration only. Append the id to `GATEWAY_PROVIDERS` and add a `PROVIDER_<ID>_PROTOCOL` (`responses-http` or `mock`), `PROVIDER_<ID>_MODELS`, and for `responses-http` a `PROVIDER_<ID>_BASE_URL` + `PROVIDER_<ID>_KEY_ENV` (naming the env var that holds the key). Restart the gateway. Point the control plane at it with `RUNTIME_PROVIDER_ID`. No application code changes. |
| **Add an API route** | Create or extend a module under `apps/server/src/modules/<area>/`, add a `register<Area>Routes(app, deps)` adapter (the module imports Fastify only here), extend `AppModules` in `apps/server/src/app.ts`, and construct the dependency in `apps/server/src/index.ts`. Validate transport with Zod; keep the `{ "error": string }` error shape. |
| **Add a pipeline stage rule** | `apps/server/src/modules/orchestration/fixed-pipeline.ts` for stage order and role sandbox; `apps/server/src/modules/orchestration/retry-policy.ts` for the retry matrix. The three-stage topology itself is design-locked (plan section 19) - changing it reopens planning. |
| **Add a UI page** | `apps/web/src/features/<feature>/` owns its views, hooks, types, and tests; register the destination in `apps/web/src/app/`. `shared/` is only for code used by two or more features. Frontend rework in progress - coordinate first. |

## Glossary

| Term | Meaning |
| --- | --- |
| **Lease** | An opaque, short-lived, run-scoped bearer token the gateway issues. Bound to run, Agent, provider, model, scope (`responses:create`), and expiry. The Runtime presents it as `Authorization: Bearer <lease>`. The raw value is never persisted; the gateway keeps only a hash + metadata in memory. |
| **Gateway** | The trusted model-gateway sidecar - a separate process (`apps/server/src/gateway/`). The only holder of provider credentials. Validates leases, injects the real key, forwards to the provider, returns a sanitized response. |
| **Secretless profile** | The protected run mode: `RUNTIME_PROVIDER=container` **and** `MODEL_GATEWAY_ADMIN_TOKEN` set. In it the control plane and the Runtime never see a provider key. `isSecretlessProfile()` in `config.ts`. |
| **Orchestration** | One submitted task that runs the fixed Planner -> Builder -> Reviewer pipeline against a Project's shared workspace. Admitted to a persisted global FIFO queue; returns `202 Accepted` only after it is durably stored. |
| **Stage** | One step of the pipeline - `planner`, `builder`, or `reviewer`. Each stage produces an ordinary Agent Run. Planner and Reviewer get a read-only sandbox; Builder alone is workspace-write. |
| **Handoff** | A persisted, correlated message passed between stages (sender, recipient, stage, correlation ids, bounded redacted content). Not raw chain-of-thought. Large artifacts move through the shared workspace, not the message. |
| **Trace** | One `traceId` correlating every record for a Run or orchestration: `orchestration` -> `queue.wait` -> `stage.*` -> `runtime.*` -> `gateway.*` -> `provider.responses`, plus `security.deny` / `security.kill`. Read via `GET /api/runs/:id/observability`. |
| **Security Envelope** | The operator-facing rail showing Workspace -> Runtime -> Lease -> Gateway -> Provider state for a Run (web UI, in rework). Its data comes from telemetry and `GET /api/security/posture`. |
| **Kill** | The revoke-first containment action. The control plane revokes the active lease at the gateway, then terminates and removes the Runtime container, then records the cleanup outcome. Idempotent. A replay of the revoked lease returns a sanitized denial with zero upstream provider calls. For a Playground Run it is `POST /api/agents/:id/stop`; for an orchestration, `POST /api/orchestrations/:id/cancellations`. |

## Common pitfalls

- **NodeNext `.js` import suffixes.** The server is NodeNext ESM: import sibling
  modules as `./config.js` even though the file on disk is `config.ts`. A
  missing or wrong suffix fails `typecheck`.
- **`exactOptionalPropertyTypes` is on.** You cannot pass `undefined` for an
  optional property. Build objects with conditional spreads:
  `...(x !== undefined ? { x } : {})`. This pattern is everywhere in
  `runner-factory.ts`, `secretless-runner.ts`, and the route modules - follow it.
- **The gateway is a separate process.** Nothing under `apps/server/src/gateway/`
  may import Project, orchestration, telemetry, or browser modules. The only
  contact between the control plane and the gateway is HTTP over
  `MODEL_GATEWAY_URL`.
- **The secretless profile is opt-in.** It activates only when
  `RUNTIME_PROVIDER=container` **and** `MODEL_GATEWAY_ADMIN_TOKEN` is set in the
  control plane's environment. Otherwise you silently get the plain container
  runner (which injects `ARK_API_KEY`) or the host-process fallback - and the
  Kill Switch guarantees do not apply.

## Related documents

- [docs/ARCHITECTURE.md](ARCHITECTURE.md) - components, trust zones, data flow, invariants.
- [docs/LOCAL_POC.md](LOCAL_POC.md) - local run details, engines, state directories.
- [docs/DEMO.md](DEMO.md) - the three-minute operator demo.
- [docs/MIDDLEWARE.md](MIDDLEWARE.md) - platform/middleware requirement mapping.
- [docs/DEVIATIONS.md](DEVIATIONS.md) - frozen baseline record and recorded deviations.
- [docs/DEPLOYMENT.md](DEPLOYMENT.md) - supported deployment path and what is out of scope.
- [CONTRIBUTING.md](../CONTRIBUTING.md) - validate steps and commit conventions.
- [.env.example](../.env.example) - every environment variable.
