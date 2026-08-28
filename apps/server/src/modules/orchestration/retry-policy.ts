import type { OrchestrationStage } from "../../types.js";

/**
 * The locked retry matrix from `tasks/plan.md` section 7.
 *
 * At most one automatic retry, and only for explicitly transient,
 * side-effect-safe failures. The Builder never retries once its process has
 * started, because file mutations may be partial.
 */

export const MAX_ATTEMPTS = 2; // initial attempt + one retry

export interface RetryDecisionInput {
  stage: OrchestrationStage;
  /** 0-based attempt that just failed. */
  attempt: number;
  /** Machine code when known (e.g. from `ModelAccessError`). */
  code?: string | undefined;
  /** Raw failure message. */
  message: string;
  /** True when the failure is a cancellation, not an error. */
  cancelled?: boolean | undefined;
}

export interface RetryDecision {
  retry: boolean;
  backoffMs: number;
  reason: string;
}

const TRANSIENT_STATUS = /\b(429|502|503|504)\b/;
const TRANSIENT_WORDS =
  /rate.?limit|temporarily unavailable|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i;
const PRE_LAUNCH =
  /gateway|lease issuance|before (the )?(runtime|process) start|failed to (start|launch)|image (not )?(found|present)|pull|network/i;
const POST_START =
  /exited with code|output exceeded|process (start|started)|CODEX_MAX_OUTPUT_BYTES|completed without/i;
const NON_RETRYABLE_CODE =
  /^(LEASE_|POLICY_|SECURITY_|INVALID_INPUT|PROVIDER_NOT_FOUND|MODEL_NOT_ALLOWED|LEASE_REQUEST_REJECTED)/;

const no = (reason: string): RetryDecision => ({ retry: false, backoffMs: 0, reason });
const yes = (reason: string, backoffMs = 500): RetryDecision => ({
  retry: true,
  backoffMs,
  reason,
});

export function decideRetry(input: RetryDecisionInput): RetryDecision {
  if (input.cancelled) return no("cancelled runs are never retried");
  if (input.attempt + 1 >= MAX_ATTEMPTS) return no("retry budget exhausted");

  const code = input.code ?? "";
  if (NON_RETRYABLE_CODE.test(code)) {
    return no(`deterministic control failure (${code})`);
  }
  if (code === "GATEWAY_UNAVAILABLE") {
    return yes("gateway unavailable before lease issuance", 1000);
  }

  const msg = input.message;
  if (POST_START.test(msg)) {
    return no("failure occurred after the Runtime process started");
  }

  const transient = TRANSIENT_STATUS.test(msg) || TRANSIENT_WORDS.test(msg);
  if (!transient && !PRE_LAUNCH.test(msg)) {
    return no("not an enumerated transient, side-effect-safe failure");
  }

  if (input.stage === "builder") {
    // Builder retries ONLY when the failure is clearly pre-process-start.
    return PRE_LAUNCH.test(msg)
      ? yes("builder launch failed before any file mutation")
      : no("builder does not retry once its process may have run");
  }

  // Planner and Reviewer are read-only: transient failures are safe to retry.
  return yes(`transient ${input.stage} failure`);
}
