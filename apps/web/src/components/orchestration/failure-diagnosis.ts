import type {
  Agent,
  OrchestrationErrorCode,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "../../types";
import { agentName, humanizeFailure } from "./orchestration-utils";

/**
 * Turning "something failed" into "this Agent failed, here is why, here is
 * what to try".
 *
 * A failed Conversation used to state only its own error code. The code names
 * the shape of the failure, never which of six Agents hit it, so finding the
 * culprit meant reading the Activity log turn by turn. Everything here is
 * derived from data the detail response already carries; nothing is fetched
 * and nothing is guessed about state the server did not report.
 */

export interface FailureFix {
  /** Imperative, one line, describing an action the person can actually take. */
  label: string;
  /** Where that action lives, when this app can take them there. */
  target?: "agent" | "settings" | "roles" | "retry";
}

export interface ConversationFailure {
  /** The Agent whose turn failed, when a turn recorded one. */
  agentId: string | null;
  agentName: string | null;
  /** Zero-based execution step of the failing turn, for the Activity log. */
  stepIndex: number | null;
  /** The session-level explanation, already human-readable. */
  summary: string;
  /** The Agent's own last error, when the platform recorded one. */
  agentError: string | null;
  errorCode: OrchestrationErrorCode | null;
  fixes: FailureFix[];
}

const TURN_FAILED = new Set(["failed", "timed_out"]);

/** The most recent turn that did not finish, by execution order. */
function lastFailedTurn(turns: readonly OrchestrationTurn[]): OrchestrationTurn | null {
  let latest: OrchestrationTurn | null = null;
  for (const turn of turns) {
    if (!TURN_FAILED.has(turn.status)) continue;
    if (latest === null) {
      latest = turn;
      continue;
    }
    const current = turn.stepIndex ?? -1;
    const best = latest.stepIndex ?? -1;
    if (current > best) latest = turn;
    else if (current === best && turn.createdAt.localeCompare(latest.createdAt) >= 0) {
      latest = turn;
    }
  }
  return latest;
}

/**
 * What to try next, keyed by the failure the server actually reported.
 *
 * Deliberately conservative: each entry is an action this product exposes. No
 * entry claims to know why a model refused or what a sandbox command did, and
 * an unrecognized code falls back to the generic pair rather than inventing a
 * cause.
 */
function fixesFor(
  errorCode: OrchestrationErrorCode | null,
  agent: Agent | undefined,
  recoveryRequired: boolean,
): FailureFix[] {
  const fixes: FailureFix[] = [];
  // A stalled restore comes first: nothing else can run until it is settled,
  // and the panel above the tabs is where it is resumed or rolled back.
  if (recoveryRequired) {
    fixes.push({ label: "Finish the pending Workspace recovery: resume it, or restore the safety checkpoint" });
  }
  switch (errorCode) {
    case "CHECKPOINT_CAPTURE_FAILED":
      fixes.push(
        { label: "Restore the last workspace checkpoint from the Activity tab", target: "retry" },
        { label: "Or retry the turn once the Workspace is settled" },
      );
      break;
    case "CHECKPOINT_PUBLISH_FAILED":
      fixes.push({ label: "Continue the conversation; the next successful turn records a fresh checkpoint" });
      break;
    case "CHECKPOINT_RUNTIME_UNSUPPORTED":
      fixes.push({ label: "Retry the turn using the current files; restore-and-resume is unavailable on this runtime", target: "retry" });
      break;
    case "MODEL_INFERENCE_LIMIT_EXCEEDED":
      fixes.push(
        { label: "Assign this Agent a different worker model", target: "settings" },
        { label: "Add a fallback model so the next run reroutes automatically", target: "settings" },
      );
      break;
    case "WEB_TOOL_PERMISSION_DENIED":
      fixes.push(
        { label: "Give this Agent a role that allows the web tool it asked for", target: "roles" },
        { label: "Or reword the task so it does not need web access" },
      );
      break;
    case "PROJECT_PERMISSION_DENIED":
      fixes.push(
        { label: "Add agent.invoke and project.write to this Agent's role", target: "roles" },
        { label: "Check it has editable membership in this Workspace" },
      );
      break;
    case "RUN_TIMED_OUT":
      fixes.push(
        { label: "Raise the per-Agent timeout in the Conversation's Advanced settings" },
        { label: "Or split the task so each turn does less" },
      );
      break;
    case "AGENT_STOPPED":
      fixes.push({ label: "Start this Agent, then retry the turn", target: "agent" });
      break;
    case "AGENT_BUSY":
      fixes.push({ label: "Wait for its other run to finish, then retry", target: "retry" });
      break;
    case "AGENT_NOT_FOUND":
    case "AGENT_UNAVAILABLE":
      fixes.push({ label: "Remove this Agent from the room and add one that still exists" });
      break;
    case "MAX_STEPS_EXCEEDED":
      fixes.push(
        { label: "Raise the turn limit in the Conversation's Advanced settings" },
        { label: "Or narrow the task so it finishes in fewer turns" },
      );
      break;
    case "SUPERVISOR_UNAVAILABLE":
    case "SUPERVISOR_FAILED":
    case "SUPERVISOR_TIMED_OUT":
    case "SUPERVISOR_INVALID_RESPONSE":
    case "SUPERVISOR_INVALID_SELECTION":
      fixes.push(
        { label: "Check the supervisor model in Insights › Supervisor model" },
        { label: "Or switch this Conversation to a fixed Agent order in Advanced" },
      );
      break;
    default:
      break;
  }

  // Two things are worth saying about almost any failure, and neither repeats
  // advice already given above.
  if (agent && agent.status === "stopped" && errorCode !== "AGENT_STOPPED") {
    fixes.push({ label: `Start ${agent.name} — it is currently stopped`, target: "agent" });
  }
  if (!fixes.some((fix) => fix.target === "retry")) {
    fixes.push({ label: "Retry from the failed step in the Activity tab", target: "retry" });
  }
  if (agent) {
    fixes.push({ label: `Open ${agent.name} to read its full run log`, target: "agent" });
  }
  return fixes;
}

/**
 * Read one failed Conversation. Returns `null` while nothing has failed, so a
 * caller can render the whole diagnosis block conditionally on this alone.
 */
export function diagnoseFailure(
  detail: OrchestrationSessionDetail | null,
  agents: readonly Agent[],
): ConversationFailure | null {
  const session = detail?.session;
  if (!session || session.status !== "failed") return null;

  const turn = lastFailedTurn(detail?.turns ?? []);
  const agent = turn ? agents.find((item) => item.id === turn.agentId) : undefined;
  // The turn's own code is the specific one; the session's is the roll-up.
  const errorCode = turn?.errorCode ?? session.errorCode ?? null;

  return {
    agentId: turn?.agentId ?? null,
    agentName: turn ? agentName(agents, turn.agentId) : null,
    stepIndex: turn?.stepIndex ?? null,
    summary: humanizeFailure(errorCode, session.errorMessage),
    // `lastError` is the platform's own record of what went wrong inside the
    // Agent, which is frequently more concrete than the orchestration code.
    agentError: agent?.lastError?.trim() || null,
    errorCode,
    fixes: fixesFor(errorCode, agent, detail?.recovery?.stage === "recovery_required"),
  };
}
