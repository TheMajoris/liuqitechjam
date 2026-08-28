# Secretless Multi-Agent Control Plane MVP — Execution Checklist

> This checklist mirrors `tasks/plan.md`. Do not begin until the project owner explicitly approves implementation.

## Approval

- [x] Project owner reviewed `tasks/plan.md`.
- [x] Project owner explicitly authorized implementation.

## Phase A — Baseline and security foundation

- [x] **Task 0:** Prove baseline CRUD, lifecycle, Playground, follow-up, and persistence.
  - [x] `npm run check` passes before changes.
  - [x] Protected local container path is identified.
- [x] **Task 1:** Add lossless database v1 → v2 migration.
  - [x] Existing records and thread IDs remain unchanged.
  - [x] Corrupt/unsupported data is not overwritten.
- [x] **Task 2:** Add redacting structured telemetry ledger.
  - [x] Secret values and sensitive fields are redacted.
  - [x] Preview/record limits and stable ordering are tested.
- [x] **Task 3:** Start gateway sidecar with deterministic mock provider.
  - [x] Unknown providers and arbitrary URLs fail closed.
  - [x] Mock output and token usage are deterministic.
- [x] **Task 4:** Add opaque run-scoped leases.
  - [x] Expired, wrong, mismatched, and revoked leases are denied.
  - [x] Denials result in zero upstream provider calls.
- [x] **Task 5:** Add control-plane `ModelAccess` adapter.
  - [x] Session cleanup runs on every terminal path.
  - [x] Gateway outage has no direct-key fallback.
- [x] **Task 6:** Make Runtime secretless and gateway-only.
  - [x] Provider credentials are absent from argv, environment, mounts, config, workspace, telemetry, and API.
  - [~] Runtime reaches gateway but not arbitrary external endpoints. _(unit + compose topology; live network test deferred to security checkpoint — see docs/DEVIATIONS.md)_
- [x] **Task 7:** Add one live Responses-compatible provider.
  - [x] Only gateway process reads provider credential.
  - [~] Codex → gateway → provider smoke test succeeds. _(owner-run at security checkpoint — see docs/DEVIATIONS.md)_

### Security checkpoint

- [ ] `npm run check` passes.
- [ ] Real safe Run succeeds through gateway.
- [ ] Gateway denial/outage fails closed.
- [ ] Secret sweep is clean.
- [ ] Project owner reviewed checkpoint.

## Phase B — Kill Switch and orchestration

- [x] **Task 8:** Integrate revoke-first Kill, Runtime termination, cleanup, and recovery.
  - [x] Revoked lease cannot invoke provider. _(gateway denies revoked lease — Task 4 tests; SecretlessRunner revoke-first — secretless-runner.test.ts)_
  - [x] Runtime is removed and cleanup is visible. _(SecretlessRunner `onKill` reports `leaseRevoked` + `runtimeRemoved`)_
  - [x] Later safe Run succeeds. _(agent-service.test.ts "kills an active run, then recovers")_
- [x] **Task 9:** Add Project CRUD, three role assignments, and Project-owned workspace.
  - [x] Planner/Builder/Reviewer Agent IDs are distinct. _(project-service.test.ts, 422 on non-distinct/unknown)_
  - [x] Project path containment and archive ownership are tested. _(resolveWithin traversal + archive tests)_
- [x] **Task 10:** Add persisted FIFO orchestration admission.
  - [x] `202` occurs only after durable admission. _(route returns 202 after one atomic store.mutate)_
  - [x] Sequence, idempotency, concurrency, and queue-limit tests pass. _(orchestration-control.test.ts)_
- [x] **Task 11:** Execute fixed Planner → Builder → Reviewer pipeline.
  - [x] Planner/Reviewer are read-only; Builder is workspace-write. _(sandboxMode assertion in fixed-pipeline.test.ts)_
  - [x] Runs and handoff messages share correlation IDs. _(traceId shared across stage runs + handoffs)_
  - [x] Failure/block/cancel prevents later stages. _(blocked-stages + cancel tests)_
- [x] **Task 12:** Add locked retry matrix and restart reconciliation.
  - [x] Only transient side-effect-safe failures retry once. _(retry-policy.test.ts table)_
  - [x] Builder never retries after process start. _(POST_START classification test)_
  - [x] Restart produces no duplicate stage completion. _(reconcileAfterRestart + duplicate-completion guard)_

### Orchestration checkpoint

- [x] Two orchestrations execute in strict FIFO order. _(fixed-pipeline.test.ts FIFO test)_
- [~] Three assigned Agents collaborate against one Project workspace. _(unit-proven with a fake runner; live multi-agent run is owner-run)_
- [x] Messages, Runs, attempts, and spans correlate correctly. _(shared traceId; attempt on stage runs)_
- [x] Cancellation/retry/restart match the documented semantics.
- [x] `npm run check` passes. _(140 tests)_

## Phase C — Operational frontend

- [ ] **Task 13:** Add provider and Project catalog views end to end.
  - [ ] Safe descriptors only; no credentials or leases.
  - [ ] Loading, empty, error, and degraded states work.
- [ ] **Task 14:** Add Port-inspired app shell while preserving Playground.
  - [ ] Projects, Agents, Providers, Orchestrations, Runs, and Security are deep-linkable.
  - [ ] Keyboard, focus, contrast, reduced motion, and responsive checks pass.
- [ ] **Task 15:** Add Orchestrations, queue, handoff, and Kill UI.
  - [ ] UI derives status from backend state.
  - [ ] Kill reports revoke and cleanup outcome.
- [ ] **Task 16:** Add Run Inspector and Security Envelope.
  - [ ] Overview, Trace, Logs, Usage, and Security views are correlated and redacted.
  - [ ] Token usage and controlled denial evidence are visible.

## Phase D — Submission hardening

- [ ] **Task 17:** Complete docs, setup, secret sweep, and demo rehearsal.
  - [ ] README names Kill Switch as the only track.
  - [ ] Architecture and trust boundaries are documented.
  - [ ] Clean local setup is reproducible.
  - [ ] Two consecutive demos finish under three minutes.

## Final definition of done

- [ ] Baseline acceptance journey passes unchanged.
- [ ] Safe real-provider Run succeeds.
- [ ] Malicious Run is blocked/terminated and protected credential stays absent.
- [ ] Revoke, cleanup, denial, and safe recovery are visible.
- [ ] Fixed multi-Agent queue, messages, traces, logs, and usage are functional.
- [ ] `npm run check` passes.
- [ ] No secret appears in source, config, state, logs, traces, browser data, screenshots, or demo output.
- [ ] Reviewer can reproduce the POC from repository documentation.
