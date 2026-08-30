# AGENT MIDDLEWARE OVERALL IMPLEMENTATION PLAN

## Purpose

This document is the updated implementation roadmap for the Agent Middleware project.

It reflects the current completed orchestration foundation, the ongoing Wave 6 worker model assignment work, and the newly defined direction for:

- long-lived application preview runtimes
- backend-enforced Agent roles and permissions
- user-defined roles
- user-defined skills
- platform-defined tools
- skill discovery and installation
- observability
- failure and recovery
- demo hardening

It supersedes the previous overall implementation plan.

The roadmap is intentionally ordered around one clear middleware progression:

```text
Wave 6
What MODEL does the Agent use?

Wave 7
What RUNTIME can the Agent interact with?

Wave 7.1
What SHARED ARTIFACT does a Team collaborate on?

Wave 7.2
How many CONVERSATIONS can one Agent hold?

Wave 8
What ROLE, SKILLS, TOOLS, and PERMISSIONS does the Agent have?

Wave 9
What ACTUALLY happened?

Wave 10
What happens when something FAILS?

Wave 11
How do we HARDEN the demo?

Wave 12
What optional capabilities are worth adding later?
```

The project should remain focused on coherent middleware behavior rather than accumulating unrelated UI features.

---

# 1. Current State

## 1.1 Platform baseline

The following starter-kit behavior must remain intact:

- Agent CRUD
- Agent lifecycle controls
- Playground chat
- persistent per-Agent Codex sessions
- persistent per-Agent workspaces
- asynchronous Runs
- local disposable container execution
- JSON persistence
- React frontend
- Fastify control plane
- existing Codex worker execution path

The current worker path remains:

```text
React Playground
    |
    v
Fastify API
    |
    v
AgentService
    |
    v
AgentRunner
    |
    v
Codex worker runtime
    |
    v
Agent workspace
```

The Agent workspace persists independently from any individual disposable Codex container.

---

## 1.2 Orchestration foundation

The project has a repository-owned orchestration boundary with Mastra behind it.

```text
React Team UI
    |
    v
Fastify API
    |
    v
OrchestrationService
    |
    v
Orchestrator
    |
    v
Mastra
    |
    +--> Supervisor Router
    |
    v
PlatformAgentInvoker
    |
    v
AgentService
    |
    v
Codex worker runtime
```

Current orchestration capabilities include:

- sequential mode
- supervisor mode
- bounded `maxSteps`
- timeout and cancellation
- shared Team conversation context
- persisted Team turns and events
- terminal conversation continuation
- permanent Team conversation deletion
- preservation of private Agent state
- bounded and redacted Agent handoffs
- backend-owned supervisor routing
- validation of supervisor-selected participants before dispatch

The supervisor remains middleware infrastructure rather than a visible worker Agent.

---

## 1.3 Workspace model

Each Agent currently owns a persistent workspace.

```text
workspaces/
    |
    +--> alice-agent-id/
    +--> bob-agent-id/
    +--> charlie-agent-id/
```

A disposable Codex container mounts the owning Agent workspace.

```text
Host persistent workspace
        |
        | bind mount
        v
Disposable Codex container
        |
        v
Agent edits/runs code
        |
        v
Container terminates
        |
        v
Workspace files remain
```

This means an Agent can create an application, install dependencies, run builds/tests, and preserve the resulting files across later turns.

Since Wave 7.1 there are two execution scopes, not one:

```text
Individual execution:
Agent -> Agent private workspace

Collaborative execution:
Team -> Project -> shared Project workspace

data/
    projects/
        <project-id>/
            workspace/
```

A Project-scoped turn mounts the shared Project workspace instead of the Agent's
private one. The Agent keeps its identity, model assignment, and private
workspace for non-Project work; only the artifact directory changes. See
Wave 7.1 for the ownership model, single-writer coordination, and the
per-(Agent, Project) session scoping this requires.

Wave 7 added the dedicated long-lived preview runtime that outlives a Codex
turn; Wave 7.1 extended its ownership to Projects.

---

## 1.4 Model abstraction

Wave 6 addresses the remaining worker model gap:

> Users cannot yet assign a provider/model/reasoning configuration to each worker Agent.

The target model design supports:

- provider selection
- dynamic model discovery where supported
- curated fallback/filtering where necessary
- model capability metadata
- reasoning configuration where supported
- safe server-side credential handling
- backward-compatible default worker models
- independent worker and supervisor model configuration

---

# 2. Core Architecture Principles

## 2.1 Backend is the source of truth

React may display state and request operations, but the backend owns authority.

```text
Frontend = presentation + intent
Backend = policy + authority
Runtime = execution
```

The backend must be authoritative for:

- role definitions
- skill installation state
- tool availability
- Agent permissions
- effective capability resolution
- preview lifecycle
- workspace ownership
- model/provider validation
- Team routing enforcement
- deployment approval in future
- runtime access decisions

Hiding a button is UX.

Backend authorization is enforcement.

---

## 2.2 LLM output is a proposal, not authority

Supervisor and worker model output may propose actions, but trusted backend code validates them.

Example:

```text
Supervisor proposes:
"invoke Alice"
        |
        v
middleware validates Alice exists in roster
        |
        v
Agent lifecycle is checked
        |
        v
dispatch
```

The same principle applies to:

- tool execution
- preview lifecycle requests
- skill installation
- network access
- future deployment

---

## 2.3 Worker execution remains behind AgentService

Team orchestration must continue to invoke worker Agents through the normal platform path.

```text
Mastra
    |
    v
PlatformAgentInvoker
    |
    v
AgentService
    |
    v
AgentRunner
    |
    v
Codex
```

Do not implement a second worker runtime inside Mastra.

---

## 2.4 Persistent workspace and runtime remain separate

Future preview support preserves the existing disposable worker model.

```text
Persistent workspace
        |
        +--> disposable Codex worker
        |
        +--> longer-lived preview runtime
```

Do not make Codex worker containers permanent merely to host generated apps.

---

## 2.5 Agents do not receive unrestricted infrastructure control

Do not expose Docker, Podman, host mounts, provider credentials, or privileged runtime configuration directly to the Agent.

Target:

```text
Agent
  |
  | controlled request
  v
Middleware Service
  |
  +--> validation
  +--> authorization
  +--> policy
  +--> lifecycle
  +--> resource limits
  +--> logging
  |
  v
Runtime operation
```

---

## 2.6 Roles, skills, tools, and permissions are distinct concepts

Use:

```text
Role
  |
  +--> Skills
  +--> Tools
  +--> Permissions
```

Definitions:

```text
Role
= reusable user-defined capability bundle

Skill
= reusable instructions/knowledge/behavior

Tool
= executable platform capability

Permission
= backend-enforced authority to perform an operation
```

Do not treat these as interchangeable.

---

# 3. Target Model Configuration Architecture

The product distinguishes two model scopes.

## Worker Agent model

Owned by the Agent.

Example:

```text
Alice
Provider: worker-supported provider
Model: selected-model-id
Reasoning: High
```

This follows Alice wherever Alice is invoked.

## Supervisor model

Owned by Team orchestration configuration.

Example:

```text
Team Supervisor
Provider: middleware provider
Model: selected-supervisor-model
Reasoning: Medium
```

The Team does not override each participant's worker model.

---

# 4. Updated Implementation Waves

## Wave status

```text
Wave 6   Per-Agent Models                          COMPLETE
Wave 7   Agent Preview Runtime                     COMPLETE
Wave 7.1 Shared Project Workspace + Preview        IMPLEMENTED
Wave 7.2 Private Agent Conversations               IMPLEMENTED
Wave 8   Roles / Skills / Tools / Permissions      NEXT
Wave 9   Observability
Wave 10  Failure / Recovery
Wave 11  Demo Hardening
Wave 12  Optional Expansion
```

The Project abstraction is a near-term core wave, not an optional future idea.
Still deferred: the 2D PixiJS collaborative workspace, parallel shared writes,
Git branch/merge collaboration, public deployment, production hosting, and
advanced browser automation.

## Completed Foundation

Treat the following as completed or substantially implemented:

- repository-owned orchestration interface
- Mastra orchestration integration
- migration away from LangGraph
- deterministic sequential orchestration
- middleware provider abstraction
- supervisor model plumbing
- supervisor orchestration mode
- Team UI
- shared Team conversation context
- bounded/redacted handoffs
- continuation lifecycle
- Team deletion lifecycle
- orchestration timeout and cancellation
- persistent orchestration turns/events
- shared Project workspace and canonical Project preview (Wave 7.1)
- first-class private Agent conversations, one Codex thread each (Wave 7.2)

The target collaboration model is:

```text
Team conversation + shared Project workspace + Project preview
```

Team participant preview aggregation is explicitly **not** the final solution:
it would expose several divergent copies of the same supposed app with no
canonical Team artifact.

---

# 5. Wave 6: Per-Agent Model Assignment and Capability Discovery

## Status

Current implementation priority.

Do not expand this wave while it is being implemented.

## Goal

Allow each platform Agent to persist and use its own worker model configuration while preserving the existing Codex worker/runtime boundary.

## Scope

- persisted worker `ModelRef`
- worker provider registry
- provider/model API
- dynamic model discovery where supported
- curated fallback/filtering
- reasoning capability metadata
- reasoning selector
- `WorkerModelResolver`
- backward-compatible defaults
- Create/Edit Agent model UI
- Agent detail model display
- Team participant model display
- runtime validation
- tests

## Runtime behavior

```text
Agent.modelRef
    |
    v
WorkerModelResolver
    |
    +--> validate provider
    +--> validate model
    +--> validate reasoning
    +--> map runtime configuration
    |
    v
AgentService / AgentRunner
    |
    v
Codex worker
```

Existing Agents without `modelRef` continue using the current default runtime model.

## Exit Criteria

Wave 6 is complete when:

- existing Agents without model config still run
- new/edit Agent can select a worker provider
- model list loads from backend
- dynamic discovery works where supported
- curated fallback works where required
- only worker-compatible models are selectable
- reasoning selector is capability-driven
- unsupported reasoning values cannot be submitted
- persisted `modelRef` is validated
- worker runtime receives selected model configuration
- unsupported provider/model/runtime combinations fail before execution
- credentials never reach React
- Playground respects Agent model assignment
- Team orchestration respects participant model assignment
- supervisor model remains separately configured
- tests cover backward compatibility and validation
- `npm run check` passes
- `git diff --check` passes

---

# 6. Wave 7: Agent Artifact Preview Runtime

## Status

```text
Wave 7
Agent Artifact Preview Runtime
Status: COMPLETE
```

Shipped in this wave:

- a separate long-lived preview runtime, distinct from the disposable Codex worker
- Agent-owned preview over the Agent's persistent workspace
- an embedded iframe preview in a collapsible right-side sidecar, with Open External as fallback
- start / restart / stop / logs lifecycle controls, with `Stop Server` kept distinct from Agent `Stop`
- persisted preview state, reconciled to `interrupted` after a control-plane restart
- bounded, redacted runtime logs
- read-only preview status injected into the Agent execution context only, never into persisted messages
- no infrastructure control exposed to the Agent: no ports, runtime IDs, host paths, or container engine access

## Goal

Allow applications created by Agents inside persistent workspaces to be executed and viewed without changing the disposable Codex worker-runtime model.

The first version is a safe local preview, not production deployment.

## 6.1 Target architecture

```text
                         Persistent Agent Workspace
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
             Codex Worker Runtime        Preview Runtime
             disposable per turn         longer-lived
                    |                           |
                    | writes files              | serves app
                    +-------------+-------------+
                                  |
                                  v
                           Agent-created app
```

Both runtimes may mount the same owning Agent workspace.

The files are shared.

The processes are separate.

---

## 6.2 Preview runtime abstraction

Introduce:

```text
apps/server/src/preview/
    preview-service.ts
    preview-runtime.ts
    local-container-preview-runtime.ts
    preview-types.ts
```

Conceptual interface:

```ts
interface PreviewRuntime {
  start(input: PreviewStartInput): Promise<PreviewHandle>;
  get(id: string): Promise<PreviewHandle | null>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<PreviewHandle>;
  logs(id: string): Promise<PreviewLog[]>;
}
```

The initial implementation should use the existing local container-engine approach.

Do not introduce Dagger in the first implementation.

Keep the runtime abstraction clean so another implementation may be added later.

---

## 6.3 PreviewService

`PreviewService` owns platform policy and lifecycle around the runtime.

Responsibilities:

- validate Agent exists
- validate workspace ownership
- authorize preview operation
- allocate safe host port
- start preview runtime
- persist preview state
- expose safe preview URL
- return bounded logs
- stop/restart preview
- cleanup on Agent deletion where appropriate
- reconcile stale preview state after backend restart

Conceptually:

```text
UI / Agent tool request
        |
        v
PreviewService
        |
        +--> authorization
        +--> ownership validation
        +--> lifecycle
        +--> persistence
        |
        v
PreviewRuntime
        |
        v
local container engine
```

---

## 6.4 Minimal authorization hook

Wave 7 should introduce an authorization boundary even before full role support exists.

Example:

```ts
interface AuthorizationService {
  require(input: {
    agentId: string;
    permission: PermissionId;
  }): Promise<void>;
}
```

Preview operations should call permissions such as:

```text
preview.inspect
preview.start
preview.restart
preview.stop
preview.logs
```

The first implementation may use a simple default/allowlisted policy.

Do not hardcode:

```ts
if (agent.role === "developer")
```

Wave 8 will replace/extend the simplistic policy with full role-driven access resolution.

---

## 6.5 Preview API

Suggested endpoints:

```text
POST /api/agents/:id/preview/start
GET  /api/agents/:id/preview
POST /api/agents/:id/preview/restart
POST /api/agents/:id/preview/stop
GET  /api/agents/:id/preview/logs
```

---

## 6.6 Frontend preview experience

Keep it focused.

```text
Agent

[ Chat ] [ Preview ]

+--------------------------------------+
|                                      |
|         Agent-created app            |
|                                      |
+--------------------------------------+

Status: Running

[ Restart ] [ Stop ] [ Open ]
```

Surface:

- starting
- running
- stopped
- failed
- restart state
- bounded logs where useful

Do not turn Wave 7 into a full IDE.

---

## 6.7 Agent interaction with preview

The preview runtime should not be UI-only.

Agents should be able to request controlled operations:

```text
preview_start
preview_status
preview_logs
preview_restart
preview_stop
```

The Agent must not receive unrestricted Docker/Podman access.

Target:

```text
Codex Agent
    |
    | controlled operation
    v
Preview middleware
    |
    +--> authorize
    +--> validate Agent/workspace
    +--> enforce lifecycle
    +--> enforce resource limits
    |
    v
Preview Runtime
```

---

## 6.8 Expected workflow

```text
User:
"Create a React todo app."
        |
        v
Agent writes code
        |
        v
Agent runs build/tests
        |
        v
Agent requests preview start
        |
        v
PreviewService starts app
        |
        v
Agent checks preview status/logs
        |
        v
User sees app
        |
        v
Agent edits files later
        |
        v
Preview observes latest workspace state
```

Where supported, hot reload may update the preview automatically.

Otherwise restart preview.

---

## 6.9 Security invariants

- Agent cannot access container-engine socket directly
- preview only mounts owning Agent workspace
- arbitrary host mount paths are rejected
- backend allocates ports
- preview uses bounded CPU/memory/process resources
- preview URLs expose no provider credentials
- logs are bounded and sanitized
- Agent deletion performs defined preview cleanup
- backend restart reconciles stale preview state
- public deployment remains separate
- preview permissions are backend-enforced

---

## 6.10 Explicit non-goals

Do not include:

- production hosting
- Vercel deployment
- ECS deployment
- Kubernetes
- public domains
- unrestricted host networking
- arbitrary Docker commands
- shared multi-Agent workspace
- mandatory Playwright automation
- production-grade multi-tenant sandboxing

---

## 6.11 Exit Criteria

Wave 7 is complete when:

- Agent-created app files persist after worker container termination
- backend can start a separate preview runtime
- browser can display/open the app
- preview can survive individual Codex turns
- subsequent Agent file edits remain available
- preview status/logs are available
- preview can stop/restart
- Agent stop/delete cleanup behavior is defined
- Agent can request approved preview operations
- Agent cannot directly control container engine
- existing Playground and Team orchestration still work
- `npm run check` passes
- `git diff --check` passes

---

# 6A. Wave 7.1: Shared Project Workspace and Project Preview

## Status

```text
Wave 7.1
Shared Project Workspace + Project Preview
Status: IMPLEMENTED
```

## Why this was promoted ahead of Wave 8

Team collaboration is a core product differentiator, and text-only handoff is
insufficient for artifact collaboration. Before this wave, each Agent owned an
isolated workspace, so a Team failed in a concrete way:

```text
Agent A builds the app in Agent A's workspace
        |
        v
Agent A tries to hand off the file path
        |
        v
handoff redaction removes it (correctly)
        |
        v
Agent B's own workspace has no frontend files
        |
        v
collaboration stalls
```

The fix is a first-class `Project` that owns the shared artifact — not weaker
redaction, and not per-Agent preview aggregation, which would still leave
divergent copies with no canonical Team artifact.

## 6A.1 Ownership model

```text
Agent  -> identity, instructions, worker model, private session, private workspace
Project -> shared workspace, canonical artifact, Project preview, write coordination
Team    -> participants, supervisor, conversation, routing
```

The Team coordinates **who works next**. The Project defines **what shared
artifact they work on**.

## 6A.2 Workspace model

```text
Individual execution:
Agent -> Agent private workspace

Collaborative execution:
Team -> Project -> shared Project workspace
```

Agent-private workspaces remain fully supported. A Team without a `projectId`
behaves exactly as before, and existing Teams are never silently migrated.

## 6A.3 Project-scoped execution

Project turns extend the normal Agent path rather than adding a second worker
runtime. Mastra still routes through `PlatformAgentInvoker` into `AgentService`;
only the mounted workspace and the resumed session change.

```text
Mastra -> PlatformAgentInvoker -> AgentService.sendMessage({ agentId, prompt, projectId })
       -> AgentRunner -> disposable Codex runtime -> shared Project workspace
```

Two consequences worth recording, because neither was obvious:

- **Identity.** A directory holds one `AGENTS.md`, and it is the only channel
  carrying Agent instructions into the worker. The platform rewrites it for the
  acting Agent at the start of each Project turn, which is what preserves
  separate identities on one shared artifact. The write lease serializes turns,
  so this cannot race.
- **Sessions.** `codexThreadId` is scoped per (Agent, Project). An Agent's
  private Playground thread is never resumed against the shared filesystem, and
  the shared thread never leaks back into private work.

## 6A.4 Single-writer coordination

```text
At most one Agent may perform a Project-scoped mutable turn at a time.
```

A blocked turn waits briefly for the lease before failing with `PROJECT_BUSY`,
so ordinary overlap between a Playground turn and a Team run resolves itself.
The lease is persisted, released on success, failure, and cancellation, and any
lease found at boot is reconciled as stale.

## 6A.5 Preview ownership

Two preview owners are supported over one shared `PreviewRuntime`:

```text
Agent Preview   -> an individual Agent's private workspace
Project Preview -> the shared workspace; canonical for collaborative Team work
```

The Project preview mounts only the Project workspace, survives participant turn
changes, and is independent of the currently speaking Agent. Stopping the Team
does not stop it, matching the existing "closing and stopping are separate"
preview philosophy.

## 6A.6 Handoff semantics are unchanged

Redaction stays exactly as it was. Collaboration is fixed by giving both Agents
the same logical workspace, not by leaking host paths into conversation. Handoffs
carry status, an artifact summary, Project-relative paths, tests run, and the next
recommended action.

## 6A.7 Playground and Team conversations stay separate

Orchestration-authored prompts still reach `AgentService` and `AgentRunner`
unchanged, including their execution context. They are tagged at the runtime
boundary so the Agent Playground never renders them as user-authored messages;
they remain visible in the Team conversation and timeline, and remain persisted
for audit.

## 6A.8 Exit criteria

- Project is a persisted first-class resource owning a shared workspace
- a Team can be attached, and its participant Agents attached with it
- Agent A's changes are visible to Agent B and vice versa
- Agents never exchange host workspace paths
- single-writer coordination prevents unsafe concurrent mutation
- one canonical Project preview serves the shared workspace
- Agent-private mode, Agent preview, and existing Teams remain backward compatible

---

# 6B. Wave 7.2: Private Agent Conversations

## Status

```text
Wave 7.2
First-class private Agent conversations
Status: IMPLEMENTED
```

## Session scopes

An Agent's private Playground is no longer one permanent thread. Direct work is
organised into conversations, each owning its own Codex session:

```text
Agent
├── Private workspace                  (one, shared by every conversation)
│   ├── Conversation A -> Codex thread A
│   ├── Conversation B -> Codex thread B
│   └── Agent Preview                  (Agent-owned, not per conversation)
│
└── Project attachments
    └── per-(Agent, Project) Project thread
```

There are now three distinct session scopes, and they never borrow each other's
threads:

```text
direct turn          -> conversation.codexThreadId
Project turn         -> projectAgents[].codexThreadId
Team turn, no Project -> agent.codexThreadId
```

## What a conversation is and is not

```text
New conversation
= fresh messages + fresh Codex thread + THE SAME Agent workspace

Delete conversation
= that conversation, its messages, and its runs
+ KEEP the Agent, its workspace files, its other conversations,
  its Project attachments, and all Team history
```

There is deliberately no workspace per conversation and no preview per
conversation. Files created in one conversation are visible from the next,
which is the point: a new conversation is a clean session over the same work.

## Migration

Pre-conversation direct history is adopted into one default conversation per
Agent, titled from its first user message. The old `Agent.codexThreadId`
represented that private scope, so it **moves** onto the conversation rather
than being copied — leaving it on the Agent as well would let a Team turn and a
private turn resume the same thread. Project threads are never touched.

## Titles

A conversation starts as `New conversation` and is renamed from the user's first
direct message. This is a deterministic string operation, not a second model
call. Manual rename is always available.

## Message isolation

Orchestration turns still reach `AgentService` and `AgentRunner` with their full
execution context; they are tagged `origin: "orchestration"` at the runtime
boundary and carry no `conversationId`, so they appear in no private
conversation while remaining visible in the Team conversation and timeline.

## Team conversations

The Team conversation uses the same `StickyComposer` as the Agent Playground, so
the two cannot drift apart. Only the message region scrolls; the composer is a
flex sibling, never `position: fixed`. While a participant is executing, the
composer stays mounted but disabled and names who is working. A follow-up
continues the same Team, participants, history, Project, shared workspace, and
Project preview — it never creates a second Team or Project.

## Rendering

Agent output is rendered through one shared `MarkdownMessage` component in both
the Playground and the Team conversation. It builds React elements — no
`dangerouslySetInnerHTML`, and raw HTML in model output is not parsed. User
prompts and status cards such as "Could not finish" stay plain components.

---

# 7. Wave 8: User-Defined Agent Roles, Skills, Tools, and Permission Enforcement

## Goal

Allow users to create reusable Agent roles that define which skills, tools, and backend-enforced permissions an Agent receives by default.

Users should have freedom to define their own roles.

Do not hardcode Planner, Developer, Reviewer, or similar names as system behavior.

They may exist as starter templates only.

---

## 7.1 Core model

```text
Role
  |
  +--> skillIds[]
  +--> toolIds[]
  +--> permissionIds[]
```

Suggested type:

```ts
type AgentRole = {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  toolIds: string[];
  permissionIds: string[];
  createdAt: string;
  updatedAt: string;
};
```

Agent:

```ts
type AgentAccessConfig = {
  roleId?: string;
  additionalSkillIds?: string[];
  grants?: string[];
  denies?: string[];
};
```

Effective permissions:

```text
Role permissions
    +
Agent grants
    -
Agent denies
    =
Effective permissions
```

Explicit deny wins.

---

## 7.2 Ownership model

### User-defined

Users may define:

- Role name
- Role description
- skills attached to a Role
- tools attached to a Role
- permissions selected from platform-supported permissions
- custom skills
- Agent-specific overrides

### Platform-defined

The platform defines:

- executable tool implementations
- permission identifiers
- backend authorization checks
- runtime enforcement
- privileged infrastructure boundaries

Users must not be able to invent an executable tool merely by submitting a string.

---

## 7.3 Skills

A skill is reusable guidance/knowledge/behavior.

Suggested type:

```ts
type SkillDefinition = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  capabilityTags?: string[];
  source: "built-in" | "user" | "installed";
  version?: string;
  createdAt?: string;
  updatedAt?: string;
};
```

Examples:

```text
System Design
React Application Development
Backend API Design
Debugging
Testing
Code Review
Task Decomposition
```

Skills may inject instructions into the Agent runtime context.

Skills do not automatically grant executable permissions.

---

## 7.4 Tools

A tool is an executable platform capability.

Examples:

```text
filesystem
shell
preview
browser
docs-search
git
http
```

Suggested metadata:

```ts
type ToolDescriptor = {
  id: string;
  name: string;
  description: string;
  requiredPermissions: string[];
};
```

Tools are platform-provided.

The frontend lists backend-provided tools.

The backend validates role assignments.

---

## 7.5 Permissions

Permissions represent actual authority.

Examples:

```text
workspace.read
workspace.write
shell.execute
preview.inspect
preview.start
preview.restart
preview.stop
preview.logs
browser.test
network.outbound
skills.search
skills.install
skills.remove
```

Future:

```text
deploy.preview
deploy.production
secrets.use
database.read
database.write
```

Permissions are backend-defined and backend-enforced.

---

## 7.6 Role examples

These are examples only, not hardcoded system roles.

### Planner

```text
Skills
- System Design
- Task Decomposition
- Requirements Analysis

Tools
- Filesystem Read
- Docs Search
- Preview

Permissions
- workspace.read
- preview.inspect
- preview.logs
```

### Full Stack Engineer

```text
Skills
- Frontend Development
- Backend Development
- Debugging
- Testing

Tools
- Filesystem
- Shell
- Preview
- Git

Permissions
- workspace.read
- workspace.write
- shell.execute
- preview.inspect
- preview.start
- preview.restart
- preview.logs
```

### Reviewer

```text
Skills
- Code Review
- Testing

Tools
- Filesystem Read
- Preview

Permissions
- workspace.read
- preview.inspect
- preview.logs
```

Users may create entirely different roles.

---

## 7.7 Backend architecture

Suggested:

```text
apps/server/src/access/
    authorization-service.ts
    role-service.ts
    permission-registry.ts
    effective-access.ts
    types.ts

apps/server/src/tools/
    tool-registry.ts
    tool-gateway.ts
    types.ts

apps/server/src/skills/
    skill-service.ts
    skill-registry.ts
    skill-source.ts
    types.ts
```

---

## 7.8 Effective access resolution

At runtime:

```text
Agent
  |
  v
load role
  |
  +--> skills
  +--> tools
  +--> permissions
  |
  +--> Agent-specific grants
  +--> Agent-specific denies
  |
  v
EffectiveAgentCapabilities
```

The backend may expose a safe computed view:

```text
GET /api/agents/:id/capabilities
```

React should render that response rather than calculating policy independently.

---

## 7.9 Tool enforcement

A tool request should flow through a trusted gateway.

```text
Agent
  |
  | tool request
  v
ToolGateway
  |
  v
AuthorizationService
  |
  +--> permission allowed?
  |
  +--> yes -> execute
  |
  +--> no -> POLICY_DENIED
```

Prompt instructions are not enforcement.

---

# 8. Wave 8A: Skill Discovery and Installation

This is part of Wave 8, but should be implemented only after the basic SkillRegistry and authorization model are working.

## Goal

Allow users or Agents to search for reusable skills and install them into the backend SkillRegistry.

The Agent may request skill discovery/installation, but the backend remains authoritative.

---

## 8.1 Skill source architecture

```text
Frontend / Agent
        |
        | search skill
        v
SkillService
        |
        v
SkillSourceAdapter
        |
        +--> built-in catalog
        +--> approved remote registry
        +--> approved Git-backed source
        +--> future external skill marketplace
        |
        v
Skill candidates
```

Do not let React call external skill sources directly.

Do not let Codex run arbitrary remote install scripts.

---

## 8.2 Agent-requested skill discovery

Example:

```text
User:
"Find a React testing skill and install it."
        |
        v
Agent requests skills.search
        |
        v
AuthorizationService
        |
        v
SkillService.search(...)
        |
        v
Candidate skills returned
        |
        v
Agent/user selects candidate
        |
        v
skills.install authorization
        |
        v
SkillValidationService
        |
        v
SkillRegistry.install(...)
```

---

## 8.3 Skill installation boundary

Treat a basic skill as:

```text
metadata
instructions
capability tags
version
source metadata
```

Do not treat it as arbitrary executable code.

If a skill requires:

- npm packages
- shell commands
- executable scripts
- browser access
- network access
- additional tools

those remain separate capabilities and permissions.

Installing a skill must not silently grant those capabilities.

---

## 8.4 Suggested skill operations

```text
skill.search
skill.inspect
skill.install
skill.remove
```

Permissions:

```text
skills.search
skills.install
skills.remove
```

Role configuration may control which Agents can perform these operations.

---

## 8.5 Skill validation

Before installation validate:

- source is approved
- manifest/schema is valid
- ID and version are normalized
- instructions are bounded
- metadata contains no secrets
- executable payload is rejected in the basic skill format
- duplicate/version conflict behavior is defined

Normalize external content before persistence.

---

## 8.6 Market skill metadata

Market taxonomies may be added later as metadata, not as frontend authority.

Optional future architecture:

```text
ESCO / O*NET / curated market source
        |
        v
Backend import/normalization
        |
        v
Capability Registry
        |
        v
SkillDefinition.capabilityTags[]
```

Example:

```text
Agent skill:
Frontend Development

Capability tags:
- react
- typescript
- testing
- accessibility
```

Market capability labels and Agent behavioral skills remain separate concepts.

---

# 9. Wave 8 Frontend

## Role management

Add:

```text
Roles

[ Create Role ]

Role Name
[ Full Stack Engineer ]

Description
[ ... ]

Skills
[x] Frontend Development
[x] Backend Development
[x] Testing

Tools
[x] Filesystem
[x] Shell
[x] Preview

Permissions
[x] workspace.read
[x] workspace.write
[x] shell.execute
[x] preview.start

[ Save Role ]
```

---

## Skill management

Add:

```text
Skills

[ Search Skills ]
[ Create Skill ]

Installed
- System Design
- React Development
- Testing
```

Custom skill editor:

```text
Name
Description
Instructions
Capability Tags
```

---

## Agent creation/edit

Add role assignment:

```text
Role
[ Full Stack Engineer ▼ ]

Inherited Skills
- Frontend Development
- Backend Development
- Testing

Inherited Tools
- Filesystem
- Shell
- Preview

Advanced Overrides
[ ... ]
```

The UI may explain effective access, but backend calculation is authoritative.

---

# 10. Wave 8 API Surface

Suggested endpoints:

```text
GET    /api/roles
POST   /api/roles
GET    /api/roles/:id
PATCH  /api/roles/:id
DELETE /api/roles/:id

GET    /api/skills
POST   /api/skills
GET    /api/skills/:id
PATCH  /api/skills/:id
DELETE /api/skills/:id

GET    /api/skills/search?q=...
POST   /api/skills/install

GET    /api/tools
GET    /api/permissions

GET    /api/agents/:id/capabilities
```

Agent create/update may include:

```json
{
  "access": {
    "roleId": "role-id",
    "additionalSkillIds": [],
    "grants": [],
    "denies": []
  }
}
```

All referenced IDs are validated server-side.

---

# 11. Wave 8 Security Invariants

- backend is authoritative for effective permissions
- React never decides enforcement
- role names carry no special behavior
- users cannot invent executable tools
- users cannot invent permission IDs
- tool use is checked at execution time
- skill installation does not implicitly grant tools
- skill installation does not implicitly grant permissions
- arbitrary remote code is not installed as a skill
- external skill source responses are normalized
- denies override grants
- Agent output cannot alter its own role directly unless explicitly authorized
- supervisor cannot bypass worker Agent permissions
- Agent-specific overrides remain backend-validated
- secrets are excluded from skill definitions and UI responses

---

# 12. Wave 8 Exit Criteria

Wave 8 is complete when:

- users can create/edit/delete custom roles
- roles persist
- users can attach skills to roles
- users can attach platform-provided tools to roles
- users can select platform-defined permissions
- Agents can reference a role
- effective capabilities are computed by backend
- Agent grants/denies are supported or explicitly deferred
- permission checks occur at runtime
- denied tool operation produces normalized policy error
- preview operations use the same authorization layer
- users can create custom non-executable skills
- skill registry is backend-owned
- skill search works against at least one approved source
- authorized Agent can request skill search
- authorized Agent can request skill installation
- installed skill can be attached to a role
- installing a skill does not automatically grant executable tools
- frontend displays backend-provided roles/skills/tools/permissions
- no hardcoded Planner/Developer behavior exists
- tests cover role resolution and denial paths
- tests cover skill installation validation
- `npm run check` passes
- `git diff --check` passes

---

# 13. Wave 9: Orchestration Observability and Evidence

## Goal

Make Team and Agent execution understandable without exposing private chain-of-thought.

## Scope

Add:

- correlation IDs
- orchestration/session ID
- Run ID correlation
- participant identity
- worker model/provider metadata where safe
- supervisor routing decision metadata
- role metadata
- effective tool/permission metadata where useful
- policy decisions
- skill installation events
- preview lifecycle events
- step timing
- Run timing
- participant status
- timeout/cancellation evidence
- user-facing Team execution timeline
- operator/developer details where useful

Example:

```text
Supervisor selected Alice
        |
        v
Alice
Role: Full Stack Engineer
Model: Model A
        |
        +--> preview.start ALLOW
        |
        +--> shell.execute ALLOW
        |
        v
Run completed
```

Do not expose private chain-of-thought.

---

# 14. Wave 10: Failure and Recovery

## Goal

Provide a clear and demonstrable reliability story.

## Possible scope

- controlled Agent timeout fixture
- safe cancellation
- preview startup failure
- stale preview cleanup
- interrupted orchestration reconciliation
- policy denial scenario
- invalid skill installation scenario
- unavailable skill source
- explicit retry only where side effects are safe
- visible recovery evidence
- recovery tests

Avoid automatic retry around Codex side effects unless idempotency has been addressed.

Example:

```text
Agent requests preview.start
        |
        v
AuthorizationService
        |
        v
DENY
        |
        v
POLICY_DENIED event
        |
        v
Team remains understandable
```

Or:

```text
Preview fails to start
        |
        v
bounded logs captured
        |
        v
Agent fixes application
        |
        v
preview restart succeeds
```

---

# 15. Wave 11: Demo Hardening

## Goal

Turn the middleware into a concise, reproducible judging story.

## Deliverables

- one normal multi-Agent scenario
- one policy denial or failure/recovery scenario
- one Agent-created application preview if stable
- README
- architecture diagram
- reproducible local setup
- demo script under three minutes
- automated checks
- no secrets
- documented limitations

## Suggested demo

```text
1. Show reusable custom role
2. Show role skills/tools/permissions
3. Create/select Agents with different roles/models
4. Create Team
5. Supervisor routes work
6. Agent creates application
7. Agent starts preview through allowed middleware permission
8. Another Agent attempts restricted operation
9. Backend denies it
10. Show timeline/evidence
```

This demonstrates:

- model abstraction
- orchestration
- persistent workspace
- preview runtime
- role-based capability assignment
- backend policy enforcement
- observability

---

# 16. Wave 12: Optional Expansion

Only start after the core demo is stable.

Candidates:

- controlled Playwright/browser automation
- project-level shared workspaces
- parallel orchestration
- human approval
- budget controls
- deeper tracing
- durable orchestration resume
- provider failover
- human/user RBAC
- public deployment
- deployment approval workflow
- richer skill marketplace
- market skill taxonomy import
- tool plugin marketplace
- artifact/version management

---

# 17. Future Project-Level Shared Workspace

This remains separate from the current per-Agent workspace model and is intentionally deferred until the core Agent, preview, role, and authorization boundaries are stable.

## 17.1 Current limitation

Today, the persistent workspace belongs to the Agent.

```text
Alice
  |
  v
/workspaces/alice/
  |
  +--> Alice's files

Bob
  |
  v
/workspaces/bob/
  |
  +--> Bob's files
```

Team shared conversation allows Agents to exchange bounded textual context, but it does not make their filesystems shared.

Example:

```text
User:
"Build a todo application."
        |
        v
Supervisor selects Alice
        |
        v
Alice creates application files
        |
        v
Alice reports progress into Team conversation
        |
        v
Supervisor selects Bob
        |
        v
Bob can read Alice's handoff
        |
        x
Bob cannot automatically edit Alice's files
```

This is acceptable for the current architecture because Agent private workspace ownership remains simple and isolated.

---

## 17.2 Future Project abstraction

A later architecture may introduce a first-class `Project`.

Conceptually:

```text
Project: Todo App
        |
        +--> Team
        |
        +--> Shared Project Workspace
        |
        +--> Preview Runtime
        |
        +--> Project lifecycle
```

Example filesystem:

```text
/projects/todo-app/
├── package.json
├── src/
├── tests/
└── README.md
```

Multiple Agents may then operate against the same project resource.

```text
                    Todo App Project
                           |
                           v
                 Shared Project Workspace
                           ^
                           |
              +------------+------------+
              |            |            |
            Alice         Bob        Charlie
           Planner      Developer     Reviewer
```

The important distinction becomes:

```text
Agent owns:
- private identity
- private Codex/runtime thread
- worker model assignment
- role
- private memory/state

Project owns:
- collaborative code/files
- preview runtime
- project-level lifecycle
- shared artifact state
```

---

## 17.3 Example collaborative workflow

With a Project workspace, a Team could collaborate on the same application.

```text
User:
"Build a todo application."
        |
        v
Supervisor selects Alice
        |
        v
Alice / Planner
reads project workspace
creates architecture plan
        |
        v
Supervisor selects Bob
        |
        v
Bob / Developer
reads same project workspace
implements React application
        |
        v
Supervisor selects Charlie
        |
        v
Charlie / Reviewer
reads Bob's actual source files
runs review/tests
        |
        v
Charlie reports bug
        |
        v
Supervisor selects Bob
        |
        v
Bob edits same project
        |
        v
Project Preview Runtime reloads
```

This is materially different from the current Team handoff model because Agents collaborate through both:

```text
Shared Team conversation
+
Shared Project workspace
```

---

## 17.4 Project-level authorization

The existing role/permission system should eventually extend from Agent-owned resources to Project-owned resources.

Possible permissions:

```text
project.read
project.write
project.shell.execute
project.preview.inspect
project.preview.start
project.preview.restart
project.preview.stop
project.git.commit
```

Example:

```text
Alice / Planner
├── project.read              ALLOW
├── project.write             DENY
└── project.preview.inspect   ALLOW

Bob / Developer
├── project.read              ALLOW
├── project.write             ALLOW
├── project.shell.execute     ALLOW
└── project.preview.start     ALLOW

Charlie / Reviewer
├── project.read              ALLOW
├── project.write             DENY
└── project.preview.inspect   ALLOW
```

The backend remains the source of truth.

The supervisor may choose which Agent should work next, but it does not bypass Project permissions.

```text
Supervisor selects Bob
        |
        v
Bob requests project.write
        |
        v
AuthorizationService
        |
        +--> allowed -> execute
        |
        +--> denied  -> POLICY_DENIED
```

---

## 17.5 Preview ownership changes

Wave 7 initially uses an Agent-owned preview model:

```text
Agent
  |
  v
Agent workspace
  |
  v
Preview Runtime
```

With Projects, preview ownership should move to the Project:

```text
Project
  |
  v
Shared Project Workspace
  |
  v
Project Preview Runtime
  |
  v
Application
```

This avoids creating separate previews for each Agent when they are collaborating on the same artifact.

Agents request preview operations against the Project through middleware.

```text
Agent
  |
  | project.preview.start
  v
AuthorizationService
  |
  v
ProjectPreviewService
  |
  v
Project Preview Runtime
```

---

## 17.6 Concurrency and write coordination

Shared Project workspaces introduce concurrency problems that do not exist with isolated Agent workspaces.

Example:

```text
Alice                     Bob
  |                         |
  v                         v
src/App.tsx              src/App.tsx
  |                         |
  v                         v
WRITE                     WRITE
      \                   /
       \                 /
        SAME PROJECT FILE
```

Before allowing parallel file mutation, define a coordination strategy.

### Recommended first implementation: single-writer orchestration

```text
Only one Agent may hold project.write at a time.
```

This maps naturally to the current supervisor-driven turn model.

```text
Supervisor chooses Bob
        |
        v
Bob receives temporary project.write capability
        |
        v
Bob completes turn
        |
        v
write lease released
```

Later options may include:

- per-Agent Git branches
- optimistic file version checks
- explicit file locks
- merge/review flows
- parallel non-overlapping work

Do not introduce parallel shared writes before a conflict strategy exists.

---

## 17.7 Project lifecycle and persistence

A Project should eventually have its own persisted record.

Conceptually:

```ts
type Project = {
  id: string;
  name: string;
  description?: string;
  workspacePath: string;
  teamId?: string;
  previewId?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};
```

Potential APIs:

```text
POST   /api/projects
GET    /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id

POST   /api/projects/:id/agents/:agentId/attach
DELETE /api/projects/:id/agents/:agentId

POST   /api/projects/:id/preview/start
GET    /api/projects/:id/preview
POST   /api/projects/:id/preview/stop
```

Exact API shape should be chosen only when this wave is implemented.

---

## 17.8 Migration from Agent preview to Project preview

Do not rewrite Wave 7 immediately.

Recommended progression:

```text
Wave 7
Agent-owned workspace
    |
    v
Agent-owned preview

Future Project wave
    |
    v
Project owns shared workspace
    |
    v
Project owns preview
```

`PreviewRuntime` should remain generic enough that the owning resource may later be either:

```text
Agent
or
Project
```

This reduces migration cost.

---

## 17.9 Exit criteria for future Project workspace wave

The future Project workspace capability is complete when:

- Project is a first-class persisted entity
- Project owns a shared workspace
- multiple Agents can be attached to a Project
- Team Agents can read the same project files
- backend enforces project-level permissions
- only authorized Agents may modify project files
- first implementation prevents unsafe concurrent writes
- Project preview serves the shared workspace
- Agent private Codex/session state remains private
- Team conversation remains separate from filesystem state
- Agent deletion does not accidentally delete a shared Project
- Project archive/delete behavior is explicit
- tests cover ownership, authorization, and conflict prevention
- `npm run check` passes
- `git diff --check` passes

---

# 18. Future 2D Collaborative Workspace Experience

The 2D workspace should come **after** the Project abstraction, not before it.

The reason is architectural: the 2D scene should visualize real backend entities and state rather than inventing its own parallel model of Agents, files, tasks, and previews.

## 18.1 Product goal

Provide a visual collaborative workspace where users can see:

- which Agents belong to a Project
- what role each Agent has
- which Agent is currently active
- what task an Agent is performing
- which workspace/project resource it is interacting with
- preview/application state
- orchestration handoffs
- permission denials or approvals
- completed artifacts

The 2D UI remains an experience layer.

It does not become the source of truth.

---

## 18.2 Target architecture

```text
                           Backend Source of Truth
                                    |
          +-------------------------+-------------------------+
          |                         |                         |
          v                         v                         v
       Project                  Team/Agents              Preview
          |                         |                         |
          +-------------------------+-------------------------+
                                    |
                                    v
                             Event / State API
                                    |
                                    v
                              React 2D Workspace
```

The 2D workspace renders backend state such as:

```text
Project
├── Alice / Planner / thinking
├── Bob / Developer / editing
├── Charlie / Reviewer / waiting
├── Shared Workspace
└── Preview / running
```

---

## 18.3 Example visual model

Conceptually:

```text
+----------------------------------------------------------+
| Todo App Project                                         |
|                                                          |
|   [ Planning Desk ]          [ Dev Workstation ]         |
|                                                          |
|      Alice                       Bob                     |
|     Planner                    Developer                 |
|     thinking                   editing                   |
|                                                          |
|                      [ Shared Project ]                  |
|                         workspace                        |
|                                                          |
|   [ Review Desk ]             [ Preview Screen ]         |
|                                                          |
|      Charlie                  Todo App Running           |
|      Reviewer                   [ Open ]                 |
|      waiting                                             |
+----------------------------------------------------------+
```

The visual positions are presentation only.

The underlying state still comes from backend records and events.

---

## 18.4 Agent activity states

The backend should expose normalized activity rather than making React infer it from text.

Possible states:

```text
idle
queued
thinking
working
waiting
reviewing
testing
previewing
blocked
failed
completed
```

Example backend view:

```json
{
  "agentId": "alice",
  "projectId": "todo-app",
  "activity": "working",
  "currentAction": "Editing project files",
  "currentRunId": "run-123"
}
```

React can map these states into animation and movement.

---

## 18.5 Event-driven visualization

The 2D UI should consume existing/future observability events.

Examples:

```text
supervisor_decision
agent_dispatched
tool_requested
tool_allowed
tool_denied
workspace_write_started
workspace_write_completed
preview_started
preview_failed
skill_installed
run_completed
```

Possible visual behavior:

```text
supervisor selects Bob
        |
        v
Bob walks to Dev Workstation

Bob requests project.write
        |
        v
write allowed

Bob edits project
        |
        v
Dev workstation shows active state

Preview reloads
        |
        v
Preview monitor updates
```

The animation is a projection of middleware state.

---

## 18.6 Project resources as visual stations

The 2D environment can represent platform resources as stations.

Examples:

```text
Planning Desk
- system design
- task decomposition
- docs

Developer Workstation
- project workspace
- shell
- git

Review Station
- code review
- tests

Preview Screen
- running application

Skill Library
- browse/search installed skills

Tool Cabinet
- visible tool capabilities

Deployment Station
- future controlled deployment
```

These stations should not create separate permissions.

They represent existing backend capabilities.

For example:

```text
Bob walks to Preview Screen
        |
        v
UI requests preview.inspect
        |
        v
backend authorization
        |
        +--> ALLOW
        |
        +--> DENY
```

---

## 18.7 Role and capability visualization

The 2D UI may expose an Agent card:

```text
Bob
Role: Full Stack Engineer

Skills
- React Development
- Backend Development
- Debugging

Tools
- Filesystem
- Shell
- Preview

Current permissions
- project.read
- project.write
- preview.start
```

This information comes from:

```text
GET /api/agents/:id/capabilities
```

or equivalent backend-computed state.

React must not derive effective authorization by itself.

---

## 18.8 User interaction

Possible interactions:

```text
click Agent
    |
    v
inspect Agent detail

click Project
    |
    v
open files / project activity

click Preview Screen
    |
    v
open running application

click Skill Library
    |
    v
browse installed/available skills

click event
    |
    v
open execution evidence
```

Future controlled commands may include:

```text
Start Team
Stop Team
Pause Agent
Assign Agent to Project
Open Preview
Approve privileged action
```

All actions still go through Fastify and backend services.

---

## 18.9 Do not couple orchestration to coordinates

Avoid architecture like:

```text
if Agent is standing at x=200:
    allow shell
```

Instead:

```text
Backend permission:
shell.execute = allowed

2D UI:
shows Agent at Developer Workstation
```

Coordinates and animations are never authorization state.

---

## 18.10 Recommended implementation order

The 2D workspace should be implemented after these foundations exist:

```text
1. Project abstraction
2. Shared Project workspace
3. Project-level permissions
4. Project preview ownership
5. Stable observability/event model
6. Then 2D workspace visualization
```

A sensible future sequence would be:

```text
Future Wave A
Shared Project Workspace

Future Wave B
2D Collaborative Workspace

Future Wave C
Advanced browser testing / deployment / HITL
```

---

## 18.11 Exit criteria for future 2D workspace

The 2D workspace is complete when:

- it renders Projects and attached Agents from backend state
- Agent roles and activity are visible
- current orchestration participant is visible
- Agent state changes are driven by backend events
- shared Project workspace is represented
- preview status is represented
- user can open the real preview from the scene
- policy denial/failure state can be visualized
- no authorization rule depends on UI coordinates
- refreshing the browser reconstructs the same logical state from backend data
- the existing non-2D APIs remain usable independently
- `npm run check` passes
- production build passes

---

# 19. Future Public Deployment

Local preview and public deployment are different capabilities.

Wave 7:

```text
Agent workspace
    |
    v
local preview runtime
    |
    v
temporary/local URL
```

Future:

```text
Agent workspace/artifact
    |
    v
deployment request
    |
    v
AuthorizationService
    |
    v
optional human approval
    |
    v
deployment provider
    |
    v
public URL
```

Public deployment is a strong approval boundary because it may:

- publish externally
- create cost
- expose data
- create persistent infrastructure
- create external side effects

Do not merge production deployment into basic preview lifecycle.

---

# 20. Cross-Wave Security Invariants

Preserve:

1. provider credentials stay server-side
2. browser receives safe metadata only
3. backend is the source of truth
4. Agent output cannot directly change privileged configuration
5. provider/model IDs are validated
6. raw provider errors are normalized
7. model listing is filtered to executable models
8. reasoning options are capability-driven
9. handoff redaction remains intact
10. worker model assignment cannot bypass runtime policy
11. supervisor-selected participants are validated
12. preview operations go through trusted middleware
13. Agents do not receive unrestricted container-engine access
14. preview workspace access is scoped
15. Role names do not imply permission without backend resolution
16. users cannot invent executable tool implementations
17. users cannot invent permission identifiers
18. tool operations are authorized at execution time
19. skill installation does not grant tools implicitly
20. skill installation does not grant permissions implicitly
21. arbitrary remote code is not installed as a basic skill
22. denies override grants
23. supervisor cannot bypass worker permissions
24. public deployment remains separate from local preview
25. private chain-of-thought is never exposed as observability data

---

# 21. Target End-to-End Architecture

After Wave 8:

```text
                                  React UI
                                     |
             +-----------------------+------------------------+
             |                       |                        |
             v                       v                        v
        Agent/Team API           Role/Skill API          Preview API
             |                       |                        |
             v                       v                        v
    OrchestrationService        RoleService              PreviewService
             |                  SkillService                  |
             v                       |                        |
      Mastra Orchestrator            |                        |
             |                       v                        |
      +------+-------+         SkillRegistry                  |
      |              |         ToolRegistry                   |
      v              v               |                        |
 Supervisor       routing            v                        |
      |                       AuthorizationService             |
      +---------------+---------------+------------------------+
                      |
                      v
            PlatformAgentInvoker
                      |
                      v
                 AgentService
                      |
              +-------+--------+
              |                |
              v                v
      WorkerModelResolver   Effective Access
              |                |
              +-------+--------+
                      |
                      v
                 AgentRunner
                      |
                      v
             Codex Worker Runtime
                      |
                      v
             Persistent Workspace
                      |
                      +--> Preview Runtime
```

Tool execution:

```text
Codex Agent
    |
    | tool request
    v
ToolGateway
    |
    v
AuthorizationService
    |
    +--> ALLOW -> execute platform tool
    |
    +--> DENY  -> POLICY_DENIED
```

Skill discovery:

```text
Agent / User
    |
    v
SkillService
    |
    v
SkillSourceAdapter
    |
    v
Skill candidate
    |
    v
validation
    |
    v
SkillRegistry
```

---

# 22. Final Product Story

The final middleware story should be easy to explain:

```text
User creates reusable roles
    |
    +--> chooses skills
    +--> chooses platform tools
    +--> chooses permissions
    |
    v
User creates specialized Agents
    |
    +--> assigns role
    +--> assigns worker model
    +--> Agent owns persistent workspace
    |
    v
User creates Team
    |
    +--> chooses participants
    +--> configures supervisor
    |
    v
Supervisor routes work
    |
    v
Each Agent runs with its own model and effective capabilities
    |
    v
Tool requests pass through backend authorization
    |
    v
Agents create real workspace artifacts
    |
    v
Preview middleware safely runs Agent-created apps
    |
    v
Agents may discover/install approved skills
    |
    v
Observability explains routing, policy, runtime, and failures
    |
    v
Failure controls keep execution bounded and understandable
```

The central principle is:

> Agents perform work, while middleware controls how that work is configured, routed, authorized, executed, exposed, observed, and contained.

---

# 23. Recommended Execution Order

```text
NOW
 |
 v
Wave 6
Per-Agent Model Assignment
 |
 | finish and stabilize
 v
Wave 7
Agent Artifact Preview Runtime
 |
 | include minimal authorization hook
 v
Wave 8
User-Defined Roles, Skills, Tools, Permissions
 |
 | then add approved skill discovery/install
 v
Wave 9
Observability and Evidence
 |
 v
Wave 10
Failure and Recovery
 |
 v
Wave 11
Demo Hardening
 |
 v
Wave 12
Optional Expansion
```

Do not interrupt Wave 6 to implement Wave 7 or Wave 8.

Finish the worker model boundary first, then add preview runtime, then build the reusable access-control and skill system on top of a real set of runtime capabilities.
