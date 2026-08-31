# Assignments UI Redesign Implementation Plan

## Objective

Improve **Roles & skills > Assignments** so Agent-to-Workspace access is easy
to scan, does not clip at the current application viewport, and remains
consistent with the existing warm-paper and purple visual system.

This is a focused presentation change. It must not alter assignment behavior,
API contracts, authorization semantics, or unrelated screens.

## Confirmed Design Decisions

1. Use a single-column Agent roster at every current viewport size.
2. Keep Workspace assignments visible beneath each Agent.
3. Emphasize the common task: review or change the Agent's global fallback and
   Workspace-specific overrides.
4. Render the add-Workspace select only when an unassigned Workspace exists.
   Otherwise show quiet `All workspaces assigned` status text.
5. Preserve the current neutral paper surfaces, restrained purple accent,
   typography, radii, borders, and focus language.

## Current Problem

The issue is structural rather than a screenshot artifact.

- `.assignment-list` uses a two-column grid and collapses only at a viewport
  breakpoint of `940px`.
- The app sidebar and page padding make the content panel substantially
  narrower than the viewport, so the `951x720` screenshot still renders two
  cramped cards.
- Each card contains two percentage-width controls and a three-column
  Workspace row, causing the second card to clip and Workspace names to
  truncate aggressively.
- The disabled add-Workspace select creates visual weight without offering an
  action.
- Mobile stacking begins at `580px`, which does not address a narrow content
  column inside a larger viewport.

Baseline evidence: `docs/images/authorization.png`.

## Files in Scope

- `apps/web/src/components/access/RolesAndSkillsView.tsx`
- `apps/web/src/styles.css`
- `tests/web/components/access/RolesAndSkillsView.test.tsx`, only if an
  appropriate test file already exists or a small focused behavior test is
  needed
- `docs/images/authorization.png`, recaptured after verification

Do not modify backend services, API request shapes, role semantics, project
membership behavior, other tabs, or unrelated styles.

## Implementation Plan

### 1. Restructure the Agent card controls

In `RolesAndSkillsView.tsx`, retain the existing `assignmentRows` data model
and async handlers. Change only the Assignments markup.

For every Agent card, keep this hierarchy:

1. Agent avatar, name, and availability status.
2. A compact policy-control band containing:
   - Global Agent role select and its fallback explanation.
   - Add-to-Workspace select only when `addableWorkspaces.length > 0`.
   - Quiet `All workspaces assigned` status when no Workspace can be added.
3. A visible Workspace assignment list containing:
   - Full Workspace name.
   - `Workspace override` role select.
   - Secondary `Remove` action.

Preserve:

- `changeGlobalRole`, `attachAgent`, `changeAssignment`, and `detachAgent`.
- Existing native selects and their `aria-label` values.
- Existing busy and empty states.
- Duplicate Workspace discriminators.
- Existing Agent and Workspace identifiers as React keys.

Do not introduce accordions. Assignments should remain directly visible for
fast review and screenshot evidence.

### 2. Replace the disabled add control

Current behavior always renders a select and disables it when every Workspace
is assigned.

Change this branch to:

- Render the select when `addableWorkspaces.length > 0`.
- Render a non-interactive status block when the count is zero.
- Use concise visible copy: `All workspaces assigned`.
- Keep the context clear with a small label such as `Workspace membership`.

The status block should not look disabled or resemble an input. It should use
muted text and, optionally, a subtle check glyph or neutral badge.

### 3. Convert the roster to one column

In `styles.css`:

- Set `.assignment-list` to a single-column grid at all current widths.
- Remove `.assignment-list` from the `max-width: 940px` grid-collapse rule
  because it no longer has a multi-column desktop state.
- Keep a comfortable vertical gap between Agent cards.

Do not add another viewport-width workaround. The single-column roster is the
confirmed information model.

### 4. Align identity and policy controls

Refine the assignment-specific rules near the `Roles & skills: assignment
cards` section.

Recommended desktop layout:

- Agent identity remains in a compact header row.
- `.assignment-card-controls` becomes a full-width grid beneath the identity.
- Use two equal, shrinkable columns when both the global role and add control
  are present.
- Use one full-width or bounded column when only the global role is present.
- Remove percentage widths from `.assignment-global-role-field` and
  `.assignment-add-field`.
- Apply `min-width: 0` to grid children so selects cannot force overflow.

Use a subtle control band or rule to separate Agent identity from policy
controls. Reuse `--paper`, `--hairline`, `--line`, `--muted`, `--purple`,
`--purple-soft`, existing radii, and existing shadows.

Avoid new fonts, gradients, large shadows, or ornamental animation.

### 5. Make Workspace assignment rows readable

Keep each Workspace row compact on desktop:

```text
Workspace name              Workspace override [Role]   Remove
```

Requirements:

- Give the Workspace name flexible space.
- Permit wrapping before severe truncation, or provide a `title` containing
  the complete name if ellipsis remains.
- Keep the override select wide enough for current role names.
- Keep Remove visually secondary and aligned with its row.
- Preserve separators between multiple Workspace assignments.

At narrow widths, stack the override control below the Workspace name and keep
Remove aligned to the top-right. Reuse or refine the existing `580px` mobile
rule.

### 6. Remove obsolete assignment CSS where safe

Review the older rules around:

- `.assignment-rows`
- `.assignment-row`
- `.assignment-agent`

If repository search confirms they have no remaining consumers, remove them
as part of this focused cleanup. Do not remove shared `.access-*` rules.

## Accessibility Requirements

- Preserve native `<select>` elements and all current accessible labels.
- Preserve the Remove button label naming both Agent and Workspace.
- Ensure the new all-assigned status is plain text, not a disabled interactive
  control.
- Retain visible keyboard focus styles for every interactive element.
- Keep full Workspace names available to assistive technology.
- Maintain practical pointer targets for primary controls.
- Do not make hover the only indicator of interactivity.

## Responsive Acceptance Criteria

At the current in-app browser viewport, approximately `951x720`:

- No horizontal page overflow.
- No partially visible second Agent card.
- Both Agent cards fit the content column width.
- Workspace names, override roles, and Remove actions remain understandable.
- Disabled add-Workspace dropdowns are gone.
- The screenshot reads as one coherent roster rather than competing cards.

At wider desktop widths:

- Agent cards remain single-column.
- Controls use available width without leaving a large right-heavy empty area.
- Workspace rows remain compact and aligned.

At mobile widths around `580px` and below:

- Policy controls stack vertically.
- Selects use the full available width.
- Workspace override controls stack without covering Remove.
- No text or focus ring is clipped.

## Verification

Keep verification proportional to this UI-only change.

1. Run the Web typecheck:

   ```bash
   npm run typecheck -w @launchpad/web
   ```

2. Run a focused Web test only if one is added or updated:

   ```bash
   npx vitest run --config vitest.web.config.ts \
     tests/web/components/access/RolesAndSkillsView.test.tsx
   ```

3. Start or reuse the local POC and inspect **Roles & skills > Assignments**.
4. Verify the default in-app browser viewport and one narrow responsive state.
5. Confirm the global role, add Workspace, Workspace override, and Remove
   controls still call their existing handlers.
6. Check the browser console for new errors.

Do not run the full server suite for this focused styling change unless the
implementation alters shared behavior unexpectedly.

## Screenshot Deliverable

After the implementation passes visual review, replace:

`docs/images/authorization.png`

The capture should show:

- The Assignments tab selected.
- At least two complete Agent roster cards.
- Global fallback roles.
- Project-specific Workspace overrides.
- No clipped card, horizontal overflow, or disabled add-Workspace dropdown.

Capture from the running application. Do not mock or fabricate assignment
state solely for the image.

## Definition of Done

- The Assignments page uses a single-column Agent roster.
- Hierarchy is Agent identity, global fallback, then Workspace overrides.
- Add-to-Workspace appears only when actionable.
- The design matches the existing application visual language.
- Keyboard labels, focus states, and existing behaviors are preserved.
- The default screenshot viewport is clean and unclipped.
- `docs/images/authorization.png` is recaptured from the verified UI.
- No backend, authorization, or unrelated application behavior changes.
