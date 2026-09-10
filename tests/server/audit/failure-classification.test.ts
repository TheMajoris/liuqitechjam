import { describe, expect, it } from "vitest";
import {
  classifyFailureText,
  providerStatusFrom,
  safeProviderErrorCode,
} from "../../../apps/server/src/audit/failure-classification";
import { safeAuditMetadata } from "../../../apps/server/src/audit/audit-redaction";

describe("classifyFailureText", () => {
  it.each([
    ["The endpoint ep-20260831143538-qk8qn does not exist", "provider_model_not_found"],
    ["SetLimitExceeded: account limit reached", "provider_quota_exhausted"],
    ["Rate limit exceeded, please retry", "provider_rate_limited"],
    ["401 Unauthorized", "provider_auth"],
    ["This model's maximum context length is 128000 tokens", "provider_context_length"],
    ["Container runtime exited with code 1", "runtime_exited_nonzero"],
    ["Container runtime could not start", "runtime_start_failed"],
    ["Runtime timed out after 300000 ms", "runtime_timed_out"],
    ["Codex completed without an agent message", "no_agent_message"],
    ["connect ECONNREFUSED 127.0.0.1:443", "provider_unreachable"],
  ])("classifies %j", (text, expected) => {
    expect(classifyFailureText(text)).toBe(expected);
  });

  it("reads an Error and never fails on an absent or odd value", () => {
    expect(classifyFailureText(new Error("429 Too Many Requests"))).toBe(
      "provider_rate_limited",
    );
    expect(classifyFailureText(undefined)).toBe("unclassified");
    expect(classifyFailureText(null)).toBe("unclassified");
    expect(classifyFailureText({ message: "quota" })).toBe("unclassified");
  });

  it("classifies a large payload without scanning all of it", () => {
    // The marker sits past the scan window, so a classification never depends
    // on retaining or reading an unbounded provider body.
    const padded = "x".repeat(8_000) + " rate limit exceeded";
    expect(classifyFailureText(padded)).toBe("unclassified");
  });
});

describe("safeProviderErrorCode", () => {
  it("keeps a bare documented code", () => {
    expect(safeProviderErrorCode("SetLimitExceeded")).toBe("SetLimitExceeded");
    expect(safeProviderErrorCode("model_not_found")).toBe("model_not_found");
  });

  it("drops anything that is a message rather than a code", () => {
    expect(safeProviderErrorCode("Rate limit exceeded for key sk-abc")).toBeUndefined();
    expect(safeProviderErrorCode("")).toBeUndefined();
    expect(safeProviderErrorCode(404)).toBeUndefined();
    expect(safeProviderErrorCode("a".repeat(200))).toBeUndefined();
  });
});

describe("providerStatusFrom", () => {
  it("reads a status from a number or a labelled mention", () => {
    expect(providerStatusFrom(429)).toBe(429);
    expect(providerStatusFrom("HTTP 503 from provider")).toBe(503);
    expect(providerStatusFrom("status: 404")).toBe(404);
  });

  it("ignores numbers that are not statuses", () => {
    expect(providerStatusFrom(42)).toBeUndefined();
    expect(providerStatusFrom("finished in 250 ms")).toBeUndefined();
  });
});

describe("audit metadata retention", () => {
  /**
   * Audit metadata drops free-text keys by design. These fields are the whole
   * point of the classification, so pin that they survive the deny-list — a
   * silently dropped key would leave the trail exactly as mute as before.
   */
  it("retains every classification field it is given", () => {
    const metadata = safeAuditMetadata({
      failureKind: "provider_quota_exhausted",
      providerErrorCode: "SetLimitExceeded",
      providerStatus: 429,
      failureRule: "supervisor_repeated_agent_after_correction",
      stderrBytes: 2048,
      exitCode: 1,
    });
    expect(metadata).toEqual({
      failureKind: "provider_quota_exhausted",
      providerErrorCode: "SetLimitExceeded",
      providerStatus: 429,
      failureRule: "supervisor_repeated_agent_after_correction",
      stderrBytes: 2048,
      exitCode: 1,
    });
  });
});
