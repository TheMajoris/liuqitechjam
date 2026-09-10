/**
 * Turning a failure into evidence a reader can act on.
 *
 * A failed Run used to leave `errorClass: "Error"` and a failed model turn
 * left nothing at all, so the trail recorded *that* a turn died without ever
 * recording *why*: a dead provider endpoint, an exhausted quota, an oversized
 * prompt, and a container that could not start were indistinguishable.
 *
 * The output is a closed set of tokens, never the provider's own text. Audit
 * metadata deliberately keeps identifiers and enum-like evidence and drops
 * free-form strings, because provider messages carry prompts, request
 * identifiers, credentials, and paths. A classification survives that rule and
 * still answers the question the reader actually has.
 */
export type FailureKind =
  | "provider_auth"
  | "provider_model_not_found"
  | "provider_rate_limited"
  | "provider_quota_exhausted"
  | "provider_context_length"
  | "provider_server_error"
  | "provider_request_rejected"
  | "provider_unreachable"
  | "runtime_timed_out"
  | "runtime_start_failed"
  | "runtime_exited_nonzero"
  | "runtime_out_of_memory"
  | "no_agent_message"
  | "cancelled"
  | "unclassified";

/** Ordered: the first matching rule wins, so specific patterns lead. */
const RULES: readonly [RegExp, FailureKind][] = [
  [/\b(?:setlimitexceeded|quota|insufficient[_ ]?(?:quota|balance|credit)|billing|payment required|arrearage)\b/, "provider_quota_exhausted"],
  [/\b(?:rate[_ ]?limit|too many requests|429|throttl)/, "provider_rate_limited"],
  [/\b(?:unauthoriz|unauthenticated|authentication|invalid api[_ ]?key|invalid[_ ]?access[_ ]?key|forbidden|permission denied|401|403)\b/, "provider_auth"],
  [/\b(?:model not found|endpoint .*not (?:found|exist)|does not exist|no such model|invalid endpoint|unknown model|modelnotfound|404)\b/, "provider_model_not_found"],
  [/\b(?:context[_ ]?length|maximum context|too many tokens|token limit|prompt is too long|input too long)\b/, "provider_context_length"],
  [/\b(?:internal server error|service unavailable|bad gateway|gateway timeout|50[0234])\b/, "provider_server_error"],
  [/\b(?:econnrefused|enotfound|etimedout|econnreset|dns|network|socket hang up|fetch failed)\b/, "provider_unreachable"],
  [/\b(?:out of memory|oom|killed process)\b/, "runtime_out_of_memory"],
  [/\b(?:timed out|timeout|deadline exceeded)\b/, "runtime_timed_out"],
  [/\bcould not start\b/, "runtime_start_failed"],
  [/\bexited with code\b/, "runtime_exited_nonzero"],
  [/\bwithout an agent message\b/, "no_agent_message"],
  [/\b(?:cancelled|canceled|aborted)\b/, "cancelled"],
  [/\b(?:invalid|malformed|bad request|unsupported|400|422)\b/, "provider_request_rejected"],
];

/**
 * Classify failure text without retaining any of it.
 *
 * Matching is over a lowercased copy that never leaves this function; only the
 * returned token is ever recorded.
 */
export function classifyFailureText(value: unknown): FailureKind {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  if (!text) return "unclassified";
  // Provider payloads can be large; a classification never needs the tail.
  const haystack = text.slice(0, 4_096).toLowerCase();
  for (const [pattern, kind] of RULES) {
    if (pattern.test(haystack)) return kind;
  }
  return "unclassified";
}

/**
 * The provider's own short error code, when the payload carries one.
 *
 * Codes are stable, documented tokens (`SetLimitExceeded`, `RateLimitExceeded`)
 * and are the one piece of a provider error worth quoting: they name the exact
 * condition without carrying the request. Anything that does not look like a
 * bare code — spaces, punctuation, sentence length — is dropped rather than
 * trimmed, because a truncated message is not a code.
 */
export function safeProviderErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(trimmed) ? trimmed : undefined;
}

/** The HTTP status a provider error names, when it names one. */
export function providerStatusFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const match = /\b(?:status|code|http)\D{0,4}([1-5]\d{2})\b/i.exec(value.slice(0, 512));
  const parsed = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * The first balanced JSON object inside a string, or null.
 *
 * The runtime reports a provider rejection as prose with the provider's own
 * body appended — `unexpected status 429 Too Many Requests: {"error":{...}}`.
 * That is a structured payload wearing a prefix, not free text, so it is
 * parsed rather than pattern-matched: the code still has to appear as a real
 * `code` field, and the literal quoted in someone's prose still matches
 * nothing. Without this the exhausted-limit rejection that BytePlus actually
 * sends went undetected and surfaced as a bare non-zero exit.
 */
export function embeddedJsonObject(value: string): unknown {
  const start = value.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(value.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}


/**
 * The provider's own error code, including one delivered inside a payload
 * that the runtime appended to a prose message.
 *
 * Reads a `code` (or `type`) field from a real parsed object only, so the
 * literal appearing in someone's prose is never mistaken for a code.
 */
export function providerErrorCodeFrom(
  bare: unknown,
  message: unknown,
): string | undefined {
  const direct = safeProviderErrorCode(bare);
  if (direct !== undefined) return direct;
  if (typeof message !== "string") return undefined;
  const payload = embeddedJsonObject(message);
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : undefined;
  const error =
    typeof record?.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : undefined;
  return (
    safeProviderErrorCode(error?.code) ??
    safeProviderErrorCode(record?.code) ??
    safeProviderErrorCode(error?.type)
  );
}
