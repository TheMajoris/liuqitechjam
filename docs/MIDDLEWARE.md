# Platform and Middleware Requirement Mapping

This document expands the requirement table in
[tasks/plan.md](../tasks/plan.md) section 13 into prose: for each requirement it
names the evidence that will demonstrate it and where that evidence will live.

## Primary challenge track

The submission enters **exactly one** primary track:
**Kill Switch** ([tasks/plan.md](../tasks/plan.md) section 2).

The Agent-specific problem: a compromised Agent Runtime reads or exfiltrates the
long-lived model-provider credential. The middleware answer is a dedicated
**model-gateway sidecar** that is the only holder of provider keys, plus a
gateway-only Runtime network and an **opaque, short-lived, run-scoped lease**.
When an operator invokes **Kill**, the control plane revokes the lease first,
then terminates and cleans up the Runtime, and a later safe Run proves recovery.

Queue orchestration, Agent-to-Agent handoff messages, structured logs, traces,
and token usage are **supporting evidence** for that boundary - they are not
separate tracks.

> **Status.** Only Task 0 (baseline freeze) and Task 1 (store v1 -> v2
> migration) are implemented. Every "will" / "planned" below tracks a task in
> [tasks/plan.md](../tasks/plan.md) section 14.

## Requirement-by-requirement

### Preserve the baseline

- **What proves it:** the existing Vitest suites (`store`, `app`,
  `agent-service`, `codex-runner`, `container-codex-runner`) stay green under
  `npm run check`; Agent CRUD, `start`/`stop`, the Playground
  `POST /api/agents/:id/messages` -> `202` path, Codex thread continuation, and
  workspace persistence still work by manual walkthrough.
- **Where it lives:** `apps/server/src/*.test.ts`; baseline capability map in
  [docs/DEVIATIONS.md](DEVIATIONS.md); manual journey in
  [agent-launchpad-challenge-context.md](../agent-launchpad-challenge-context.md)
  section 5.
- **Status:** enforced now; re-checked at every task and checkpoint.

### Real backend behavior

- **What proves it:** Fastify routes only validate transport and delegate;
  Project, orchestration, model-access, and telemetry logic sits in
  `apps/server/src/modules/**` deep modules with their own interface tests.
- **Where it lives:** `modules/projects/`, `modules/orchestration/`,
  `modules/model-access/`, `modules/telemetry/` plus `*.test.ts` beside each;
  route adapters in `app.ts`.
- **Status:** planned (Tasks 2, 5, 9-12, 16).

### Real Runtime behavior

- **What proves it:** container-argument unit tests assert the generated argv,
  env, and mounts contain **no** provider key; a local integration test shows
  the Runtime can reach the mock gateway but cannot reach a direct external
  endpoint; the Kill path actually stops and removes the container.
- **Where it lives:** `runtime/secretless-runner.ts`,
  `apps/server/src/container-codex-runner.ts` and its test; protected-network
  integration test; `docker-compose.yml` network definitions.
- **Status:** planned (Tasks 6, 8). Current gap recorded in
  [docs/DEVIATIONS.md](DEVIATIONS.md): the baseline runner passes
  `--env ARK_API_KEY` and uses `--network bridge`.

### Real data behavior

- **What proves it:** queue jobs, handoff messages, correlation ids, telemetry
  spans, token usage, and restart/recovery state are written to and read back
  from the JSON store (Database v2); migration tests prove v1 fixtures upgrade
  losslessly.
- **Where it lives:** `apps/server/src/store.ts`, `apps/server/src/types.ts`,
  `store.test.ts` (Task 1, done); populated by
  `modules/orchestration/**` and `modules/telemetry/**`.
- **Status:** schema + migration done; population planned (Tasks 2, 10-12).

### Real infrastructure behavior

- **What proves it:** the Runtime and the gateway run as separate processes with
  separate environments and separate networks; the Runtime's network can reach
  only the gateway; the gateway alone has provider egress.
- **Where it lives:** `apps/server/src/gateway/main.ts` (separate entry point),
  `gateway/config.ts` (only reader of provider keys), `docker-compose.yml` /
  [docs/LOCAL_POC.md](LOCAL_POC.md) network topology, `.env` split documented in
  [.env.example](../.env.example) (Gateway section).
- **Status:** planned (Tasks 3-4, 6-7).

### Defined ownership

- **What proves it:** each decision/event has one owner, the data that crosses
  each boundary is enumerated, and the failure mode of every component is
  written down.
- **Where it lives:** [docs/ARCHITECTURE.md](ARCHITECTURE.md) (component table,
  trust zones, deep modules); [tasks/plan.md](../tasks/plan.md) sections 4-11.
- **Status:** documented now; kept in sync as modules land.

### Success evidence

- **What proves it:** a real safe Run reaches the configured live provider
  through the gateway and records a complete correlated trace
  (`orchestration` -> `queue.wait` -> `stage.*` -> `runtime.*` -> `gateway.*`
  -> `provider.responses`) with duration and token usage.
- **Where it lives:** Run Inspector tabs (Overview / Trace / Logs / Usage /
  Security) in `apps/web/src/features/runs/`; `GET /api/runs/:id/observability`;
  one manual live smoke test (Task 7).
- **Status:** planned (Tasks 7, 11, 16).

### Abuse evidence

- **What proves it:** a controlled malicious Run searches for the provider key
  and tries to contact the provider directly; the key is absent from env and
  workspace, direct egress fails, and the attempt is recorded as a
  `security.deny` span.
- **Where it lives:** negative integration test; `security.deny` / `security.kill`
  telemetry; Security page "controlled-demo guide" in
  `apps/web/src/features/security/`.
- **Status:** planned (Task 8).

### Recovery evidence

- **What proves it:** after Kill + cleanup, a new safe Run obtains a fresh lease
  and completes successfully; the revoked lease still cannot invoke a provider.
- **Where it lives:** negative integration test + the controlled
  malicious/recovery demo ([docs/DEMO.md](DEMO.md) steps 5-6); Security page.
- **Status:** planned (Task 8).

### Automated verification

- **What proves it:** interface, integration, negative, cleanup, migration, and
  secret-sweep tests all run under `npm run check`; `scripts/secret-sweep.sh`
  scans the tree and generated telemetry for credential-shaped values.
- **Where it lives:** `*.test.ts` across server modules; `scripts/secret-sweep.sh`
  with `scripts/secret-sweep.allow`; [tasks/plan.md](../tasks/plan.md) section 15.
- **Status:** store/migration tests done; module tests + secret sweep in
  progress (sweep script added by Task 17 docs lane).

### Keep secrets out

- **What proves it:** Runtime environment allowlist (`MODEL_GATEWAY_URL`,
  `MODEL_GATEWAY_TOKEN`, `MODEL_ID`, `CODEX_HOME`, `HOME`, `PATH`, `LANG`,
  `NO_COLOR` only); provider config confined to the gateway process
  (`PROVIDER_*`, `MODEL_GATEWAY_ADMIN_TOKEN`); redaction before every persist and
  before logger output; repeated secret sweeps of source, config, and generated
  telemetry.
- **Where it lives:** `runtime/secretless-runner.ts` (allowlist),
  `gateway/config.ts`, `modules/telemetry/redactor.ts`,
  `scripts/secret-sweep.sh`, [.env.example](../.env.example),
  [SECURITY.md](../SECURITY.md).
- **Status:** planned (Tasks 2, 6); sweep script present.

### Small infrastructure

- **What proves it:** only Node processes, local containers, and the existing
  JSON store are used - no Redis, BullMQ, Temporal, Kafka, Postgres, or
  Kubernetes. The queue is an in-process worker over the JSON store.
- **Where it lives:** [tasks/plan.md](../tasks/plan.md) sections 2-3;
  `modules/orchestration/**`; `package.json` dependency list.
- **Status:** locked design decision; upheld by review.

## Evidence surfaces at a glance

| Surface | Purpose |
| --- | --- |
| `npm run check` | TypeScript, server tests, production builds - the phase gate. |
| `scripts/secret-sweep.sh` | Fails the build on any credential-shaped value in the tree or telemetry. |
| `GET /api/runs/:id/observability` | Correlated redacted spans, durations, safe error codes, token usage. |
| `GET /api/security/posture` | Protected asset statement, active controls, gateway status, recent denies/kills. |
| Run Inspector + Security Envelope (web) | Operator-facing view of Workspace -> Runtime -> Lease -> Gateway -> Provider state. |
| [docs/DEMO.md](DEMO.md) | Scripted three-minute normal + abuse + recovery walkthrough. |
