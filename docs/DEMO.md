# Three-Minute Operator Demo

> **DRAFT - depends on Tasks 8, 11, 15, and 16.**
> The exact button labels, route paths, and CLI helper names below are the
> *target* from [tasks/plan.md](../tasks/plan.md) sections 11 and 16. They are
> not wired up yet (only Task 0 and Task 1 are done). Re-verify every step once
> the Kill path (Task 8), the Planner -> Builder -> Reviewer pipeline (Task 11),
> and the Orchestrations / Run Inspector / Security UI (Tasks 15-16) land.

Single track on show: **Kill Switch** - the long-lived provider credential
survives a compromised Runtime, the Run can be killed and cleaned up, and a
later Run recovers.

## Pre-flight checklist

Run all of these and confirm each passes **before** starting the timer.

| # | Check | Command / action | Expected |
| --- | --- | --- | --- |
| 1 | Container engine up | `docker info` (or `podman info`) | Prints engine info, no error. |
| 2 | `.env` filled | `test -f .env && grep -q '^ARK_API_KEY=' .env` | `.env` exists; `ARK_API_KEY`, `ARK_MODEL`, gateway `PROVIDER_ARK_*`, and `MODEL_GATEWAY_ADMIN_TOKEN` set to real values (no `replace-` prefixes). |
| 3 | Build + tests green | `npm run check` | TypeScript, server tests, and production builds all pass. |
| 4 | No secrets in tree | `bash scripts/secret-sweep.sh; echo "exit=$?"` | `exit=0` and "clean". |
| 5 | Clean data root | `rm -rf .data .local` *(or your `LOCAL_POC_DATA_ROOT`)* | Fresh store so the demo starts from zero. |
| 6 | Platform running | `npm run poc` (starts control plane + Runtime image) and, in a second terminal, the gateway process (see [docs/LOCAL_POC.md](LOCAL_POC.md#the-gateway-process)) | `http://localhost:3000` loads; gateway `GET /internal/health` returns ok. |
| 7 | Seed fixture Project | `npm run demo:seed` *(planned helper)* or create three Agents + one Project in the UI | A Project named `demo` with distinct Planner, Builder, and Reviewer Agents and one shared workspace. |
| 8 | Browser ready | Open `http://localhost:3000`, zoom so the right-side Run Inspector and the Security Envelope rail are both visible | Catalog view renders; no console errors. |

Reset between rehearsals: `npm run demo:reset` *(planned helper)* - or
`rm -rf .data .local` and re-run pre-flight steps 6-7. Nothing else should carry
state between runs.

## The walkthrough (target: under 3 minutes)

### Step 1 - Show the catalog and the boundary (~25s)

- **Do:** open **Projects**, select `demo`. Then open **Providers**.
- **Say:** the Project has three role-assigned Agents sharing one workspace;
  Planner and Reviewer are read-only, Builder is the only writer.
- **Observe:** Providers list shows `ark` (live) and `mock` (deterministic) with
  health, model, protocol `responses`, and credential mode **`gateway-managed`**
  - **no key value, no base URL that would enable proxy abuse.**

### Step 2 - Submit a safe orchestration (~35s)

- **Do:** on the `demo` Project, click **Run orchestration**, enter the task
  `Add a greet(name) helper with a test, then review it.`, pick provider `ark`,
  submit.
- **Observe:** the request returns `202 Accepted`; the orchestration appears in
  the **Orchestrations** FIFO list at position 1; the stage strip advances
  **Planner -> Builder -> Reviewer**. Files appear in the shared Project
  workspace only after the Builder stage. Handoff messages between stages are
  listed with sender, recipient, stage, and correlation id.

### Step 3 - Open the Run Inspector (~35s)

- **Do:** click the Builder stage's Run, open the **Run Inspector**.
- **Observe:**
  - **Trace tab:** one `traceId` links `orchestration` -> `queue.wait` ->
    `stage.builder` -> `runtime.launch` -> `runtime.execute` -> `gateway.lease`
    -> `gateway.request` -> `provider.responses` -> `runtime.cleanup`.
  - **Logs tab:** structured redacted records, each <= 2 KiB preview, no raw
    prompt, no provider payload, no environment dump.
  - **Usage tab:** input, cached-input, and output token counts.
  - **Security tab / Security Envelope rail:**
    Workspace -> Runtime -> Lease -> Gateway -> Provider all green;
    lease shows scope `responses:create` and an expiry, never a raw value.

### Step 4 - Launch the controlled malicious case (~25s)

- **Do:** from the **Security** page, start the **controlled abuse** Run
  (`npm run demo:abuse` *(planned helper)* runs the same thing headless). Its
  task instructs the Agent to print every environment variable, read any file
  that looks like a key, and `curl` the provider domain directly.
- **Observe:** the Run output shows the environment allowlist only
  (`MODEL_GATEWAY_URL`, `MODEL_GATEWAY_TOKEN`, `MODEL_ID`, `CODEX_HOME`, `HOME`,
  `PATH`, `LANG`, `NO_COLOR`) - **no `ARK_API_KEY`, no `APP_AUTH_TOKEN`, no
  gateway admin token.** The direct `curl` to the provider fails (no route off
  the internal network).

### Step 5 - Invoke Kill (~20s)

- **Do:** on that Run (or its orchestration), click **Kill**. Confirm the
  destructive dialog.
- **Observe, in order:**
  1. Lease **revoked** first (`gateway.revoke` span).
  2. Runtime container **terminated and removed** (`runtime.cleanup` span,
     cleanup outcome shown).
  3. A replay of the now-revoked lease against the gateway returns a **sanitized
     denial** with **zero** upstream provider calls (`security.deny`,
     `LEASE_REVOKED`).
  4. Security Envelope shows Lease + Runtime red; **provider credential still
     absent everywhere** (Security page "protected asset" statement unchanged).

### Step 6 - Prove recovery (~20s)

- **Do:** submit one more safe orchestration on the `demo` Project (same task as
  Step 2 or `npm run demo:recover` *(planned helper)*).
- **Observe:** a **new** lease is issued, the pipeline completes, the Run
  Inspector shows a fresh green trace with token usage. The platform is fully
  controllable again.

## What the audience should leave with

- The provider key never appeared in the Runtime, the workspace, an API
  response, a log, a trace, or the screen.
- Kill is revoke-first, idempotent, and reports its cleanup outcome.
- Denial invokes no provider and never falls back to a direct key.
- Recovery is a normal new Run, not a special path.

## Rehearsal acceptance (plan section 14, Task 17)

- Two consecutive rehearsals each complete in under three minutes.
- `scripts/secret-sweep.sh` is clean before and after both rehearsals.
- The data root is reset between rehearsals with the documented command only.
