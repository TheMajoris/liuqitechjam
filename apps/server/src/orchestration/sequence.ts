/**
 * The small, pure interface used by the graph router to choose the next
 * participant.  Agent identities are data, so the sequence intentionally
 * accepts any roster instead of knowing about product roles.
 */
export interface SequenceParticipant {
  id: string;
  agentId: string;
  role: string;
  position: number;
}

export type SequenceStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type SequenceMode = "sequential" | "round_robin";

export interface SequenceInput {
  participants: readonly SequenceParticipant[];
  /** Number of participant positions already dispatched (zero based). */
  stepIndex: number;
  /** Maximum number of participant dispatches permitted for this run. */
  maxSteps: number;
  /** Defaults to one pass for backward-compatible callers. */
  mode?: SequenceMode | undefined;
  status?: SequenceStatus | undefined;
}

export type SequenceEndReason =
  | "roster_exhausted"
  | "supervisor_completed"
  | "max_steps_reached"
  | "invalid_state"
  | "invalid_roster"
  | "terminal_state";

export type SequenceDecision =
  | {
      kind: "invoke";
      participant: SequenceParticipant;
      stepIndex: number;
      /** Optional bounded human-readable supervisor routing reason. */
      reason?: string | undefined;
    }
  | {
      kind: "end";
      reason: SequenceEndReason;
      /** Optional bounded human-readable supervisor routing reason. */
      detail?: string | undefined;
    };

const TERMINAL_STATUSES = new Set<SequenceStatus>([
  "completed",
  "failed",
  "stopped",
]);

function isParticipant(value: unknown): value is SequenceParticipant {
  if (typeof value !== "object" || value === null) return false;
  const participant = value as Partial<SequenceParticipant>;
  return (
    typeof participant.id === "string" &&
    participant.id.trim().length > 0 &&
    typeof participant.agentId === "string" &&
    participant.agentId.trim().length > 0 &&
    typeof participant.role === "string" &&
    participant.role.trim().length > 0 &&
    typeof participant.position === "number" &&
    Number.isInteger(participant.position) &&
    participant.position >= 0
  );
}

function validStatus(status: SequenceStatus | undefined): boolean {
  return status === undefined || status === "running" || TERMINAL_STATUSES.has(status);
}

function orderedRoster(
  participants: readonly SequenceParticipant[],
): SequenceParticipant[] | null {
  if (!Array.isArray(participants) || participants.length === 0) return null;

  const ids = new Set<string>();
  const positions = new Set<number>();
  for (const participant of participants) {
    if (!isParticipant(participant)) return null;
    if (ids.has(participant.id) || positions.has(participant.position)) return null;
    ids.add(participant.id);
    positions.add(participant.position);
  }

  return [...participants].sort((left, right) => left.position - right.position);
}

/**
 * Choose the next declared participant or a deterministic terminal reason.
 *
 * `stepIndex` is a dispatch count, not an array offset supplied by a caller;
 * the roster is copied and ordered by its explicit positions.  This keeps the
 * graph's control flow deterministic even when a client sends participants in
 * an arbitrary order.  The function never mutates its input or reads any
 * model-produced content.
 */
export function advanceSequence(input: SequenceInput): SequenceDecision {
  if (
    typeof input !== "object" ||
    input === null ||
    !Number.isInteger(input.stepIndex) ||
    input.stepIndex < 0 ||
    !Number.isInteger(input.maxSteps) ||
    input.maxSteps <= 0 ||
    (input.mode !== undefined &&
      input.mode !== "sequential" &&
      input.mode !== "round_robin") ||
    !validStatus(input.status)
  ) {
    return { kind: "end", reason: "invalid_state" };
  }

  const roster = orderedRoster(input.participants);
  if (!roster) return { kind: "end", reason: "invalid_roster" };
  const mode = input.mode ?? "sequential";
  if (input.status !== undefined && TERMINAL_STATUSES.has(input.status)) {
    return { kind: "end", reason: "terminal_state" };
  }
  if (mode === "sequential" && input.stepIndex >= roster.length) {
    return { kind: "end", reason: "roster_exhausted" };
  }
  // A roster that completed exactly at its limit is a normal completion. The
  // max-step guard applies only while another declared position remains.
  if (input.stepIndex >= input.maxSteps) {
    return { kind: "end", reason: "max_steps_reached" };
  }

  // The roster was validated and sorted above, so this lookup is defined.
  const participant = roster[
    mode === "round_robin" ? input.stepIndex % roster.length : input.stepIndex
  ];
  if (!participant) return { kind: "end", reason: "roster_exhausted" };
  return {
    kind: "invoke",
    participant,
    stepIndex: input.stepIndex,
  };
}
