# Agent Launchpad: Design and Build Lightweight Agent Middleware

> Codex context document derived from the provided challenge brief. This
> document preserves the challenge's requirements, starter-kit
> boundaries, suggested middleware directions, demo expectations, and
> evaluation criteria in a code-agent-friendly Markdown format.

## 1. Challenge Overview

AI Agents are software actors that can reason, call tools, execute code,
read and write files, and continue work across multiple turns.

A useful Agent platform therefore needs more than a chat box. Operators
must be able to:

-   Understand what happened during an Agent run.
-   Control what an Agent may access.
-   Contain unsafe execution.

The starter kit intentionally provides the base application, control
plane, model connection, Agent Runtime, and deployment paths so teams
can spend the hackathon solving one meaningful Agent-infrastructure
problem.

### Goal

Design and demonstrate a coherent **middleware story** that improves the
Agent platform in a functional and testable way without breaking the
provided lifecycle or Playground.

Evaluation focuses on:

-   Relevance of the chosen capability.
-   Quality of implementation.
-   Technical design.
-   Integration with the existing platform.
-   Functional evidence.

Breadth is not the goal.

------------------------------------------------------------------------

## 2. Starter Kit Responsibilities

  -----------------------------------------------------------------------
  Area                    Provided by Starter Kit Team Responsibility
  ----------------------- ----------------------- -----------------------
  Product experience      React UI, Agent list,   Keep baseline working
                          Create/Edit forms,      and add only UI needed
                          lifecycle controls,     to expose middleware
                          Playground, Run status  

  Control plane           Fastify API,            Integrate real
                          validation,             middleware behavior
                          asynchronous Runs,      into backend path
                          AgentService, JSON      
                          persistence             

  Agent Runtime           Codex CLI, persistent   Integrate middleware at
                          sessions, per-Agent     the most appropriate
                          workspaces, disposable  execution boundary
                          local containers        

  Infrastructure          Docker, Colima, Podman, Use the smallest
                          Docker Compose, ECS     runtime path that
                          scripts, Terraform      proves the design;
                                                  cloud optional

  Middleware              Intentionally absent    Select, combine, adapt,
                                                  or invent coherent
                                                  middleware capabilities
  -----------------------------------------------------------------------

### What Already Works

The baseline can:

-   Create Agents from the browser.
-   Inspect Agents.
-   Edit Agents.
-   Start and stop Agents.
-   Delete Agents.
-   Send multi-turn tasks through the Playground.
-   Poll asynchronous Run status.
-   Let Codex CLI write files and run commands inside the selected Agent
    workspace.
-   Resume the same Codex session in later messages.
-   Persist Agent, message, and Run metadata in a local JSON store.
-   Run each local turn in a disposable Docker, Colima, or Podman
    container.
-   Connect Codex to a BytePlus ModelArk Responses-compatible endpoint.
-   Optionally deploy the POC to BytePlus ECS.
-   Optionally provision ECS infrastructure using Terraform.

### Important Extension Seams

The challenge explicitly identifies these as valid extension points:

-   Fastify request boundary.
-   `AgentService`.
-   `AgentRunner` interface.
-   Execution data model.

Teams may introduce middleware behavior such as:

-   Events.
-   Principals and identities.
-   Policies.
-   Lifecycle behavior.
-   Provider adapters.
-   Memory controls.
-   Reliability mechanisms.
-   Other Agent-specific capabilities.

------------------------------------------------------------------------

## 3. Runtime Profiles

### Local POC

Execution model:

-   One disposable local container per turn.
-   Docker, Colima, and rootless Podman supported.
-   Recommended development and judging path.

### BytePlus ECS

Execution model:

-   Codex runs inside the application container.
-   Optional cloud demonstration path.

### Local Development

Execution model:

-   Codex runs as a host process.
-   Useful for hot reload when the host Codex CLI is installed and
    configured.

### Intentional Limitations

The starter kit is a single-user POC.

Important limitations include:

-   Optional bearer token protects a remote demo but is not a user
    identity or authorization system.
-   JSON store supports one process.
-   Ordinary containers are not a hardened multi-tenant isolation
    boundary.

These are deliberate extension points. Teams are **not required to fix
all of them**.

------------------------------------------------------------------------

## 4. Running the Baseline Locally

### Requirements

-   macOS or Linux.
-   Node.js 22 or newer.
-   npm 10 or newer.
-   One container engine:
    -   Docker
    -   Colima
    -   Podman
-   BytePlus ModelArk API key.
-   Responses-compatible endpoint ID.

### Start

``` bash
git clone https://github.com/RrankPyramid/CodeJam.git
cd CodeJam

ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

The first run:

1.  Installs Node.js dependencies.
2.  Builds the Runtime image.
3.  Automatically selects Docker, Colima, or Podman.
4.  Starts the application.

Open:

``` text
http://localhost:3000
```

### Podman Example

``` bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Colima exposes the Docker CLI, so after `colima start`, use the normal
command.

### Ark Credentials

`ARK_API_KEY` must be an Ark model API key, not a BytePlus account
AK/SK.

`ARK_MODEL` is normally an endpoint ID beginning with:

``` text
ep-
```

Wrong credentials may result in:

``` text
401 Unauthorized
```

### Persistence

Pressing `Ctrl+C` stops the POC, but Agent workspaces and conversations
remain available for the next run.

------------------------------------------------------------------------

## 5. Baseline Acceptance Test

Before implementing middleware:

1.  Open the browser.
2.  Select **Create Agent**.
3.  Enter:
    -   Name.
    -   Description.
    -   Workspace instructions.
4.  Create the Agent.
5.  Send this Playground task:

``` text
Create a TypeScript hello-world CLI, add a test, run it, and summarize the files you created.
```

6.  Wait for the Run to complete.
7.  Confirm an assistant response appears.
8.  Send a follow-up message.
9.  Confirm the same Codex session continues.
10. Stop and restart the Agent.
11. Confirm the workspace still exists.

Do not start middleware work until the baseline succeeds.

Troubleshooting points include:

``` bash
docker info
```

or:

``` bash
podman info
```

and:

``` text
http://localhost:3000/api/system
```

Also verify the Ark API key and endpoint.

### Validation

Before submission:

``` bash
npm run check
```

This runs:

-   TypeScript checks.
-   Server tests.
-   Production builds.

------------------------------------------------------------------------

## 6. Platform and Middleware Design Requirements

The middleware is the core of the challenge.

Teams should:

1.  Identify an Agent-specific problem.
2.  Decide which responsibilities belong in:
    -   Frontend.
    -   Control plane.
    -   Runtime.
    -   Data layer.
    -   Infrastructure boundary.
3.  Implement the smallest coherent solution that proves the idea.

### Mandatory Design Principles

#### Preserve the Baseline

These must continue to work:

-   Agent CRUD.
-   Lifecycle actions.
-   Playground chat.
-   Persistence.
-   Model execution.

#### Implement Real Behavior

Middleware must execute in a:

-   Backend path.
-   Runtime path.
-   Data path.
-   Infrastructure path.

Static screens and hard-coded success messages do not qualify.

#### Define the Boundary

Explain:

-   Which component owns a decision/event.
-   What data crosses the boundary.
-   What happens when the component fails.

#### Demonstrate Meaningful Evidence

Show:

-   Normal behavior.
-   An appropriate failure, denial, recovery, degraded, or abuse case.

#### Add Automated Verification

Tests must verify the core middleware behavior, not only UI rendering.

#### Keep Secrets Out

Never commit or display:

-   API keys.
-   AK/SK.
-   Passwords.
-   Bearer tokens.
-   Unredacted sensitive payloads.

#### Prefer Small Infrastructure

Local execution is the default judging path.

ECS is optional and does not affect score.

### In Scope

Examples:

-   Coherent middleware story.
-   One or more related capabilities.
-   Real integration path.
-   Minimal UI.
-   Tests.
-   Demo evidence.
-   Mock users.
-   Protected fixtures.
-   Controlled failures.
-   Provider adapters.
-   Lifecycle controls.
-   Trace data.
-   Policy decisions.
-   Reliability mechanisms.
-   Focused schema changes/refactors.

### Out of Scope Unless Central to the Idea

-   Rebuilding the React application.
-   Rebuilding CRUD API.
-   Rebuilding Playground.
-   Rebuilding Codex integration.
-   Rebuilding container launcher.
-   Building a commercial cloud platform.
-   Production OAuth.
-   General-purpose policy engine.
-   MicroVM Runtime.
-   Container scheduler.
-   Multi-region infrastructure.
-   Unrelated redesigns/cosmetic work.

------------------------------------------------------------------------

## 7. Agent Lifecycle and Post-Creation Experience

The existing platform already allows a user to:

-   Find an Agent.
-   Inspect status/configuration.
-   Start/stop it.
-   Use the Playground.
-   Review messages and Runs.
-   Continue a Codex session.
-   Delete the Agent according to a workspace archival policy.

Teams may extend lifecycle behavior where useful.

Possible additions:

-   Test/invoke an Agent with sample input.
-   Open middleware evidence for a Run.
-   Show a trace.
-   Show an audit decision.
-   Show a policy result.
-   Show a recovery record.
-   Show a budget event.
-   Distinguish human operations from Agent operations.
-   Add human approval.
-   Update Agent configuration through versions.
-   Show configuration changes.
-   Rotate/revoke credentials.
-   Rotate/revoke permissions.
-   Rotate/revoke tools.
-   Rotate/revoke network access.
-   Pause/resume/stop/retry/reconcile/recover a Run.
-   Clean up or retain state during deletion according to explicit
    policy.

Only implement lifecycle behavior necessary to prove the chosen
middleware capability.

------------------------------------------------------------------------

## 8. Suggested Three-Day Plan

### Day 1

Goal:

-   Start and understand baseline.
-   Define Agent-specific problem.
-   Choose/invent middleware story.
-   Specify contract.
-   Complete first backend path.

Exit evidence:

-   Baseline passes.
-   One real middleware behavior/event/decision/control can be triggered
    from an API or test.

### Day 2

Goal:

-   Finish core middleware path.
-   Persist evidence.
-   Add minimum UI.
-   Implement important success and failure cases.

Exit evidence:

-   Complete scenario works end-to-end from browser through
    backend/Runtime/data/infrastructure boundary.

### Day 3

Goal:

-   Add automated tests.
-   Handle errors and cleanup.
-   Finish architecture diagram.
-   Finish README.
-   Rehearse demo.

Exit evidence:

``` bash
npm run check
```

passes and the demonstration fits within three minutes.

------------------------------------------------------------------------

# 9. Recommended Middleware Direction: Identity and Authorization

Identity and authorization are one suggested direction.

A useful distinction is:

-   Human principal.
-   Agent principal.

An Agent could have a separate identity instead of reusing:

-   Human session.
-   Personal access token.
-   Shared platform credential.

### Possible Capabilities

#### Human Authentication

Identify the user who:

-   Owns an Agent.
-   Creates an Agent.
-   Approves operations.
-   Updates an Agent.
-   Stops an Agent.

#### Per-Agent Identity

Give each Agent or Agent version a distinct principal that can be
independently:

-   Rotated.
-   Revoked.

#### Delegated Authority

Represent permissions that are:

-   Scoped.
-   Time-bound.
-   Revocable.

#### Policy Enforcement

Perform authorization at a trusted boundary such as:

-   Backend.
-   Tool.
-   Data.
-   Runtime.

Do not rely only on UI restrictions.

#### Approval Boundaries

Optionally require human approval for:

-   External writes.
-   High-cost actions.
-   Production operations.
-   Sensitive data access.

#### Action Attribution

Record:

-   Initiating human.
-   Executing Agent.
-   Requested scope.
-   Decision.
-   Target resource.
-   Result.

#### Secret Handling and Revocation

-   Keep provider credentials on trusted backends.
-   Redact sensitive values.
-   Demonstrate how later execution changes after revocation.

### Acceptable POC

A small mock identity model is acceptable.

Example:

-   User A owns Agent A.
-   User B owns a protected mock resource.
-   Prove Agent A cannot read User B's resource.

A login screen without server-side authorization is **not sufficient**.

------------------------------------------------------------------------

# 10. Recommended Middleware Direction: Trace, Audit, and Observability

A Run can be represented as a connected sequence of reasoning/actions
rather than unrelated logs.

Trace context can propagate through:

``` text
Frontend
→ Control Plane
→ Agent Runtime
→ Model Call
→ Tool Call
→ Workspace Operation
→ Sandbox Job
→ Cloud API
```

as relevant to the chosen design.

### Useful Identifiers

Examples:

-   Agent ID.
-   Agent version.
-   Run ID.
-   Session ID.
-   Trace ID.
-   Span ID.
-   Actor type.

### Useful Trace Fields

-   Start time.
-   Duration.
-   Status.
-   Error details.
-   Retry relationships.
-   Cancellation relationships.

### Example Span Categories

-   Orchestration.
-   Model call.
-   Tool call.
-   Memory access.
-   Sandbox execution.
-   Policy decision.
-   Human approval.
-   Cloud operation.

### Inputs and Outputs

Store them in safely:

-   Summarized form.
-   Redacted form.

### Useful Metadata

-   Model metadata.
-   Tool metadata.
-   Runtime metadata.
-   Infrastructure metadata.
-   Token usage.
-   Cost.
-   Resource consumption.
-   Budget signals.

### Possible Frontend

A trace-focused frontend might include:

-   Run list.
-   Trace detail page.
-   Tree/timeline.
-   Expandable spans.
-   Status filters.
-   Ability to locate failing step.

Machine-readable query/export is optional.

Secrets and sensitive payloads should be redacted before
storage/display.

------------------------------------------------------------------------

# 11. Illustrative Layered Agent Architecture

No single layering model is mandatory.

One possible architecture:

  --------------------------------------------------------------------------
  Layer                   Primary Responsibility  Starter Kit Boundary
  ----------------------- ----------------------- --------------------------
  Experience Layer        Agent creation,         React Web UI calling
                          catalog, Playground,    stable APIs without Ark
                          middleware evidence,    key
                          lifecycle actions       

  Control Plane           Agent specification,    Fastify routes and
                          validation, status, Run `AgentService`
                          orchestration,          
                          reconciliation          

  Identity and Policy     Human/Agent identity,   Team-designed boundary
  Plane                   delegation, approval,   around
                          revocation, audit       API/service/tool/Runtime
                                                  operations

  Agent Runtime Layer     Codex execution, model  `AgentRunner`, local
                          access, tool routing,   Runtime containers, or ECS
                          retries, cancellation,  process
                          limits                  

  Execution and Data      Workspace files,        Per-Agent workspaces, JSON
  Layer                   persistent state,       metadata, mock services,
                          protected resources,    provider adapters
                          connectors, isolated    
                          execution               

  Observability Layer     Trace ingestion,        New Run events, stores,
                          correlation, redaction, APIs, UI
                          storage, query,         
                          visualization, export   

  Cloud Resource Layer    Compute, networking,    Docker, Colima, Podman,
                          storage, scheduling,    optional BytePlus ECS
                          sandbox infrastructure  
  --------------------------------------------------------------------------

Teams may document API/event contracts between layers and explain how
the architecture could later support another:

-   Runtime.
-   Identity provider.
-   Trace backend.
-   Tool.
-   Model.
-   Infrastructure provider.

------------------------------------------------------------------------

# 12. Recommended Middleware Direction: Threat Modeling and Safety

Possible threats and controls:

  -----------------------------------------------------------------------
  Threat                              Possible Controls
  ----------------------------------- -----------------------------------
  Credential theft/exposure           Managed secret references,
                                      short-lived credentials, rotation,
                                      redaction, exclude secrets from
                                      source/browser/logs/traces

  Privilege escalation/confused       Least-privilege scopes, explicit
  delegation                          delegation, backend policy checks,
                                      approvals, revocation, actor
                                      attribution

  Prompt injection/tool misuse        Tool allowlists, typed schemas,
                                      target-resource scoping, output
                                      validation, execution limits,
                                      approval for high-risk actions

  Sandbox escape/untrusted code       Non-privileged execution,
                                      restricted filesystems/networks,
                                      resource limits, controlled mounts,
                                      patched Runtime images

  Cross-user access/data exfiltration Ownership-aware authorization,
                                      storage isolation, scoped queries,
                                      outbound allowlists, protected
                                      metadata endpoints, negative tests

  Runaway execution/cost              Timeouts, quotas, concurrency
                                      limits, maximum steps, token/cost
                                      budgets, administrative stop

  Sensitive trace capture             Configurable capture levels,
                                      redaction before export, trace
                                      access control, retention limits
  -----------------------------------------------------------------------

The starter kit already includes baseline safeguards such as:

-   CPU limits.
-   Memory limits.
-   PID limits.
-   Dropped capabilities.
-   `no-new-privileges`.

These may be reused, but **do not by themselves count as a new safety
capability**.

------------------------------------------------------------------------

# 13. Recommended Middleware Direction: Multi-Agent Coordination

Teams may connect several Agent instances through a:

-   Shared session.
-   Topic.
-   Queue.
-   Lightweight coordinator.

The purpose is not to build a complicated distributed system.

The goal is to demonstrate:

-   Message routing.
-   Shared state.
-   Coordinated turns.
-   More than one Agent Runtime.

### Example Demo

Create several Agents and ask them to count down:

``` text
10
9
8
7
6
5
4
3
2
1
```

Each turn:

1.  One Agent publishes the next unused number.
2.  Another Agent continues.
3.  Continue until 1.

### Minimum Coordination Layer

May provide:

-   Shared session/topic readable and writable by participating Agents.
-   Simple turn-selection/message-routing rule.
-   Shared state recording latest number.
-   Prevention of duplicate/skipped turns.
-   Visible event history showing which Agent produced each number.
-   Timeout/retry/stop rule for an Agent that does not respond.

### Successful Demonstration

From the platform:

1.  Start multiple Agents.
2.  Launch one shared task.
3.  Show complete 10-to-1 sequence.
4.  No duplicate numbers.
5.  No missing numbers.
6.  Clearly show which Agent produced each message and the ordering.

A platform-local webpage is sufficient.

External chat integration is optional.

------------------------------------------------------------------------

# 14. Other Possible Team-Designed Middleware

Possible directions include:

-   Lifecycle reconciliation.
-   Failure recovery.
-   State governance.
-   Memory governance.
-   Human-in-the-loop workflows.
-   Cost/budget control.
-   Provider abstraction.
-   Versioning.
-   Rollback.
-   Multi-Agent coordination.
-   Tool routing.
-   Model routing.
-   Credential exchange.
-   Automated diagnosis.
-   Automated remediation.

A custom capability should still explain:

1.  Agent-specific problem.
2.  Architecture boundary.
3.  Functional evidence.
4.  Failure/recovery case.
5.  Known limitations.

------------------------------------------------------------------------

# 15. Required Live Demo

The demo should show one complete scenario.

Required journey:

1.  Create or select a runnable Agent from the frontend.
2.  Show current lifecycle state.
3.  Invoke the Agent through the Playground with a real task.
4.  Show at least one real:
    -   Model action.
    -   File action.
    -   Tool action.
    -   Sandbox action.
    -   Data action.
    -   Infrastructure action.
5.  Demonstrate the team's middleware behavior.
6.  Show the evidence produced by the middleware.
7.  Demonstrate an appropriate:
    -   Failure.
    -   Denial.
    -   Degraded state.
    -   Abuse case.
    -   Recovery case.
8.  Show that the platform remains understandable and controllable
    afterward.

Mock third-party services and controlled fixtures are allowed.

The frontend-to-Agent path and middleware must be functional, not static
UI representations.

------------------------------------------------------------------------

# 16. Deliverables

## 1. Three-Minute Live Demo

Show:

-   One real Agent Run.
-   Middleware normal case.
-   Appropriate failure/denial/recovery/degraded/abuse case.

## 2. One-Page Architecture Diagram

Show:

-   Middleware.
-   Data flow.
-   Trust boundary.
-   Enforcement/instrumentation/recovery point.

## 3. Code Repository

Include:

-   Setup instructions.
-   Middleware problem.
-   Rationale.
-   Design summary.
-   Automated tests.
-   Demo steps.
-   Limitations.
-   No secrets.

------------------------------------------------------------------------

# 17. Core Acceptance Checklist

A reviewer should be able to:

-   Clone the repository.
-   Start the platform.
-   Create/test an Agent from the frontend.
-   See one or more meaningful middleware capabilities.
-   Verify middleware executes in backend/Runtime/data/infrastructure
    path.
-   Understand and reproduce the POC from documentation.

Required:

``` bash
npm run check
```

must pass.

No secrets may appear in:

-   Source.
-   Git history.
-   Logs.
-   Traces.
-   Screenshots.
-   Browser storage.
-   Demo output.

### Optional Strong Evidence

Examples:

-   Delegated permission is scoped/revocable, enforced outside UI, and
    demonstrated.
-   End-to-end Run produces correlated trace with
    model/tool/sandbox/policy/infrastructure events.
-   Defined threat is blocked/contained and protected asset remains
    unchanged.
-   Cleanup/recovery is demonstrated.
-   Team-defined
    lifecycle/reliability/memory/budget/provider/coordination capability
    works as described.

------------------------------------------------------------------------

# 18. Evaluation Criteria

  -------------------------------------------------------------------------
  Category                                    Weight What Reviewers Look
                                                     For
  --------------------- ---------------------------- ----------------------
  End-to-end middleware                          40% Real
  behavior                                           frontend-to-backend,
                                                     Runtime, data, or
                                                     infrastructure path
                                                     with convincing
                                                     functional evidence

  Technical design and                           25% Clear rationale,
  integration                                        coherent architecture,
                                                     appropriate boundary,
                                                     focused changes,
                                                     extensible contracts

  Verification and                               20% Automated tests, error
  robustness                                         handling,
                                                     cleanup/recovery,
                                                     redaction, protection
                                                     against obvious
                                                     bypasses

  Demo and                                       15% Concise live demo,
  reproducibility                                    useful README,
                                                     one-command startup,
                                                     documented
                                                     limitations, no hidden
                                                     manual setup
  -------------------------------------------------------------------------

------------------------------------------------------------------------

# 19. Scope Guidance

This is a hackathon-scale Agent infrastructure challenge.

A strong submission may use:

-   One local Runtime path.
-   Small mock resource set.
-   Focused middleware story.

Depth, coherence, and relevance matter more than number of features.

Teams are **not required** to:

-   Train a foundation model.
-   Build a workflow editor.
-   Implement production OAuth.
-   Create a general-purpose sandbox.
-   Support multiple cloud regions.
-   Deploy to ECS.

Mock external services are acceptable.

Static UI mockups cannot replace functional middleware.

### FAQ

#### Is BytePlus ECS required?

No.

Local Docker, Colima, or Podman is the default judging path.

Cloud deployment is optional.

#### Must the team select one recommended example?

No.

Teams may:

-   Adapt.
-   Combine.
-   Simplify.
-   Replace.
-   Invent capabilities.

#### Are mock users/resources allowed?

Yes.

Controlled fixtures are encouraged when they make middleware behavior
reproducible.

#### Does a polished UI count as middleware?

No.

UI can explain/visualize middleware, but the behavior must execute in a
trusted backend, Runtime, data, or infrastructure path.

#### Why might Ark return 401 Unauthorized?

Common causes:

-   Using BytePlus account AK/SK instead of an Ark model API key.
-   Wrong endpoint ID.

#### Where should code exploration begin?

Start with:

``` text
apps/server/src/types.ts
apps/server/src/app.ts
apps/server/src/agent-service.ts
```

Then inspect the two `AgentRunner` implementations.

For the frontend, inspect:

``` text
apps/web/src/App.tsx
```

------------------------------------------------------------------------

# 20. Starter Kit Repository

Repository:

``` text
https://github.com/RrankPyramid/CodeJam
```

------------------------------------------------------------------------

# 21. Key Context for Codex

When modifying this repository, preserve these assumptions:

1.  **Do not rebuild the starter platform.**
2.  Preserve Agent CRUD, lifecycle controls, Playground, persistence,
    model execution, and existing Runtime behavior.
3.  Middleware must be real backend/Runtime/data/infrastructure
    behavior.
4.  Prefer focused, minimal changes.
5.  The strongest extension seams are:
    -   Fastify request boundary.
    -   `AgentService`.
    -   `AgentRunner`.
    -   Execution data model.
6.  Local container execution is the preferred judging path.
7.  Cloud deployment is optional.
8.  Automated tests are required for core middleware behavior.
9.  Demonstrate both a normal case and an appropriate
    failure/denial/recovery/degraded/abuse case.
10. Do not expose secrets.
11. Avoid unnecessary infrastructure unless it is central to the
    middleware story.
12. The final demo must fit within approximately three minutes.
