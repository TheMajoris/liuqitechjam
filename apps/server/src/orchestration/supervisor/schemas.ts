import { z } from "zod";
import { ORCHESTRATION_LIMITS } from "../schemas.js";
import type { SupervisorRoutingDecision } from "./types.js";
import { SupervisorError } from "./errors.js";

const supervisorParticipantIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORCHESTRATION_LIMITS.maxParticipantIdLength);
export const SUPERVISOR_REASON_MAX_CHARS = 240;
const supervisorReasonSchema = z.string().trim().min(1).max(SUPERVISOR_REASON_MAX_CHARS);

/** Strict JSON shape accepted from a supervisor provider. */
export const SupervisorRoutingDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("invoke"),
      participantId: supervisorParticipantIdSchema,
      reason: supervisorReasonSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("complete"),
      reason: supervisorReasonSchema.optional(),
    })
    .strict(),
]);

const MAX_ROUTING_TEXT_LENGTH = 8_192;

function issueSummary(error: z.ZodError): string {
  const summary = error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "decision";
      return path + ": " + issue.message;
    })
    .join("; ");
  return summary.length > 512 ? summary.slice(0, 509) + "..." : summary;
}

/** Parse and strictly validate an already decoded provider value. */
export function parseSupervisorRoutingDecision(
  value: unknown,
): SupervisorRoutingDecision {
  const parsed = SupervisorRoutingDecisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new SupervisorError(
      "SUPERVISOR_INVALID_RESPONSE",
      "Supervisor returned an invalid routing decision: " + issueSummary(parsed.error),
    );
  }
  if (parsed.data.kind === "invoke") {
    return parsed.data.reason === undefined
      ? { kind: "invoke", participantId: parsed.data.participantId }
      : {
          kind: "invoke",
          participantId: parsed.data.participantId,
          reason: parsed.data.reason,
        };
  }
  return parsed.data.reason === undefined
    ? { kind: "complete" }
    : { kind: "complete", reason: parsed.data.reason };
}

/** Parse the complete response text; markdown/fences/reasoning are rejected. */
export function parseSupervisorRoutingText(text: string): SupervisorRoutingDecision {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new SupervisorError(
      "SUPERVISOR_INVALID_RESPONSE",
      "Supervisor returned an empty routing decision",
    );
  }
  if (text.length > MAX_ROUTING_TEXT_LENGTH) {
    throw new SupervisorError(
      "SUPERVISOR_INVALID_RESPONSE",
      "Supervisor routing decision exceeded the response limit",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new SupervisorError(
      "SUPERVISOR_INVALID_RESPONSE",
      "Supervisor routing decision was not valid JSON",
    );
  }
  return parseSupervisorRoutingDecision(decoded);
}
