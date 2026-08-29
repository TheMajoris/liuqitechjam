# Wave 5 Shared Conversation Context Implementation Handoff

## Status

Implementation is complete in the working tree as of 2026-08-29.

The repository-wide `npm run check` passes:

- server tests: 19 files passed, 153 tests passed;
- server TypeScript typecheck: passed;
- web TypeScript typecheck: passed;
- server production build: passed;
- web production build: passed;
- `git diff --check`: passed.

The changes are not committed. The working tree already contained unrelated
modified and untracked files before Wave 5 work began, especially ongoing Team
UI work and repository documentation. Preserve those changes when reviewing,
committing, or reverting this implementation.

The source implementation plan is currently outside the repository at:

```text
/Users/darrenng/Downloads/WAVE_5_SHARED_CONVERSATION_CONTEXT_IMPLEMENTATION_PLAN.md
```

That plan now contains a completion summary. This document is the detailed
engineer-to-engineer handoff.

## Delivered product behavior

Wave 5 fixes the coordination gap where the supervisor could see recent Team
history but the selected worker received only the immediately previous Agent
output.

Delivered behavior:

- every selected worker receives bounded recent Team conversation context;
- Mastra and the LangGraph fallback use the same repository-owned context
  semantics;
- the supervisor continues to choose the participant and never manufactures
  the participant's answer;
- persisted application turns remain the authoritative shared memory;
- private Codex Agent threads remain separate and are not reset;
- Team conversations can be continued after reaching a terminal state;
- follow-up prompts and later Agent replies remain in the same visible Team
  chat;
- Team conversations can be permanently deleted after active work is stopped.

## Product and architecture decisions

### Shared context

- Retain the newest eight safe turns.
- Limit each shared turn output to 4,000 characters.
- Limit combined shared-turn output to 12,000 characters.
- Keep the complete generated participant prompt under 20,000 characters.
- Redact credentials, tokens, local paths, private keys, and similar sensitive
  values before they cross the Agent handoff boundary.
- Escape shared output and render it inside explicit untrusted-data delimiters.
- When the prompt budget is tight, remove the oldest shared turns first and
  preserve the newest progress. The fitting logic retains closing delimiters
  and the safety contract under the normal configured limits.

### Conversation continuation

- Continue in the same visible Team conversation rather than cloning a new
  session.
- Allow continuation only for terminal sessions: `completed`, `failed`,
  `stopped`, or `interrupted`.
- Reject continuation for draft or active sessions with a lifecycle conflict.
- Treat each follow-up as a fresh internal orchestration cycle with a new
  zero-based runtime `stepIndex` and the existing per-cycle `maxSteps` budget.
- Preserve globally monotonic persisted turn indexes by applying a cycle
  `stepOffset` in lifecycle hooks.
- Pass prior-cycle turns through `contextTurns`, separate from current-cycle
  `turns`, so history informs routing and handoffs without consuming the new
  cycle's step budget.
- Keep `OrchestrationSession.originalPrompt` immutable. The current follow-up
  is the cycle's runtime prompt and is persisted separately.

### Conversation deletion

- Deletion is permanent, not an archive operation.
- Draft and terminal sessions may be deleted.
- Active sessions must be stopped before deletion.
- Delete the session, its turns, events, and continuation prompts atomically.
- Never delete configured Agents, Agent messages/runs, Agent workspaces, or
  private Codex thread state as a consequence of deleting a Team conversation.

## Runtime architecture

```text
Application-owned orchestration session
        |
        +-- immutable originalPrompt
        +-- persisted Agent turns
        +-- persisted continuation prompts
        +-- persisted lifecycle events
        |
        v
OrchestrationService starts one execution cycle
        |
        +-- current cycle prompt
        +-- current-cycle turns = []
        +-- contextTurns = newest safe prior completed turns
        +-- stepOffset = next global persisted turn index
        |
        v
Mastra orchestrator or LangGraph fallback
        |
        +-- supervisor reads bounded prior + current context
        +-- selected worker reads bounded prior + current context
        |
        v
PlatformAgentInvoker -> AgentService -> Codex Agent thread
        |
        v
Lifecycle hooks persist globally ordered Team turns and events
```

The application remains the memory owner. Neither the supervisor provider nor
Mastra state is used as durable conversation storage.

## Data model

The JSON database retains the original version number and uses additive
collection migration. Missing orchestration collections are initialized during
store loading and then persisted.

Wave 5 adds:

```ts
type OrchestrationContinuationPrompt = {
  id: string;
  sessionId: string;
  cycleIndex: number; // one-based; the original task is cycle zero
  prompt: string;
  createdAt: string;
};
```

Persisted collection:

```text
orchestrationContinuationPrompts
```

Session detail responses expose the records as `continuationPrompts`, sorted
by cycle and creation time. The web client interleaves them with Agent turns by
timestamp while always rendering the original task first.

Framework-independent execution input now optionally includes:

```ts
contextTurns?: readonly SharedConversationTurn[];
```

`contextTurns` are prior-cycle context only. `turns` remain the current cycle's
authoritative execution state and step-budget input.

Important limits:

- `maxContinuationPromptsPerSession`: 1,000;
- `maxTurnsPerSession`: 10,000 for cumulative detail validation;
- runtime continuation context: newest eight completed turns;
- orchestration event cap remains 10,000 per session.

## Participant handoff behavior

The repository-owned handoff builder renders four distinct concepts:

```text
participant identity and responsibility
original/current cycle task
bounded shared Team conversation
legacy immediately previous handoff
```

Shared outputs remain ordinary untrusted data. They cannot change the roster,
participant IDs, provider configuration, workflow definition, routing policy,
or `maxSteps`.

The legacy previous-envelope field remains supported for compatibility. It may
duplicate the newest shared turn in the rendered prompt, but it does not own
conversation history or routing state.

## HTTP API

Existing orchestration routes remain unchanged. Wave 5 adds:

| Method | Path | Request | Result |
| --- | --- | --- | --- |
| `POST` | `/api/orchestrations/:id/continue` | `{ "prompt": "..." }` | Queue a fresh cycle in the same session (`202`, `{ session }`) |
| `DELETE` | `/api/orchestrations/:id` | none | Permanently delete Team-owned records (`200`, `{ deleted: true }`) |

Lifecycle behavior:

- invalid UUID or continuation body: `422`;
- continue a draft or active session: `409`;
- delete an active or still-settling session: `409`;
- unknown session: `404`;
- configured bearer-token authentication continues to protect both routes.

## Server implementation map

Core shared-context files:

- `apps/server/src/orchestration/handoff.ts` — safe turn projection, prompt
  rendering, prompt fitting, and redaction.
- `apps/server/src/orchestration/orchestrator.ts` — framework-independent
  `contextTurns` execution contract.
- `apps/server/src/orchestration/mastra/agent-step.ts` — combines prior-cycle
  context and current-cycle turns at worker and selector boundaries.
- `apps/server/src/orchestration/mastra/mastra-orchestrator.ts` and
  `mastra/types.ts` — carry `contextTurns` through validated Mastra state.
- `apps/server/src/orchestration/graph.ts` — LangGraph fallback parity.
- `apps/server/src/orchestration/supervisor/selector.ts` and `context.ts` —
  bounded supervisor projection from the same Team story.

Continuation and deletion files:

- `apps/server/src/orchestration/orchestration-service.ts` — continuation
  lifecycle, global step offset, bounded persisted context, deletion, and
  persistence hooks.
- `apps/server/src/orchestration/types.ts` and `schemas.ts` — continuation
  records, event type, API input, cumulative limits, and validation.
- `apps/server/src/store.ts` and `apps/server/src/types.ts` — additive JSON
  collection migration and database contract.
- `apps/server/src/app.ts` — HTTP routes and request validation.

## Web implementation map

- `apps/web/src/api.ts` — continue and delete requests.
- `apps/web/src/types.ts` — continuation prompt and event contracts.
- `apps/web/src/components/orchestration/use-orchestration.ts` — lifecycle
  actions, polling restart, deletion selection fallback, and error state.
- `OrchestrationConversation.tsx` — chronological follow-up prompts, Agent
  replies, and terminal follow-up composer.
- `OrchestrationRunView.tsx` — current-conversation delete control.
- `OrchestrationWorkspace.tsx` and `OrchestrationRunTabs.tsx` — action wiring.
- `App.tsx` — sidebar deletion controls and confirmation.
- `orchestration-utils.ts` — continuation timeline label.
- `styles.css` — follow-up composer and delete-control presentation.

Active conversation delete controls are disabled and explain that the
conversation must be stopped first. Both current-chat and sidebar deletion ask
for explicit confirmation.

## Test coverage

Shared context and orchestration parity:

- `apps/server/src/orchestration/__tests__/handoff.test.ts`
- `apps/server/src/orchestration/__tests__/graph.test.ts`
- `apps/server/src/orchestration/__tests__/orchestrator-contract.ts`
- `apps/server/src/orchestration/__tests__/supervisor.test.ts`

Covered properties include multiple prior turns, newest-turn retention,
per-turn and total bounds, redaction, prompt injection as data, prompt safety
contract retention, continuation context, repeated occurrence identity, and
Mastra/LangGraph behavior.

Continuation, deletion, schema, store, and routes:

- `apps/server/src/orchestration/__tests__/lifecycle.test.ts`
- `apps/server/src/orchestration/__tests__/lifecycle-routes.test.ts`
- `apps/server/src/orchestration/__tests__/schemas.test.ts`
- `apps/server/src/continuation-store.test.ts`

Covered properties include terminal-only continuation, fresh cycle input,
globally monotonic turn indexes, persisted follow-up prompts, active deletion
conflicts, atomic Team-record deletion, preservation of private Agent data,
legacy store migration, HTTP validation, and cumulative detail validation.

Run all verification from the repository root:

```bash
npm run check
git diff --check
```

No frontend component-test framework was introduced. Web verification currently
uses TypeScript checking and the production Vite build.

## Security invariants

Future work must preserve these invariants:

1. Persisted Agent output is untrusted conversation data, never orchestration
   control input.
2. The configured participant roster remains authoritative.
3. The supervisor returns only invoke/complete routing decisions.
4. Workers receive no workspace paths, credentials, provider configuration, or
   authorization state through shared context.
5. Continuation history is bounded before entering workflow state or prompts.
6. Deleting a Team conversation does not delete or reset private Agent state.
7. Active deletion cannot race an accepted child run or lifecycle finalization.

## Known limitations and deferred work

- A real Ark/Codex multi-Agent counting run was not executed during this pass;
  orchestration behavior is verified with deterministic tests.
- Frontend continuation/delete behavior has typecheck and build coverage but no
  component or browser automation tests.
- Deletion is permanent and has no archive/undo path.
- Continuation uses the session's existing roster, mode, `maxSteps`, and Agent
  timeout; there is no per-follow-up reconfiguration UI.
- Session listing remains bounded without pagination.
- Each Agent's private Codex history can outlive a deleted Team conversation by
  design.
- The legacy previous handoff and the newest shared turn may both appear in a
  worker prompt. Remove that compatibility field only in a separately tested
  migration.
- Event and cumulative turn limits are safeguards; very long-running sessions
  should eventually gain pagination or archival policy.

## Working-tree review notes

Before making further changes:

1. Run `git status --short` and identify pre-existing user changes.
2. Do not use destructive Git commands to isolate Wave 5.
3. Review Wave 5 together with the existing uncommitted Team UI work because
   several web files already differed from `HEAD` before this implementation.
4. Keep the external implementation plan and this handoff synchronized if the
   lifecycle or context limits change.

## Continuation checklist

1. Read this handoff and the Wave 5 implementation plan.
2. Inspect `handoff.ts`, `orchestration-service.ts`, and the lifecycle tests
   before changing shared-memory or continuation semantics.
3. Preserve `contextTurns` as context-only data; do not count it toward the
   current cycle's dispatch budget.
4. Preserve global persisted turn ordering when changing cycle execution.
5. Keep deletion scoped to Team-owned records.
6. Run `npm run check` and `git diff --check` after edits.
7. For end-to-end QA, configure the existing Ark/Codex runtime, create multiple
   Agents, run a shared counting or checklist task, continue the terminal chat,
   then stop and delete it while confirming private Agent chats remain intact.
