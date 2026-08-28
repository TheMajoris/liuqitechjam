# Deviations and Baseline Record

This document freezes the untouched starter behavior before the Secretless
Multi-Agent Control Plane MVP (`tasks/plan.md`) begins, and records any
deliberate deviation from that plan discovered during implementation.

## Baseline proof (Task 0)

Captured on branch `feat/secretless-control-plane`, commit parent `a2f4e0f`.

### Automated verification

`npm run check` passes clean:

- `typecheck` — `tsc --noEmit` for `@launchpad/web` and `@launchpad/server`.
- `test` — 5 Vitest files, 12 tests passing (`store`, `app`, `agent-service`,
  `codex-runner`, `container-codex-runner`).
- `build` — Vite production bundle plus `tsc` server build.

### Baseline capabilities that must survive every later task

| Capability | Where it lives today |
| --- | --- |
| Agent CRUD | `apps/server/src/agent-service.ts`, routes in `app.ts` |
| Lifecycle (`start` / `stop`) | `agent-service.ts` `startAgent` / `stopAgent` |
| Playground chat (`POST /api/agents/:id/messages` → `202`) | `agent-service.ts` `sendMessage` |
| Follow-up session continuity | `codexThreadId` persisted on `Agent`, replayed by `codex-runner.ts` |
| Persistence | `apps/server/src/store.ts` `JsonStore`, `Database.version = 1` |
| Model execution | `codex-runner.ts` (local process) / `container-codex-runner.ts` (container) |

### Protected local container path

- Runner: `apps/server/src/container-codex-runner.ts`, selected when
  `RUNTIME_PROVIDER=container` (`runner-factory.ts`).
- Engine: Docker (`CONTAINER_ENGINE=docker` default). Verified available:
  `Docker version 29.1.3`. Colima and rootless Podman are documented alternates.
- Container hardening already present: `--rm --init`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--user` non-root, cpu/memory/pids limits,
  workspace bind mount at `/workspace`, sanitized `CODEX_HOME` at `/codex-home`.
- **Security gap this MVP closes:** `buildContainerRunArgs` passes
  `--env ARK_API_KEY`, injecting the long-lived provider credential directly
  into the untrusted Runtime. Network is `--network bridge` (open egress).
  Task 6 replaces this with a gateway lease and an internal-only network.

## Contract gate

Implementation follows `tasks/plan.md` section 14 task order. The plan's
interface contracts (sections 5, 7, 8, 10, 11) are the acceptance surface;
any change to them is recorded below before dependent work continues.

## Recorded deviations

_None yet._
