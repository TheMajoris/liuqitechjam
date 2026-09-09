# Workspace source checkpoints and "restore after a turn"

A Team edits one shared Project workspace. When the third Agent overwrites the
second Agent's work and crashes, the operator used to have two choices: retry
against the damaged files, or start over. Workspace checkpoints give a third:
**"Restore after Builder and resume"** puts the source files back to exactly
what they were when the Builder finished, then resumes the remaining
participants from that same logical point, with fresh Agent context.

This document describes what ships, the invariants it holds, and what it does
not do. It complements the README, which covers the surrounding platform.

## What is captured

- A **baseline** checkpoint before every execution cycle (start, continue,
  retry, and resume), so the "before" state is never lost.
- A **turn checkpoint** after every successful Agent turn, taken while the
  Project write lease is still held by that turn. Nothing else can be writing.
- A **safety** checkpoint immediately before any restore, so a restore is
  itself reversible ("Restore safety checkpoint").

Each checkpoint stores two things atomically: a Git commit in a private bare
repository, and a `CheckpointResumeState` record with the exact engine
continuation (roster, next step index, prior turns, accepted context).
A checkpoint becomes `ready` only after both exist and validate. A record that
is missing either half is `failed`, never usable.

### Policy: source-v1

Only source-like files are captured. The policy is versioned and stored on
every checkpoint:

| Rule | Value |
| --- | --- |
| Included | text files by extension and known basenames (`.ts`, `.py`, `.md`, `Dockerfile`, `package.json`, ...) |
| Skipped | `node_modules`, `.git`, build output, caches, `.env*`, keys, archives, media, anything binary |
| Refused | content matching credential patterns or high-entropy tokens, plus every configured runtime secret (`CHECKPOINT_SECRET_DETECTED`) |
| Limits | 10 000 files, 5 MiB per file, 50 MiB per checkpoint, 500 ready checkpoints per Project |

A file that is skipped is counted (`excludedFileCount`) so the operator can
see that a checkpoint is partial. Excluded paths are not restored either, so a
restore never deletes something the policy never captured.

## What a restore does

`POST /api/orchestrations/:id/recover` with
`{ checkpointId, requestId, acknowledgeSourceRestore: true }`:

1. **Reserve** the Project for recovery. Fails with `PROJECT_BUSY` if any
   cycle, preview, direct Agent run, or lifecycle mutation holds it.
2. **Prepare**: revalidate the target checkpoint's Git objects and
   continuation, quiesce previews, confirm no physical writer is alive.
3. **Back up**: capture a safety checkpoint of the current (damaged) files.
4. **Restore**: apply the file plan (write, delete, no-op) against the target
   tree, verify the workspace manifest hash matches, then bump the Project's
   `workspaceEpoch` and clear every Project-scoped Agent thread pointer. The
   resumed Agent starts with a fresh thread, so it cannot "remember" files
   that no longer exist.
5. **Resume**: seed the engine from the checkpoint's continuation and queue
   the remaining participants. Turn indices stay global, so the resumed
   Reviewer appears as step 3 after the failed step 2.

Every stage is durable in the `workspaceOperations` record. If the server
dies mid-restore, startup marks the operation `recovery_required`, keeps the
Project write lease retained, and refuses Agent admission until the operator
resumes or restores the safety checkpoint. Nothing re-executes an Agent
automatically.

### Idempotency

`requestId` is part of the operation. Replaying the same request returns the
same operation (`202` while pending, `200` once settled). Reusing a
`requestId` with a different checkpoint returns
`CHECKPOINT_IDEMPOTENCY_CONFLICT` (409).

## Invariants the code enforces

- No checkpoint or restore while an uncontrolled writer exists. Reservations,
  write leases, previews, and direct Project runs are all mutually exclusive
  through `WorkspaceOperationCoordinator.assertAdmission`.
- No `ready` checkpoint before Git objects, metadata, and continuation are all
  validated; `validateCheckpoint` re-checks before every restore.
- No destructive restore before a `ready` safety checkpoint exists.
- Git never reads Agent-controlled configuration: the private repository runs
  with `GIT_CONFIG_NOSYSTEM`, an empty global config, `GIT_CONFIG_COUNT`
  inline settings, an empty hooks directory, no inherited `GIT_*` variables,
  and never touches a `.git` directory inside the workspace.
- HTTP never accepts host paths, Git revisions, commands, or principals. The
  bodies are strict Zod schemas; unknown fields are rejected (422).
- Secrets never become blobs. Configured runtime secrets are handed to the
  scanner privately; a match aborts the capture with a fixed message and no
  excerpt.
- Public views carry ordinals, kinds, counts, and states only. No SHA, no
  path, no prompt, no continuation state reaches the UI or the audit metadata.
- The feature is **off by default** (`WORKSPACE_CHECKPOINTS_ENABLED=false`).
- The local-process runtime cannot prove a worker has exited, so it is
  rejected unless `WORKSPACE_CHECKPOINT_LOCAL_PROCESS=allow` is set
  explicitly. The container runtime provides settlement proof.
- The legacy `Retry from this turn` keeps its semantics and its wording
  ("using the current files"). It never restores anything.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:id/checkpoints` | List public checkpoint views (`?limit`, `?beforeOrdinal`) plus capability status |
| `GET` | `/api/projects/:id/checkpoints/:checkpointId` | One public view |
| `POST` | `/api/orchestrations/:id/recover` | Restore after a checkpoint and resume (202, 200 when a duplicate already settled) |
| `GET` | `/api/orchestrations/:id/recoveries/:operationId` | Recovery stage |
| `POST` | `/api/orchestrations/:id/recoveries/:operationId/resume` | Re-drive a `recovery_required` operation |
| `POST` | `/api/orchestrations/:id/recoveries/:operationId/restore-safety` | Put the pre-restore files back |

Error codes are typed (`CHECKPOINT_*`) and mapped to 404/409/422/500/503 in
one place. See `apps/server/src/projects/workspace-checkpoint-types.ts`.

## Configuration

```bash
WORKSPACE_CHECKPOINTS_ENABLED=true          # default false
WORKSPACE_CHECKPOINT_LOCAL_PROCESS=allow    # default reject; container runtime needs nothing
WORKSPACE_CHECKPOINT_GIT_BIN=git            # executable used for the private store
```

The private store lives at `<APP_DATA_DIR>/workspace-checkpoints/<projectId>/repository.git`,
beside, never inside, the Project workspace, so no Agent or preview mount can
reach it. PostgreSQL deployments apply migration `003_workspace_checkpoints.sql`
(schema version 3). JSON stores upgrade in place.

## The deterministic demo

```bash
npm run demo:checkpoints -- --reset   # API on http://127.0.0.1:3000
npm run dev -w @launchpad/web         # UI on http://localhost:5173
```

The harness boots the real server through `bootstrapApplication` with one
substitution: scripted Planner, Builder, and Reviewer Agents replace the Codex
runtime. They really edit the shared workspace. The Reviewer overwrites
`src/message.ts`, deletes `PLAN.md`, leaves `src/partial.ts`, and crashes on
its first attempt. It succeeds only when its Run belongs to a recovery cycle,
so the outcome never depends on a model misbehaving on cue.

Demo script:

1. Open the seeded "Ship the review-ready message" Conversation and press
   Start. Watch the baseline and two turn checkpoints appear on the Planner
   and Builder turns.
2. The Reviewer fails. Open the workspace folder printed by the harness:
   the message is `"BROKEN"` and `PLAN.md` is gone.
3. Open the Builder turn and press **Restore after Builder and resume**.
   Confirm the dialog. The recovery panel walks through reserved,
   backed up, restored, and resume accepted.
4. The files are back, the Reviewer runs again with a fresh thread and
   approves, and the Conversation completes. Audit shows the operator's
   restore and every checkpoint, with no paths or SHAs.

Verified on Windows 11 with Git 2.46 by driving the sequence over HTTP: the
session ends `completed`, the Reviewer's successful turn is global step 3, and
the raw session JSON contains no 40-character hex identity.

## Honest limitations

- **Source files only.** Binary assets, `node_modules`, and build output are
  not captured, so a restore does not reinstall dependencies or rebuild.
- **Agent memory is reset, not rewound.** Project-scoped threads are cleared
  on restore. The engine continuation is exact; the model's own context is
  fresh. That is deliberate, and it is what makes the resumed turn safe.
- **Local-process runtime trusts process exit.** Without a container there is
  no positive proof that a worker's file handles are closed. The override
  exists for development and the demo, not production.
- **One Project, one operation.** Recovery reserves the whole Project; other
  Conversations on that Project wait.
- **PostgreSQL suite not exercised in this environment.** The migration and
  store mapping are implemented and unit-tested against the JSON store;
  the PostgreSQL integration run needs a database.
- Mastra Memory integration (plan packet M) was left out as unverified; the
  continuation is stored in the platform's own records instead.

## Tests

```bash
npx vitest run --config vitest.server.config.ts tests/server/projects tests/server/orchestration tests/server/workspace-recovery-routes.test.ts tests/server/persistence
npx vitest run --config vitest.web.config.ts
```

Coverage includes the Git store (idempotent capture, restore plans, unknown
edit refusal, policy rejection), the policy scanner, the operation
coordinator, resume-state maths, the HTTP boundary (strict bodies, error
mapping, no private fields), persisted record schemas, and seven end-to-end
recovery scenarios that run the real service stack with a scripted runner:
baseline and turn checkpoints, restore-and-resume with usage counted once,
idempotency, capture failure that keeps the Agent's output, writer exclusion,
branch-aware continuation, and the feature flag off.
