# Wave 7 Follow-up: Static HTML Preview and Preview Error UI

## Status

Implementation-ready. This plan extends the existing Wave 7 preview runtime only.

Use Luna agents with maximum reasoning for implementation and audit. Preserve the
current dirty worktree and all unrelated changes. Do not begin Wave 8, add public
deployment, or introduce a general buildpack/tool framework.

## Goals

1. Preview a workspace-root `index.html` without requiring `package.json`, npm,
   or installed dependencies.
2. Show backend preview error messages and `errorCode` inside the Preview panel
   instead of reducing failures to generic HTTP text.

## Confirmed Product Decisions

- Supported package runtimes retain priority: Vite, then Next.js, then the
  current narrow Express/Node shape.
- If no supported package runtime is detected, a regular workspace-root
  `index.html` selects static preview mode.
- A malformed or unsupported `package.json` must not block static fallback when
  a valid root `index.html` exists.
- `/` serves the root `index.html`; existing asset files are served by exact
  path.
- Missing files and extensionless routes return `404`. Do not add SPA fallback.
- Preview-operation errors appear inside the Preview panel, not in the global
  application error banner.
- Local preview errors clear on retry, success, and Agent selection changes.

## Architecture

```text
PreviewService.start(agentId)
        |
        v
PreviewCommandResolver
        |
        +--> supported package runtime --> existing npm argv
        |
        +--> root index.html -----------> fixed static-server argv
        |
        +--> neither -------------------> normalized PreviewError
```

Static mode continues through the existing `PreviewService` and
`LocalContainerPreviewRuntime`. It receives the same lifecycle management,
localhost port allocation, resource limits, authorization checks, persistence,
logs, and cleanup as other preview kinds.

## Luna Max Agent Work Allocation

### Agent A: Static Runtime and Backend

Own these files to avoid merge conflicts:

- `scripts/preview-static-server.mjs` (new)
- `Dockerfile.runtime`
- `apps/server/src/preview/preview-command-resolver.ts`
- `apps/server/src/preview/preview-types.ts`
- `apps/server/src/preview/local-container-preview-runtime.ts`
- `apps/server/src/preview/preview-service.ts`
- `apps/server/src/preview/preview.test.ts`
- `apps/server/src/preview/static-preview-server.test.ts` (new)
- `apps/server/src/app.test.ts`
- `docs/WAVE_7_PREVIEW_RUNTIME.md`

### Agent B: Preview Error UI

Own these files:

- `apps/web/src/App.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/styles.css`
- `apps/web/src/types.ts` only if a shared UI error type is genuinely useful

Agent B must not modify backend files. Agent A must not modify web files.

### Agent C: Read-only Audit

After Agents A and B finish, use a separate Luna max agent to audit:

- resolver precedence and malformed-package fallback;
- path traversal and symlink escape defenses;
- read-only static mounts;
- preview error-envelope preservation;
- UI error clearing and absence of duplicate global banners;
- test and documentation completeness.

The primary agent applies any audit fixes and performs final validation.

## 1. Trusted Static Server

Add a standalone repository-owned Node server at:

```text
scripts/preview-static-server.mjs
```

Copy it into the runtime image at a fixed path:

```dockerfile
COPY scripts/preview-static-server.mjs /opt/launchpad/preview-static-server.mjs
```

Static preview must use fixed backend-owned argv, conceptually:

```text
node /opt/launchpad/preview-static-server.mjs /workspace 4173
```

Do not use `npx`, download packages, execute workspace scripts, concatenate a
shell string, or accept a command from React.

The server must:

- bind `0.0.0.0:4173` inside the container;
- accept only `GET` and `HEAD`; return `405` otherwise;
- map `/` only to `/workspace/index.html`;
- serve other existing regular files by exact path;
- return `404` for missing paths and directories;
- never provide directory listings or SPA fallback;
- reject malformed percent encoding, NULs, backslashes, and lexical traversal;
- resolve candidates with `realpath` and verify they remain beneath the real
  workspace root, preventing symlink escape;
- deny dotfile path segments so `.env`, `.git`, and similar files cannot be
  fetched;
- use a fixed MIME table for HTML, CSS, JS/MJS, JSON/map, SVG, common images,
  fonts, text, and WASM;
- default unknown types to `application/octet-stream`;
- set `X-Content-Type-Options: nosniff`;
- set `Cache-Control: no-cache` so Agent edits are visible;
- set an accurate `Content-Length` and omit the body for `HEAD`;
- emit concise startup and failure logs without host paths or secrets.

Do not build a general-purpose static hosting platform in this follow-up.

## 2. Resolver Precedence and Fallback

Extend:

```ts
export type PreviewCommandKind = "vite" | "next" | "node" | "static";
```

Refactor `PackageJsonPreviewCommandResolver.resolve()` into this order:

1. Validate the trusted absolute workspace path.
2. Attempt to read and parse `package.json` when present.
3. If parsed metadata matches an existing supported runtime, return that
   runtime immediately.
4. Otherwise use `lstat` to check that `<workspace>/index.html` is a regular
   root file. Reject a symlink as the root entrypoint.
5. If valid, return:

   ```ts
   {
     kind: "static",
     command: [
       "node",
       "/opt/launchpad/preview-static-server.mjs",
       "/workspace",
       "4173",
     ],
     containerPort: 4173,
   }
   ```

6. If no static entrypoint exists, preserve normalized errors:
   - missing package and index: `PREVIEW_COMMAND_NOT_FOUND`;
   - malformed/unreadable package without index:
     `PREVIEW_UNSUPPORTED_PROJECT`;
   - parsed but unsupported package without index:
     `PREVIEW_UNSUPPORTED_PROJECT`.

Do not let malformed package metadata throw before the static fallback check.

## 3. Read-only Workspace Mount for Static Mode

Extend `PreviewStartInput` with a backend-owned mount policy, for example:

```ts
workspaceReadOnly?: boolean;
```

`PreviewService` sets it to `true` only when the resolved kind is `static`.
`buildPreviewContainerRunArgs()` appends the container engine's read-only bind
mount option for static previews.

Package runtimes remain writable because their development servers and caches
may need current behavior. React must not control this flag.

Keep all current container protections:

- bridge networking;
- `127.0.0.1` host publication;
- CPU, memory, and PID limits;
- `no-new-privileges`;
- all capabilities dropped;
- managed labels and container names;
- one active preview per Agent.

## 4. Explicit Backend Error Envelope

The server already intends to return preview failures as:

```json
{
  "error": "No supported preview entrypoint was found",
  "errorCode": "PREVIEW_COMMAND_NOT_FOUND"
}
```

Harden this contract:

- use the existing `isPreviewError()` guard at the Fastify boundary so the
  preview code survives module/prototype edge cases;
- always use the normalized preview message for `error`;
- always include `errorCode` for preview failures;
- never replace a backend message with `response.statusText`;
- continue excluding runtime causes, container stderr, paths, and stack traces
  from the response and structured server log.

Add an API test where preview start rejects with a `PreviewError` and assert
the exact HTTP status, message, and code.

## 5. Web API Error Parsing

Update `apps/web/src/api.ts` so `ApiError` prefers the most specific backend
message:

```text
data.message (Fastify/framework detail when present)
        |
        v
data.error (repository preview envelope)
        |
        v
response.statusText
        |
        v
"Request failed"
```

Do not show a generic phrase such as `Unprocessable Entity` when a detailed
backend message exists. Preserve `errorCode` and `details` on `ApiError`.

## 6. Preview-local Error State

Add local state in `App.tsx`, conceptually:

```ts
type PreviewActionError = {
  message: string;
  errorCode: string | null;
};
```

Pass it into `PreviewPanel` and render it with `role="alert"` even when no
`Preview` record exists. Display both:

```text
PREVIEW_UNSUPPORTED_PROJECT
This workspace does not contain a supported preview entrypoint.
```

Behavior requirements:

- clear the local error before start, restart, or stop;
- clear it after a successful preview operation;
- on `ApiError`, store `message` and `errorCode` locally;
- for unexpected errors, store a safe message with a null code;
- do not call the global `setError()` for preview operations;
- refresh preview state after failure so persisted `Preview.errorMessage` and
  `Preview.errorCode` remain authoritative when a failed record exists;
- if persisted preview failure data exists, prefer it over the transient action
  error;
- clear local preview errors whenever the selected Agent changes;
- retain the global banner for authentication, Agent, Run, model, and
  orchestration errors.

Add accessible styling for the code and message without creating a new global
notification system.

## 7. Focused Tests

### Resolver tests

Add only these cases:

- root `index.html` with no package selects static;
- malformed package plus valid root index selects static;
- unsupported package plus valid root index selects static;
- supported Vite plus root index still selects Vite;
- missing package and index returns `PREVIEW_COMMAND_NOT_FOUND`;
- malformed package without index returns `PREVIEW_UNSUPPORTED_PROJECT`;
- static output uses the exact trusted argv and port `4173`;
- static preview requests a read-only workspace mount.

### Static-server tests

Start the standalone script against a temporary workspace and verify:

- `/` returns the root HTML;
- an exact nested asset returns its bytes and correct MIME type;
- `HEAD` returns headers without a body;
- an extensionless missing path returns `404` rather than `index.html`;
- directory requests do not list contents;
- dotfiles are denied;
- encoded traversal is rejected;
- a symlink escaping the workspace is rejected;
- cache and `nosniff` headers are present.

### API test

- preview start failure returns the backend message and `errorCode`.

### Frontend verification

Do not add a new component-test framework. Verify through TypeScript/build and
manual UI smoke testing:

- failed static/package detection displays code and message in Preview;
- the global banner does not duplicate it;
- retry clears the old failure;
- switching Agents clears the old failure;
- successful start clears the old failure.

## 8. Real Smoke Tests

### Static success

Create an Agent workspace containing:

```text
index.html
assets/app.js
assets/app.css
```

Verify:

1. no `package.json` is required;
2. preview starts as `static`;
3. the backend-generated URL returns HTTP 200;
4. HTML, JS, and CSS load;
5. a missing extensionless route returns 404;
6. stop removes the managed container;
7. no dependencies or network install occurred.

### Fallback resilience

Add malformed `package.json` beside the valid root `index.html` and verify the
same static success path.

### Error UI

Remove both supported package configuration and `index.html`, start preview,
and verify the Preview panel displays:

- `PREVIEW_COMMAND_NOT_FOUND`;
- the normalized backend message;
- no generic `Unprocessable Entity` text;
- no duplicate global error banner.

## 9. Documentation

Update `docs/WAVE_7_PREVIEW_RUNTIME.md` with:

- static fallback precedence;
- malformed-package resilience;
- fixed static server and port `4173`;
- exact-file serving and no SPA fallback;
- read-only static mount;
- runtime-image rebuild requirement;
- error code/message behavior in the Preview panel;
- custom preview images must contain Node and the bundled script.

## 10. Final Validation

Run:

```text
npm run check
git diff --check
```

Also verify no managed preview containers remain after smoke tests.

## Exit Criteria

- A root static `index.html` previews without package metadata or dependencies.
- Malformed package metadata does not block a valid static fallback.
- Supported package runtimes still win over static mode.
- Missing routes return 404; no SPA fallback exists.
- Static preview cannot traverse or follow symlinks outside the workspace.
- Static workspace mount is read-only.
- Backend preview messages and codes reach the web client unchanged.
- Preview errors render inside the Preview panel and not the global banner.
- Preview errors clear on retry, success, and Agent change.
- Existing Wave 7 lifecycle, log redaction, Agent CRUD, Playground, Team
  orchestration, and Wave 6 model behavior remain intact.
- Focused tests, `npm run check`, and `git diff --check` pass.

## Explicit Non-goals

- SPA history fallback;
- directory listings;
- arbitrary document roots;
- user-supplied static-server commands or ports;
- automatic dependency installation;
- public deployment or proxying;
- Wave 8 roles/RBAC;
- broad framework or buildpack detection;
- new frontend testing infrastructure.
