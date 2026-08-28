# Secretless Multi-Agent Control Plane MVP — Execution Checklist

> This checklist mirrors `tasks/plan.md`. The planning update is approved; do not change product code until the project owner explicitly authorizes implementation.

## Approval

- [ ] Project owner reviewed the revised `tasks/plan.md`.
- [ ] Project owner explicitly authorized product implementation.

## Phase A — Baseline, provider security, and model access

- [ ] **Task 0:** Prove baseline CRUD, lifecycle, Playground, follow-up, and persistence.
  - [ ] `npm run check` passes before changes.
  - [ ] Protected local container path is identified.
- [ ] **Task 1:** Add lossless database v1 → v2 migration and safe model-binding metadata.
  - [ ] Existing records and thread IDs remain unchanged.
  - [ ] Legacy bindings migrate to null; historical Runs are not silently retargeted.
  - [ ] Control-plane records cannot contain credentials, ciphertext, or gateway master keys.
- [ ] **Task 2:** Add redacting structured telemetry ledger.
  - [ ] Secret values and sensitive fields are redacted before persistence and logging.
  - [ ] Preview/record limits and stable ordering are tested.
- [ ] **Task 3:** Start the gateway with encrypted provider storage and deterministic mock.
  - [ ] Authenticated-encryption round trips, wrong-key/tag failure, key versioning, and atomic writes are tested.
  - [ ] Gateway-only store permissions and master-key isolation are verified.
  - [ ] Unknown providers and Runtime-supplied URLs fail closed.
- [ ] **Task 4:** Add authenticated provider onboarding and model discovery.
  - [ ] Provider mutations fail when control-plane authentication is disabled.
  - [ ] Preset and guarded custom HTTPS onboarding work without credential read-back.
  - [ ] SSRF, DNS rebinding, redirect, private-address, timeout, response-size, and rate-limit controls are tested.
  - [ ] Connection/discovery states, refresh, stale/removed models, and manual unverified fallback work.
  - [ ] Rotation/disable and gateway/control-plane reconciliation are covered.
- [ ] **Task 5:** Add opaque run-scoped leases.
  - [ ] Expired, wrong, mismatched, disabled-provider, and revoked leases are denied.
  - [ ] Denials result in zero upstream provider calls.
- [ ] **Task 6:** Add control-plane `ModelAccess` adapter.
  - [ ] Session cleanup runs on every terminal path.
  - [ ] Gateway outage has no direct-key fallback.
- [ ] **Task 7:** Make Runtime secretless and gateway-only.
  - [ ] Provider credentials/master key are absent from argv, environment, mounts, config, workspace, telemetry, and API.
  - [ ] Runtime reaches gateway but not arbitrary external endpoints.
  - [ ] Provider-managed Runs are unavailable through the ungoverned local-process path.
- [ ] **Task 8:** Add live provider execution and model-binding resolution.
  - [ ] Agent defaults and complete provider/model overrides resolve atomically and snapshot onto Runs.
  - [ ] Disabled/removed/mismatched bindings fail closed without fallback.
  - [ ] Binding changes start a new Codex session.
  - [ ] Codex → gateway → provider smoke test succeeds.

### Security checkpoint

- [ ] `npm run check` passes.
- [ ] Real safe Run succeeds through the gateway.
- [ ] Setup credential is transient/write-only and absent after submission from browser storage, API responses, logs, telemetry, JSON state, Runtime data, and screenshots.
- [ ] Gateway master key and provider credentials are absent from control-plane/Runtime environments, argv, mounts, and compose inspection.
- [ ] Gateway denial/outage fails closed.
- [ ] Project owner reviewed checkpoint.

## Phase B — Kill Switch and orchestration

- [ ] **Task 9:** Integrate revoke-first Kill, Runtime termination, cleanup, and recovery.
  - [ ] Revoked lease cannot invoke provider.
  - [ ] Runtime is removed and cleanup is visible.
  - [ ] Later safe Run succeeds.
- [ ] **Task 10:** Add Project CRUD, three role assignments, and Project-owned workspace.
  - [ ] Planner/Builder/Reviewer Agent IDs are distinct.
  - [ ] Project path containment and archive ownership are tested.
- [ ] **Task 11:** Add persisted FIFO orchestration admission.
  - [ ] `202` occurs only after durable admission and effective model-binding snapshots.
  - [ ] Sequence, idempotency, concurrency, and queue-limit tests pass.
- [ ] **Task 12:** Execute fixed Planner → Builder → Reviewer pipeline.
  - [ ] Planner/Reviewer are read-only; Builder is workspace-write.
  - [ ] Runs and handoff messages share correlation IDs.
  - [ ] One orchestration override applies to all stages; Agent defaults apply otherwise.
  - [ ] Failure/block/cancel prevents later stages.
- [ ] **Task 13:** Add locked retry matrix and restart reconciliation.
  - [ ] Only transient side-effect-safe failures retry once.
  - [ ] Builder never retries after process start.
  - [ ] Restart produces no duplicate stage completion or binding drift.

### Orchestration checkpoint

- [ ] Two orchestrations execute in strict FIFO order.
- [ ] Three assigned Agents collaborate against one Project workspace.
- [ ] Messages, Runs, attempts, model snapshots, and spans correlate correctly.
- [ ] Cancellation/retry/restart match the documented semantics.
- [ ] `npm run check` passes.

## Phase C — Operator and operational frontend

- [ ] **Task 14:** Add provider onboarding, model assignment, and Project catalog UI.
  - [ ] Preset-first wizard works for non-developers; advanced custom endpoint path is guarded.
  - [ ] Credentials are never prefilled, retained, echoed, or displayed after submission.
  - [ ] Discovery, refresh, manual/unverified models, rotation, disable, and explicit paid test states work.
  - [ ] Agent defaults, orchestration override, unavailable-model warnings, and new-session warning work.
- [ ] **Task 15:** Add Port-inspired app shell while preserving Playground.
  - [ ] Projects, Agents, Providers, Orchestrations, Runs, and Security are deep-linkable.
  - [ ] Keyboard, focus, contrast, reduced motion, and responsive checks pass.
- [ ] **Task 16:** Add Orchestrations, queue, handoff, and Kill UI.
  - [ ] UI derives status from backend state.
  - [ ] Kill reports revoke and cleanup outcome.
- [ ] **Task 17:** Add Run Inspector and Security Envelope.
  - [ ] Overview, Trace, Logs, Usage, and Security views are correlated and redacted.
  - [ ] Token usage, effective provider/model, and controlled denial evidence are visible.

## Phase D — Submission hardening

- [ ] **Task 18:** Complete docs, setup, secret sweep, and demo rehearsal.
  - [ ] README names Kill Switch as the only track and explains operator onboarding/model assignment.
  - [ ] Architecture, trust boundaries, transient secret ingress, encryption key operations, and framework seam are documented.
  - [ ] Clean local setup is reproducible.
  - [ ] Two consecutive demos finish under three minutes.

## Final definition of done

- [ ] Baseline acceptance journey passes unchanged.
- [ ] Operator can add a provider, discover or manually identify models, and bind Agents without editing environment files.
- [ ] Safe real-provider Run succeeds with the resolved model snapshot.
- [ ] Malicious Run is blocked/terminated and protected credential stays absent.
- [ ] Rotation/disable revokes access; Kill, cleanup, denial, and safe recovery are visible.
- [ ] Fixed multi-Agent queue, messages, traces, logs, usage, and provider/model assignment are functional.
- [ ] No full agent framework is required; future executors remain behind the documented seam.
- [ ] `npm run check` passes.
- [ ] No secret appears in source, control-plane config/state, logs, traces, browser storage/responses, screenshots, Runtime data, or demo output.
- [ ] Reviewer can reproduce the POC from repository documentation.
