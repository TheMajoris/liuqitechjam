import { describe, expect, it } from "vitest";
import {
  finalizeCodexRun,
  parseCodexEventLine,
  type ParsedEvents,
} from "../../apps/server/src/codex-runner.js";
import {
  embeddedJsonObject,
  providerErrorCodeFrom,
} from "../../apps/server/src/audit/failure-classification.js";

/**
 * The exact rejection BytePlus Ark returns for a model whose inference limit
 * is reached, as the runtime reports it: prose, then the provider's own body.
 * Detection used to require the whole string to be JSON, so this shape fell
 * through and a paused model surfaced as a bare non-zero exit.
 */
const ARK_LIMIT_MESSAGE =
  'unexpected status 429 Too Many Requests: {"error":{"code":"SetLimitExceeded",' +
  '"message":"Your account [3001092451] has reached the set inference limit for ' +
  'the [seed-2-0-code] model, and the model service has been paused. To continue ' +
  'using this model, please visit the Model Activation page to adjust or close ' +
  'the \\"Safe Experience Mode\\". Request id: 021789013067128e",' +
  '"param":"","type":"TooManyRequests"}}';

function parsed(): ParsedEvents {
  return { messages: [], threadId: null, usage: null, errors: [] };
}

describe("provider inference limit detection", () => {
  it("detects the limit from the payload the runtime actually reports", () => {
    const events = parsed();
    parseCodexEventLine(
      JSON.stringify({ type: "turn.failed", error: ARK_LIMIT_MESSAGE }),
      events,
    );
    expect(events.modelInferenceLimitExceeded).toBe(true);
  });

  it("still detects a bare code and a pure-JSON body", () => {
    const bare = parsed();
    parseCodexEventLine(
      JSON.stringify({ type: "error", code: "SetLimitExceeded" }),
      bare,
    );
    expect(bare.modelInferenceLimitExceeded).toBe(true);

    const pure = parsed();
    parseCodexEventLine(
      JSON.stringify({
        type: "error",
        message: JSON.stringify({ error: { code: "SetLimitExceeded" } }),
      }),
      pure,
    );
    expect(pure.modelInferenceLimitExceeded).toBe(true);
  });

  it("does not fire on the literal quoted in prose", () => {
    // The guarantee the strict matcher exists for: the code must appear as a
    // real field, never as text an Agent or a log line happened to contain.
    const events = parsed();
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.failed",
        error: "the previous run reported SetLimitExceeded but this one did not",
      }),
      events,
    );
    expect(events.modelInferenceLimitExceeded).toBeUndefined();
  });

  it("does not fire on an unrelated rate limit", () => {
    const events = parsed();
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.failed",
        error: 'unexpected status 429: {"error":{"code":"RateLimitExceeded"}}',
      }),
      events,
    );
    expect(events.modelInferenceLimitExceeded).toBeUndefined();
  });
});

describe("embeddedJsonObject", () => {
  it("takes the first balanced object and tolerates braces inside strings", () => {
    expect(embeddedJsonObject('prefix {"a":"}{"} suffix')).toEqual({ a: "}{" });
    expect(embeddedJsonObject('x {"a":{"b":1}} y')).toEqual({ a: { b: 1 } });
  });

  it("returns null when there is nothing parseable", () => {
    expect(embeddedJsonObject("no object here")).toBeNull();
    expect(embeddedJsonObject("unbalanced {")).toBeNull();
    expect(embeddedJsonObject("{not json}")).toBeNull();
  });
});

describe("providerErrorCodeFrom", () => {
  it("recovers the code the audit trail needs from the same message", () => {
    expect(providerErrorCodeFrom(undefined, ARK_LIMIT_MESSAGE)).toBe(
      "SetLimitExceeded",
    );
  });

  it("prefers a bare code and ignores a message with no payload", () => {
    expect(providerErrorCodeFrom("ModelNotFound", ARK_LIMIT_MESSAGE)).toBe(
      "ModelNotFound",
    );
    expect(providerErrorCodeFrom(undefined, "just prose")).toBeUndefined();
  });
});

/**
 * Captured verbatim from codex-cli 0.111.0 against a BytePlus endpoint whose
 * inference limit is reached. The provider's own body says
 * `{"error":{"code":"SetLimitExceeded",...}}`, but the runtime retries
 * internally and forwards only what it saw at the transport — so the status is
 * the only evidence that ever reaches us.
 */
const CODEX_RATE_LIMIT_MESSAGE =
  "exceeded retry limit, last status: 429 Too Many Requests, request id: " +
  "0217890137218300eb6750cc7dc4c5e11333efa00d940eeb74b69";

const EXIT_MESSAGES = {
  timeout: "Runtime timed out",
  exit: "Container runtime exited with code 1",
  missing: "Codex completed without an agent message",
  missingTruncated: "Codex completed without an agent message after truncation",
};

describe("provider rate limit detection", () => {
  it("reads the status out of the terminal event the runtime actually sends", () => {
    const events = parsed();
    parseCodexEventLine(
      JSON.stringify({ type: "error", message: CODEX_RATE_LIMIT_MESSAGE }),
      events,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: CODEX_RATE_LIMIT_MESSAGE },
      }),
      events,
    );
    expect(events.providerRateLimited).toBe(true);
    // Nothing in that message proves the model is paused, only that it was
    // refused, so the stronger claim is not made.
    expect(events.modelInferenceLimitExceeded).toBeUndefined();
  });

  it("fails the run as rate limited instead of a bare non-zero exit", () => {
    const events = parsed();
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: CODEX_RATE_LIMIT_MESSAGE },
      }),
      events,
    );

    expect(() =>
      finalizeCodexRun(
        events,
        { exitCode: 1, cancelled: false, timedOut: false, outputTruncated: false },
        EXIT_MESSAGES,
      ),
    ).toThrowError(
      expect.objectContaining({ errorCode: "MODEL_RATE_LIMITED" }),
    );
  });

  it("lets the provider's own code outrank the status when both are present", () => {
    const events = parsed();
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: '429 Too Many Requests: {"error":{"code":"SetLimitExceeded"}}' },
      }),
      events,
    );
    expect(events.providerRateLimited).toBe(true);
    expect(events.modelInferenceLimitExceeded).toBe(true);

    expect(() =>
      finalizeCodexRun(
        events,
        { exitCode: 1, cancelled: false, timedOut: false, outputTruncated: false },
        EXIT_MESSAGES,
      ),
    ).toThrowError(
      expect.objectContaining({ errorCode: "MODEL_INFERENCE_LIMIT_EXCEEDED" }),
    );
  });

  it("does not treat an unrelated number as a status", () => {
    const events = parsed();
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "the model emitted 429 tokens before stopping" },
      }),
      events,
    );
    expect(events.providerRateLimited).toBeUndefined();
  });

  it("leaves an ordinary failure as an ordinary failure", () => {
    const events = parsed();
    parseCodexEventLine(
      JSON.stringify({ type: "turn.failed", error: { message: "stream closed" } }),
      events,
    );
    expect(() =>
      finalizeCodexRun(
        events,
        { exitCode: 1, cancelled: false, timedOut: false, outputTruncated: false },
        EXIT_MESSAGES,
      ),
    ).toThrowError("Container runtime exited with code 1");
  });
});
