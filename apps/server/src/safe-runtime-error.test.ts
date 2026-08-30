import { describe, expect, it } from "vitest";
import {
  MAX_SAFE_RUNTIME_ERROR_LENGTH,
  safeRuntimeError,
} from "./safe-runtime-error.js";

describe("safe runtime errors", () => {
  it("drops raw stderr/JSON details and redacts secrets and host paths", () => {
    const raw =
      'Codex exited with code 1: stderr: {"token":"secret-value","cwd":"/var/lib/launchpad/private"}';

    expect(safeRuntimeError(new Error(raw))).toBe("Agent runtime failed");

    const safe = safeRuntimeError(
      new Error("spawn /opt/launchpad/runtime API_KEY=secret-value ENOENT"),
      "Runtime could not start",
    );
    expect(safe).not.toContain("/opt/launchpad/runtime");
    expect(safe).not.toContain("secret-value");
    expect(safe.length).toBeLessThanOrEqual(MAX_SAFE_RUNTIME_ERROR_LENGTH);
  });

  it("bounds ordinary runtime messages while retaining their stable prefix", () => {
    const safe = safeRuntimeError(new Error("runtime failed " + "x".repeat(2_000)));
    expect(safe.startsWith("runtime failed")).toBe(true);
    expect(safe).toContain("[TRUNCATED]");
    expect(safe.length).toBeLessThanOrEqual(MAX_SAFE_RUNTIME_ERROR_LENGTH);
  });
});

