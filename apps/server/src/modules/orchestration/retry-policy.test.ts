import { describe, expect, it } from "vitest";
import { decideRetry, type RetryDecisionInput } from "./retry-policy.js";

const base: RetryDecisionInput = {
  stage: "planner",
  attempt: 0,
  message: "",
};

describe("decideRetry", () => {
  it.each<[string, Partial<RetryDecisionInput>, boolean]>([
    ["planner transient 503", { stage: "planner", message: "provider returned 503" }, true],
    ["reviewer rate limit", { stage: "reviewer", message: "rate limit exceeded" }, true],
    ["planner second attempt", { stage: "planner", attempt: 1, message: "503" }, false],
    ["planner non-transient", { stage: "planner", message: "assertion failed in plan" }, false],
    ["gateway unavailable code", { stage: "builder", code: "GATEWAY_UNAVAILABLE", message: "x" }, true],
    ["lease revoked code", { stage: "planner", code: "LEASE_REVOKED", message: "x" }, false],
    ["lease request rejected", { stage: "planner", code: "LEASE_REQUEST_REJECTED", message: "x" }, false],
    ["builder transient but not pre-launch", { stage: "builder", message: "provider 502" }, false],
    ["builder pre-launch failure", { stage: "builder", message: "failed to launch container image" }, true],
    ["builder post-start failure", { stage: "builder", message: "container exited with code 1" }, false],
    ["cancelled", { stage: "planner", cancelled: true, message: "Run cancelled" }, false],
  ])("%s -> retry=%s", (_label, override, expected) => {
    expect(decideRetry({ ...base, ...override }).retry).toBe(expected);
  });

  it("returns a backoff only when it recommends a retry", () => {
    expect(decideRetry({ ...base, message: "504" }).backoffMs).toBeGreaterThan(0);
    expect(decideRetry({ ...base, message: "nope" }).backoffMs).toBe(0);
  });
});
