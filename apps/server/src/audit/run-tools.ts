/**
 * What a Run actually called, named.
 *
 * The audit log records a single tool call under several event types, and two
 * of them describe the same act: Codex emits `mcp_tool_call` for a request the
 * MCP server separately records as `tool_started`. This module is the one place
 * that knows how to read a name out of each event type and how to reconcile
 * that pair, so a Run row can say "rg, ls, apply_patch" instead of showing a
 * count nobody can act on.
 */
import type { AuditEvent } from "./audit-types.js";

/** One named tool, command, or skill and how often this Run reached for it. */
export interface RunToolName {
  name: string;
  calls: number;
  /** Calls that ended in failure, so a broken tool names itself. */
  failed: number;
}

/**
 * Tool activity for one Run.
 *
 * Sandbox commands are counted apart from tool calls because they are a
 * different kind of act — shelling out inside the workspace rather than
 * invoking a declared tool — and a reader chasing a permission question cares
 * which one happened.
 */
export interface RunToolUsage {
  /** Reconciled tool and skill invocations; a double-recorded call counted once. */
  calls: number;
  /** Commands the Run ran inside its sandbox. */
  sandboxCommands: number;
  /** The names behind those counts, busiest first. */
  names: RunToolName[];
}

export function emptyToolUsage(): RunToolUsage {
  return { calls: 0, sandboxCommands: 0, names: [] };
}

function metadataString(event: AuditEvent, key: string): string | undefined {
  const value = event.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The name a reader would recognise for one event, or null when the event is
 * not a tool act.
 *
 * Sandbox commands keep the `$ ` prefix the trace view already uses, so the
 * same act reads the same way in both places.
 */
export function toolEventName(event: AuditEvent): string | null {
  switch (event.type) {
    case "tool_started":
    case "tool_succeeded":
    case "tool_failed":
      return (
        (event.resource?.kind === "tool" ? event.resource.id : undefined) ??
        metadataString(event, "toolId") ??
        "tool"
      );
    case "mcp_tool_call":
      return metadataString(event, "toolId") ?? "tool";
    case "skill_invoked":
      return metadataString(event, "skillId") ?? "skill";
    case "sandbox_command": {
      const program = metadataString(event, "program");
      return program === undefined ? null : "$ " + program;
    }
    default:
      return null;
  }
}

interface Tally {
  names: Map<string, RunToolName>;
  calls: number;
  sandboxCommands: number;
}

function note(tally: Tally, name: string, failed: boolean): void {
  const existing = tally.names.get(name);
  if (existing === undefined) {
    tally.names.set(name, { name, calls: 1, failed: failed ? 1 : 0 });
    return;
  }
  existing.calls += 1;
  if (failed) existing.failed += 1;
}

/**
 * What one Run called, from that Run's audit events.
 *
 * Counting is deliberately not a tally of tool-category events. `tool_started`
 * is the call counter for a server-executed tool and `tool_succeeded` /
 * `tool_failed` report that same call's outcome, so the outcome events only
 * mark a name as having failed. `mcp_tool_call` is reconciled against the
 * started records by name — a runtime-only call with no server twin still
 * counts, so a Run driven entirely through the runtime is never silent.
 *
 * Reconciliation is a second pass rather than a running match because the two
 * records of one call are written by different subsystems and their order in
 * the log is not guaranteed.
 */
export function summarizeRunTools(events: readonly AuditEvent[]): RunToolUsage {
  const tally: Tally = { names: new Map(), calls: 0, sandboxCommands: 0 };
  const unmatchedStarts = new Map<string, number>();

  for (const event of events) {
    const name = toolEventName(event);
    if (name === null) continue;
    if (event.type === "sandbox_command") {
      tally.sandboxCommands += 1;
      note(tally, name, event.status === "failure");
      continue;
    }
    if (event.type === "tool_started" || event.type === "skill_invoked") {
      if (event.type === "tool_started") {
        unmatchedStarts.set(name, (unmatchedStarts.get(name) ?? 0) + 1);
      }
      tally.calls += 1;
      note(tally, name, event.status === "failure");
      continue;
    }
    if (event.type === "tool_failed") {
      // The outcome of a call already counted at `tool_started`. A failure with
      // no start recorded is still a call that happened, so it counts once here
      // rather than being dropped for want of its opening event.
      const existing = tally.names.get(name);
      if (existing !== undefined) existing.failed += 1;
      else {
        tally.calls += 1;
        note(tally, name, true);
      }
    }
  }

  for (const event of events) {
    if (event.type !== "mcp_tool_call") continue;
    const name = toolEventName(event) ?? "tool";
    const pending = unmatchedStarts.get(name) ?? 0;
    if (pending > 0) {
      unmatchedStarts.set(name, pending - 1);
      continue;
    }
    tally.calls += 1;
    note(tally, name, event.status === "failure");
  }

  return {
    calls: tally.calls,
    sandboxCommands: tally.sandboxCommands,
    names: [...tally.names.values()].sort(
      (left, right) => right.calls - left.calls || left.name.localeCompare(right.name),
    ),
  };
}
