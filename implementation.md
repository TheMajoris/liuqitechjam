# implementation.md — Governed Agent Portal (TikTok TechJam 2026, Track 1: Agent Launchpad)

> **Superseded:** this earlier Bouncer-oriented proposal is retained for history only. Do not implement it. The locked Kill Switch MVP plan is `tasks/plan.md`, with its execution checklist in `tasks/todo.md`.

> **Audience:** autonomous coding agents (Claude Code / Codex) and human reviewers.
> **Base repo:** https://github.com/RrankPyramid/CodeJam (Volc Agent Launchpad Starter Kit)
> **Team:** 5 university students, 3-day hackathon.
> **Read this file fully before writing any code. Follow phases in order. Do not skip acceptance gates.**

---

## 1. Mission

Build the **governance middleware** that turns the single-user Agent Launchpad POC into a multi-user, policy-governed Agent platform — conceptually "Port.io for Agents." Three capabilities, one coherent story:

1. **Identity & ownership** — mock users, server-side authorization, per-Agent ownership.
2. **Policy + approval boundary** — declarative rules; risky Runs pause in `pending_approval` until an admin approves or denies.
3. **Audit timeline** — every decision (authz, policy, approval, execution, redaction) recorded as an attributed event, queryable via API and visible as a per-Run timeline in the UI.

### Hard rules (from the hackathon spec — violating these fails the submission)

- **Preserve the baseline.** Existing single-flow behavior (Agent CRUD, Playground chat, persistence, Codex execution) must keep working. All middleware is additive.
- **Middleware must execute in the backend/Runtime path.** UI-only features do not count. A login screen without server-side enforcement does not count.
- **No secrets anywhere** — not in source, git history, logs, traces, screenshots, browser state, or demo output. `ARK_API_KEY` must never be persisted or returned by any API.
- **`npm run check` must pass** at every phase gate.
- **Local Docker/Colima/Podman is the judging path.** Do not spend effort on ECS.
- Mock users and mock resources are explicitly allowed and encouraged.

---

## 2. Starter Kit context (what already exists — do not rebuild)

- **Stack:** React + TypeScript web UI (`apps/web`), Fastify control plane (`apps/server`), JSON metadata store, per-Agent workspaces, Codex CLI runtime in disposable Docker/Colima/Podman containers, Volcengine Ark Responses API for the model.
- **Key seams (named by the spec as valid extension points):**
  - Fastify request boundary
  - `AgentService` (business logic / orchestration)
  - `AgentRunner` interface (execution boundary; two impls: local container, host process)
  - JSON persistence layer
- **Where to start reading code (from the official FAQ):** `apps/server/src/types.ts`, `apps/server/src/app.ts`, `apps/server/src/agent-service.ts`, the two `AgentRunner` implementations, then `apps/web/src/App.tsx` for the smallest UI integration point.
- **Run it:** `ARK_API_KEY=... ARK_MODEL=ep-... npm run poc` → http://localhost:3000. First run builds the Runtime image.
- **Validate:** `npm run check` (TypeScript checks, server tests, production builds).
- **Known gotcha:** `ARK_API_KEY` must be an **Ark model API key**, not a BytePlus account AK/SK; `ARK_MODEL` normally starts with `ep-`. Wrong credentials → `401 Unauthorized` from the Ark Responses API.
- State lives under `~/.volc-agent-launchpad/` (macOS) or `.local/` (Linux); override with `LOCAL_POC_DATA_ROOT`.

> **Agent instruction:** before Phase 1, open and read `docs/ARCHITECTURE.md`, `docs/HACKATHON_EXTENSION_GUIDE.md`, and `apps/server/src/types.ts` in the repo. Where this document's assumed file names differ from the actual code, **adapt to the actual code** and note the deviation in `docs/DEVIATIONS.md`.

---

## 3. Target architecture

```
Browser (React)
  │  session token (HMAC-signed, httpOnly-equivalent header)
  ▼
Fastify control plane
  ├─ authPlugin (preHandler): token → Principal on request context
  ├─ routes: /api/auth/*, /api/approvals/*, /api/audit/*  (new)
  │          /api/agents/*, /api/runs/*                   (existing, now authz-checked)
  ▼
AgentService (existing)
  ├─ ownership + role checks  ──► PolicyService (new, declarative rules)
  ├─ Run state machine: + pending_approval, denied states
  └─ emits events ──► EventBus (new) ──► AuditStore (append-only events.jsonl)
  ▼
AgentRunner boundary (existing interface)
  ├─ RunContext { runId, agentId, principal } threaded into execution
  └─ Redactor: strips ARK_API_KEY / token values from anything persisted or logged
  ▼
Disposable container → Codex CLI → Ark Responses API
```

**Design principles**

- One new directory `apps/server/src/middleware/` owns all new backend logic. Touch existing files minimally: register the auth plugin in `app.ts`, inject `PolicyService`/`EventBus` into `AgentService`, extend the Run state machine, extend `AgentRunner` call signature with an optional `RunContext`.
- Enforcement lives **server-side** (AgentService / route preHandlers). The UI only reflects decisions.
- Everything emits events. The audit trail is a side effect of the real code path, not a parallel bookkeeping system.
- **Backward compatibility switch:** if no session token is presented **and** `MIDDLEWARE_ENABLED=false` (default `true` in `.env.example`), behave exactly like the baseline (implicit `system` principal, no approval gating). This guarantees the baseline acceptance test still passes and gives a kill switch during the demo.

---

## 4. Contracts (implement exactly; extend only additively)

Create `apps/server/src/middleware/types.ts`:

```ts
// ---------- Identity ----------
export type Role = "developer" | "admin";

export interface User {
  id: string;           // "alice"
  displayName: string;  // "Alice Tan"
  role: Role;
  // NO passwords for MVP; login = user picker + server-issued signed token.
}

export interface Principal {
  kind: "user" | "agent" | "system";
  id: string;           // user id, agent id, or "system"
  role: Role | "agent" | "system";
  sessionId?: string;
}

// ---------- Policy ----------
export type PolicyAction =
  | "agent.create" | "agent.read" | "agent.update"
  | "agent.delete" | "agent.start" | "agent.stop"
  | "run.execute" | "run.approve" | "run.deny"
  | "audit.read";

export type PolicyEffect = "allow" | "deny" | "require_approval";

export interface PolicyRule {
  id: string;                       // "deny-non-owner-delete"
  description: string;
  action: PolicyAction;
  effect: PolicyEffect;
  // All specified conditions must match for the rule to apply:
  conditions?: {
    ownerOnly?: boolean;            // principal must own the target agent
    roles?: Role[];                 // principal role must be in list
    promptMatches?: string[];       // case-insensitive substrings/regex on task text
  };
  priority: number;                 // lower number = evaluated first; first match wins
}

export interface PolicyDecision {
  effect: PolicyEffect;
  ruleId: string | null;            // null => default effect
  reason: string;                   // human-readable, shown in UI + audit
}

// ---------- Runs (extends existing Run status union) ----------
export type GovernedRunStatus = "pending_approval" | "denied";
// Final union in types.ts becomes: existing statuses | GovernedRunStatus

export interface ApprovalRecord {
  runId: string;
  requestedBy: Principal;
  decidedBy?: Principal;
  decision?: "approved" | "denied";
  reason?: string;
  requestedAt: string;              // ISO 8601
  decidedAt?: string;
}

// ---------- Audit ----------
export type AuditEventType =
  | "auth.login" | "auth.denied"
  | "authz.allow" | "authz.deny"
  | "policy.decision"
  | "approval.requested" | "approval.approved" | "approval.denied"
  | "run.started" | "run.completed" | "run.failed"
  | "runtime.container_launched"
  | "secret.redacted"
  | "agent.created" | "agent.updated" | "agent.deleted";

export interface AuditEvent {
  id: string;                       // uuid
  ts: string;                       // ISO 8601
  type: AuditEventType;
  actor: Principal;
  agentId?: string;
  runId?: string;
  action?: PolicyAction;
  decision?: PolicyDecision;
  detail?: Record<string, unknown>; // MUST pass through Redactor before storage
}
```

### New/changed HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/auth/users` | none | List mock users for the login picker (no secrets in fixture). |
| POST | `/api/auth/login` | none | Body `{ userId }` → `{ token, user }`. Token = HMAC-SHA256 signed payload (`SESSION_SECRET` env, dev default ok). |
| GET | `/api/auth/me` | token | Return current `Principal`. |
| GET | `/api/approvals` | admin | List Runs in `pending_approval` with requesting principal + task preview. |
| POST | `/api/approvals/:runId/approve` | admin | Transition run → executing. Emits `approval.approved`. |
| POST | `/api/approvals/:runId/deny` | admin | Body `{ reason }`. Run → `denied`. Emits `approval.denied`. |
| GET | `/api/audit?runId=&agentId=&actor=&type=&limit=` | token (`audit.read`) | Query audit events, newest first, default limit 100. |
| *(existing)* | `/api/agents*`, run/message routes | token | Now pass through authz: list returns **only** owned agents for developers (admins see all); mutations require ownership or admin. |

Token transport: `Authorization: Bearer <token>` header. The web app stores it in memory (React state) — **not** localStorage — acceptable for a hackathon POC and avoids a whole class of demo-time bugs.

### Fixtures

`apps/server/fixtures/users.json`
```json
[
  { "id": "alice", "displayName": "Alice Tan",  "role": "developer" },
  { "id": "bob",   "displayName": "Bob Lim",    "role": "developer" },
  { "id": "carol", "displayName": "Carol Wong", "role": "admin" }
]
```

`apps/server/fixtures/policy.json` (initial ruleset — first match wins, ordered by `priority`)
```json
[
  { "id": "admin-approve-rights", "description": "Only admins may approve or deny runs",
    "action": "run.approve", "effect": "allow", "conditions": { "roles": ["admin"] }, "priority": 10 },
  { "id": "owner-only-delete", "description": "Only the owner (or admin) may delete an agent",
    "action": "agent.delete", "effect": "allow", "conditions": { "ownerOnly": true }, "priority": 20 },
  { "id": "risky-prompt-approval", "description": "Tasks touching networks, credentials, or deletion need approval",
    "action": "run.execute", "effect": "require_approval",
    "conditions": { "promptMatches": ["curl", "wget", "http://", "https://", "rm -rf", "api key", "token", "password", "credential"] },
    "priority": 30 },
  { "id": "default-run", "description": "Owner may run their own agent",
    "action": "run.execute", "effect": "allow", "conditions": { "ownerOnly": true }, "priority": 100 }
]
```
Default when no rule matches: `deny` for mutations, `allow` for reads on owned resources. Admins bypass `ownerOnly` (but **not** approval gates on `run.execute` — approvals apply to everyone, so the demo can show an admin's own risky run being gated too; document this choice).

### Data model changes

- `Agent` gains `ownerId: string` (default `"system"` for pre-existing agents — migration: on load, backfill missing `ownerId` to `"system"`).
- `Run` gains `principal?: Principal`, `approval?: ApprovalRecord`, and the two new statuses.
- New append-only file `events.jsonl` in the app data dir (same root as existing JSON store). One JSON object per line. No rewrites, no deletion.

---

## 5. Phased task plan

Each phase ends with a **gate**: all listed checks pass + `npm run check` green + baseline acceptance test still passes (create agent → Playground task → response → follow-up continues session → stop/start → workspace persists). **Do not begin the next phase until the gate passes.** Commit at every gate with message `phase-N: <summary>`.

### Phase 0 — Baseline & recon (≈2h)

1. Clone, install, run `npm run poc` with a valid Ark key; complete the baseline acceptance test manually.
2. Read the files listed in §2. Produce `docs/DEVIATIONS.md` mapping this spec's assumed paths/types to the real ones.
3. Add `.env.example` entries: `MIDDLEWARE_ENABLED=true`, `SESSION_SECRET=dev-only-change-me`.

**Gate:** baseline works locally; `npm run check` passes untouched.

### Phase 1 — Identity & ownership, end to end (Day 1)

Backend:
1. `middleware/types.ts` (contracts above), `middleware/redactor.ts` (pure function: deep-walks an object, replaces values of keys matching `/key|token|secret|password|authorization/i` and any occurrence of the live `ARK_API_KEY`/`SESSION_SECRET` values with `"[REDACTED]"`).
2. `middleware/auth.ts` — Fastify plugin: `/api/auth/*` routes, token issue/verify (HMAC), `preHandler` that sets `request.principal` (falls back to `system` principal when `MIDDLEWARE_ENABLED=false`).
3. `middleware/event-bus.ts` + `middleware/audit-store.ts` — typed emitter; every event passes through the Redactor, then appended to `events.jsonl`; `queryEvents(filter)` reads and filters.
4. Wire ownership: set `ownerId` on agent creation from `request.principal`; filter agent list by ownership for developers; enforce owner-or-admin on read/update/delete/start/stop inside `AgentService` (not just routes). Emit `authz.allow`/`authz.deny` + `agent.*` events.
5. `GET /api/audit` route (admin: all events; developer: only events where `actor.id === principal.id` or the event targets an agent they own).

Frontend:
6. Login screen: user picker (from `/api/auth/users`) → login → token in app state; show current user + logout in the header; attach `Authorization` header to all API calls; render 401/403 as a clear "Access denied" state, not a crash.

Tests (vitest, in server test suite):
7. `authz.test.ts` — Bob cannot read/update/delete/start Alice's agent (403) and Alice's agent is absent from Bob's list; Carol (admin) can read it. Negative tests are explicitly rewarded by the rubric.
8. `redactor.test.ts` — a payload containing the configured key value and a `token` field comes out fully redacted.

**Gate:** log in as Alice → create agent → Bob denied (403, and list-isolation) → both decisions visible via `GET /api/audit`. Baseline test passes with `MIDDLEWARE_ENABLED=false`.

### Phase 2 — Policy engine + approval flow + audit UI (Day 2)

Backend:
1. `middleware/policy-service.ts` — loads `fixtures/policy.json`, `evaluate(principal, action, target): PolicyDecision`; first-match-wins by priority; emits `policy.decision` for every evaluation.
2. Run path integration in `AgentService`: on task submission, evaluate `run.execute`. `allow` → existing flow. `deny` → run stored with status `denied` + reason (surface reason to UI). `require_approval` → status `pending_approval`, create `ApprovalRecord`, emit `approval.requested`; **do not launch the container yet**.
3. Approval routes (`/api/approvals*`): admin-gated via PolicyService (`run.approve`). Approve → resume the normal execution path with the original principal recorded; deny → `denied` + reason. Emit events.
4. `AgentRunner` boundary: extend the runner call with `RunContext { runId, agentId, principal }`; include it in `run.started` / `runtime.container_launched` events; ensure no context values leak into the workspace as plaintext secrets.

Frontend:
5. Approval inbox (visible to admin only): pending runs with requester, agent, task preview, Approve / Deny (+ reason) buttons.
6. Run timeline view: for the selected run, fetch `/api/audit?runId=` and render a vertical timeline (event type, actor, decision reason, timestamp). Link it from the Playground/run status area.
7. Requester UX: a run in `pending_approval` shows a clear "Waiting for approval" state that resolves live (poll every 2–3 s — no websockets needed); `denied` shows the reason.

Tests:
8. `policy.test.ts` — rule matching incl. priority order and default effects.
9. `approval.test.ts` — risky prompt → `pending_approval`; approve → executes (mock runner); deny → `denied` and runner **never invoked**.
10. Integration: full event sequence for an approved risky run appears in the audit store in order.

**Gate:** end-to-end in the browser: Alice submits `"curl https://example.com and summarize"` → pending → Carol approves in inbox → run executes with a real model response → timeline shows `policy.decision → approval.requested → approval.approved → run.started → run.completed`, all attributed. Deny path equally demonstrable.

### Phase 3 — Hardening, docs, demo (Day 3)

1. Error handling & cleanup: no unhandled rejections on the new paths; approval of an already-decided run → 409; audit writes are fire-and-forget but log failures to stderr.
2. **Secret sweep:** grep source + git history for key patterns; confirm `/api/*` responses never contain `ARK_API_KEY`/`SESSION_SECRET`; confirm `events.jsonl` is clean after a full demo rehearsal. Add `secret-sweep.test.ts` asserting the audit store contains no configured secret values after a simulated run.
3. `npm run check` green; fix all TS/build issues.
4. Docs:
   - `README.md` section "Governed Agent Portal middleware": what it adds, one-command startup, mock users table, documented limitations (mock identity, single-process JSON store, coarse prompt-matching policy, polling UI).
   - One-page architecture diagram (Mermaid in `docs/MIDDLEWARE.md`): middleware components, data flow, **trust boundary** (browser untrusted / Fastify+AgentService trusted / container semi-trusted), enforcement + instrumentation points.
   - Threat model table (reuse spec's categories): credential theft → redaction + no secret persistence; privilege escalation → server-side least-privilege policy + full actor attribution; cross-user access → ownership isolation + negative tests; runaway/risky execution → approval gate; sensitive trace capture → redaction before storage.
5. Demo dry runs until 2× consecutively under 3 minutes. **Code freeze after this — bug fixes only.**

**Gate = submission checklist:** reviewer can clone → `npm run poc` → login → full flow; middleware executes in backend path; `npm run check` passes; no secrets anywhere; README sufficient to reproduce.

---

## 6. Three-minute demo script (maps to the 6 required demo steps)

1. Login as **Alice** → create/select her Agent, lifecycle state visible. *(step 1)*
2. Normal Playground task (`"Create a TypeScript hello-world CLI and run it"`) → real model + file action. *(steps 2–3)*
3. Open the Run **timeline** → attributed events for that run. *(step 4: middleware evidence)*
4. Switch to **Bob** → attempt to open Alice's agent → denied; denial appears in audit. *(step 5: denial case)*
5. Back as Alice → risky task (`curl ...`) → **pending approval**; switch to **Carol** → approve in inbox → run executes; timeline shows the full decision chain. *(steps 4–5 reinforced)*
6. Show agent list, run states, and audit query still clean and controllable. *(step 6)*

---

## 7. Team ownership map (minimize merge conflicts)

| Person | Owns | Primary files |
|---|---|---|
| P1 | Identity/authz | `middleware/auth.ts`, AgentService authz hooks |
| P2 | Events/audit | `middleware/event-bus.ts`, `audit-store.ts`, `redactor.ts`, `/api/audit` |
| P3 | Frontend | `apps/web` (login, inbox, timeline, denied/pending states) |
| P4 | Runtime boundary + tests | `AgentRunner` context, all `*.test.ts` |
| P5 | Policy + docs/demo | `policy-service.ts`, fixtures, `docs/`, README, diagram, demo script |

Rules: contracts in `middleware/types.ts` change only by team agreement; every phase gate is a merged, green `main`; feature branches per person, PRs small.

---

## 8. Out of scope (do not build, even if tempted)

- Real OAuth/passwords, external identity providers.
- Scorecards / health checks (only if Phase 2 finishes a half-day early).
- ECS/cloud deployment, multi-region, websockets, databases.
- General-purpose policy language beyond the JSON ruleset above.
- Rebuilding any Starter Kit feature (React app, CRUD API, Playground, container launcher).

---

## 9. Evaluation alignment (why this scope)

| Rubric category | Weight | How this plan scores it |
|---|---|---|
| End-to-end middleware behavior | 40% | Authz, policy, approval, and audit all execute in the Fastify/AgentService/Runner path with functional evidence and failure/denial cases. |
| Technical design & integration | 25% | One additive middleware package on the spec's named seams; explicit contracts; trust-boundary diagram. |
| Verification & robustness | 20% | Negative authz tests, policy/approval tests, redaction + secret-sweep tests, error handling. |
| Demo & reproducibility | 15% | One-command startup, mock-user fixtures, scripted <3-min demo, documented limitations. |
