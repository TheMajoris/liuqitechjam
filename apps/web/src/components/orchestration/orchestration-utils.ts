import type {
  Agent,
  CreateOrchestrationInput,
  OrchestrationErrorCode,
  OrchestrationEventType,
  OrchestrationMode,
  OrchestrationParticipant,
  OrchestrationStatus,
  OrchestrationTurn,
} from "../../types";

export const ORCHESTRATION_ACTIVE_STATUSES: OrchestrationStatus[] = [
  "queued",
  "running",
  "stopping",
];

export const ORCHESTRATION_MAX_STEPS = 1_000;
export const ORCHESTRATION_MIN_TIMEOUT_MS = 1_000;
export const ORCHESTRATION_MAX_TIMEOUT_MS = 3_600_000;
export const ORCHESTRATION_MAX_NAME_LENGTH = 80;

let participantSequence = 0;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export type OrchestrationDraft = CreateOrchestrationInput;

export type DraftErrors = Partial<
  Record<"name" | "originalPrompt" | "participants" | "maxSteps" | "perAgentTimeoutMs", string>
>;

export function isOrchestrationActive(status: OrchestrationStatus): boolean {
  return ORCHESTRATION_ACTIVE_STATUSES.includes(status);
}

/**
 * Roster occurrence order is only user-visible where execution actually
 * follows it. Automatic turn taking picks participants dynamically, so the
 * order is kept in the data but not shown as a numbered pipeline.
 * Legacy sessions without a mode run deterministically on the server.
 */
export function isOrderedMode(mode: OrchestrationMode | undefined | null): boolean {
  return mode !== "supervisor";
}

export function createParticipant(
  position: number,
  agentId = "",
  role = "",
): OrchestrationParticipant {
  const randomId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "participant-" + Date.now() + "-" + participantSequence++;
  return { id: randomId, agentId, role, position };
}

export function normalizeParticipants(
  participants: OrchestrationParticipant[],
): OrchestrationParticipant[] {
  return participants.map((participant, index) => ({
    ...participant,
    position: index,
  }));
}

/**
 * The backend requires a session name and a responsibility label per roster
 * occurrence. Normal users are only asked who joins and what the task is, so
 * both are derived here instead of being surfaced as required setup fields.
 */
export function deriveSessionName(prompt: string): string {
  const firstLine = prompt.trim().split("\n").find((line) => line.trim().length > 0) ?? "";
  const condensed = firstLine.replace(/\s+/g, " ").trim();
  if (!condensed) return "Untitled conversation";
  if (condensed.length <= ORCHESTRATION_MAX_NAME_LENGTH) return condensed;
  return condensed.slice(0, ORCHESTRATION_MAX_NAME_LENGTH - 1).trimEnd() + "…";
}

export function withDerivedLabels(
  draft: OrchestrationDraft,
  agents: Agent[],
): OrchestrationDraft {
  const name = draft.name.trim() || deriveSessionName(draft.originalPrompt);
  return {
    ...draft,
    name,
    originalPrompt: draft.originalPrompt.trim(),
    participants: normalizeParticipants(draft.participants).map((participant) => ({
      ...participant,
      role: participant.role.trim() || agentName(agents, participant.agentId),
    })),
  };
}

export function validateDraft(
  draft: OrchestrationDraft,
  agents: Agent[],
): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.originalPrompt.trim()) {
    errors.originalPrompt = "Describe the task these Agents should work on.";
  }
  if (draft.participants.length === 0) {
    errors.participants = "Add at least one Agent to the conversation.";
  } else {
    const available = new Set(agents.map((agent) => agent.id));
    if (draft.participants.some((participant) => !participant.agentId)) {
      errors.participants = "Every turn needs an Agent.";
    } else if (
      draft.participants.some((participant) => !available.has(participant.agentId))
    ) {
      errors.participants =
        "One or more Agents are no longer available. Refresh the Agent list or choose another.";
    }
  }
  if (
    !Number.isInteger(draft.maxSteps) ||
    draft.maxSteps < 1 ||
    draft.maxSteps > ORCHESTRATION_MAX_STEPS
  ) {
    errors.maxSteps = "Use a turn limit between 1 and 1,000.";
  }
  if (
    !Number.isInteger(draft.perAgentTimeoutMs) ||
    draft.perAgentTimeoutMs < ORCHESTRATION_MIN_TIMEOUT_MS ||
    draft.perAgentTimeoutMs > ORCHESTRATION_MAX_TIMEOUT_MS
  ) {
    errors.perAgentTimeoutMs = "Use a time limit between 1 second and 60 minutes.";
  }
  return errors;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)} s`;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown time";
  return dateTimeFormatter.format(date);
}

export function statusLabel(status: OrchestrationStatus): string {
  const labels: Record<OrchestrationStatus, string> = {
    draft: "Not started",
    queued: "Starting",
    running: "Running",
    stopping: "Stopping",
    completed: "Completed",
    failed: "Failed",
    stopped: "Stopped",
    interrupted: "Interrupted",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

export function turnStatusLabel(status: OrchestrationTurn["status"]): string {
  const labels: Record<OrchestrationTurn["status"], string> = {
    dispatched: "Working",
    completed: "Replied",
    failed: "Could not finish",
    cancelled: "Stopped",
    timed_out: "Ran out of time",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

/**
 * Product-level failure wording for people who did not configure the run.
 * Timeline keeps the raw codes and per-event detail for technical review.
 */
export function humanizeFailure(
  errorCode: OrchestrationErrorCode | null | undefined,
  fallback?: string | null,
): string {
  switch (errorCode) {
    case "MAX_STEPS_EXCEEDED":
      return "The conversation hit its turn limit before the Agents finished. Raise the turn limit in Advanced settings, or narrow the task.";
    case "AGENT_BUSY":
      return "One of the Agents was already busy with other work.";
    case "AGENT_NOT_FOUND":
    case "AGENT_UNAVAILABLE":
      return "One of the Agents in this conversation is no longer available.";
    case "AGENT_STOPPED":
      return "One of the Agents was stopped before it could reply.";
    case "RUN_TIMED_OUT":
      return "An Agent ran out of time on its turn.";
    case "RUN_FAILED":
      return "An Agent could not complete its turn.";
    case "RUN_CANCELLED":
    case "ORCHESTRATION_STOPPED":
      return "This conversation was stopped before it finished.";
    case "ORCHESTRATION_INTERRUPTED":
      return "The service restarted while this conversation was running.";
    case "SUPERVISOR_INVALID_RESPONSE":
    case "SUPERVISOR_INVALID_SELECTION":
      return "The next participant choice was not valid for this conversation.";
    case "SUPERVISOR_FAILED":
      return "The next participant could not be chosen.";
    case "SUPERVISOR_TIMED_OUT":
      return "Choosing the next participant took too long.";
    case "SUPERVISOR_UNAVAILABLE":
      return "Automatic turn taking is not available right now.";
    case "INVALID_OUTPUT":
      return "An Agent replied with something that could not be passed on safely.";
    case "INVALID_INPUT":
      return "This conversation was set up with values the server rejected.";
    default:
      {
        const fallbackText = fallback?.trim() ?? "";
        return /\b(supervisor|mastra|langgraph|graph|workflow)\b/i.test(fallbackText)
          ? "Something went wrong while running this conversation."
          : fallbackText || "Something went wrong while running this conversation.";
      }
  }
}

export function eventLabel(type: OrchestrationEventType): string {
  const labels: Record<OrchestrationEventType, string> = {
    orchestration_created: "Session created",
    orchestration_started: "Session started",
    orchestration_continued: "Conversation continued",
    supervisor_decision: "Next participant selected",
    participant_dispatched: "Agent turn dispatched",
    run_completed: "Agent turn completed",
    handoff_applied: "Handoff applied",
    participant_failed: "Agent turn failed",
    stop_requested: "Stop requested",
    child_run_cancelled: "Agent run cancelled",
    orchestration_stopped: "Session stopped",
    orchestration_failed: "Session failed",
    orchestration_interrupted: "Session interrupted",
    orchestration_completed: "Session completed",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

export function participantNumber(position: number): string {
  return String(position + 1).padStart(2, "0");
}

/**
 * Use the persisted execution index when available, falling back to the
 * detail response's array order for legacy turns. Participant.position is a
 * roster position and is intentionally not used here because round-robin may
 * visit the same participant more than once.
 */
export function turnStepNumber(
  turn: Pick<OrchestrationTurn, "stepIndex">,
  arrayIndex: number,
): number {
  return typeof turn.stepIndex === "number" &&
    Number.isInteger(turn.stepIndex) &&
    turn.stepIndex >= 0
    ? turn.stepIndex + 1
    : arrayIndex + 1;
}

export function agentName(agents: Agent[], agentId: string): string {
  return agents.find((agent) => agent.id === agentId)?.name ?? "Unavailable Agent";
}

export function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** Stable per-Agent accent so the same speaker keeps one colour across views. */
export function agentHue(agentId: string): number {
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = (hash * 31 + agentId.charCodeAt(index)) % 360;
  }
  return hash;
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
