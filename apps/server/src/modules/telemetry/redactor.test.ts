import { describe, expect, it } from "vitest";

import { REDACTED, TRUNCATED, redactPreview, redactValue } from "./redactor.js";

const noSecrets = { secretValues: [] as string[] };

describe("redactValue", () => {
  it("redacts nested fields by sensitive key name (case-insensitive, substring)", () => {
    const input = {
      user: "alice",
      Authorization: "Bearer abc123def456ghi789",
      nested: {
        API_KEY: "plain-value",
        details: { admin_token: "value", note: "keep me" },
      },
      list: [{ password: "hunter2" }, { safe: "ok" }],
    };

    const output = redactValue(input, noSecrets) as Record<string, unknown>;

    expect(output.user).toBe("alice");
    expect(output.Authorization).toBe(REDACTED);
    const nested = output.nested as Record<string, unknown>;
    expect(nested.API_KEY).toBe(REDACTED);
    const details = nested.details as Record<string, unknown>;
    expect(details.admin_token).toBe(REDACTED);
    expect(details.note).toBe("keep me");
    const list = output.list as Array<Record<string, unknown>>;
    expect(list[0]?.password).toBe(REDACTED);
    expect(list[1]?.safe).toBe("ok");
  });

  it("still redacts by key name when secretValues is empty", () => {
    const output = redactValue({ secret: "x", ok: "y" }, noSecrets) as Record<
      string,
      unknown
    >;
    expect(output.secret).toBe(REDACTED);
    expect(output.ok).toBe("y");
  });

  it("replaces a configured secret value found as a substring of a longer string", () => {
    const output = redactValue(
      { message: "connecting with key=SUPERSECRET42 to upstream" },
      { secretValues: ["SUPERSECRET42"] },
    ) as Record<string, unknown>;
    expect(output.message).toBe(`connecting with key=${REDACTED} to upstream`);
  });

  it("redacts a Bearer token embedded in free text", () => {
    const output = redactValue(
      { log: "sent header Authorization: Bearer eyJhbGciOiJ.payload.sig done" },
      noSecrets,
    ) as Record<string, unknown>;
    expect(output.log).not.toContain("eyJhbGciOiJ.payload.sig");
    expect(output.log).toContain(`Bearer ${REDACTED}`);
  });

  it("redacts standalone lease_ / glease_ / sk- prefixed tokens", () => {
    const output = redactValue(
      {
        a: "lease_9f8e7d6c5b4a3f2e1d0c9b8a",
        b: "issued glease_AbCd1234EfGh5678IjKl9012 now",
        c: "sk-1234567890abcdefghijklmno",
      },
      noSecrets,
    ) as Record<string, string>;
    expect(output.a).toBe(REDACTED);
    expect(output.b).toBe(`issued ${REDACTED} now`);
    expect(output.c).toBe(REDACTED);
  });

  it("preserves an ordinary UUID and ordinary long tokens", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const output = redactValue(
      { id: uuid, word: "supercalifragilisticexpialidocious", hex: "a".repeat(40) },
      noSecrets,
    ) as Record<string, string>;
    expect(output.id).toBe(uuid);
    expect(output.word).toBe("supercalifragilisticexpialidocious");
    expect(output.hex).toBe("a".repeat(40));
  });

  it("leaves numbers, booleans and null untouched", () => {
    const output = redactValue(
      { n: 42, f: 3.14, t: true, z: null },
      noSecrets,
    ) as Record<string, unknown>;
    expect(output).toEqual({ n: 42, f: 3.14, t: true, z: null });
  });

  it("truncates nesting deeper than 8 levels", () => {
    let value: unknown = "leaf-value";
    for (let i = 0; i < 12; i += 1) {
      value = { nested: value };
    }
    const serialized = JSON.stringify(redactValue(value, noSecrets));
    expect(serialized).toContain(TRUNCATED);
    expect(serialized).not.toContain("leaf-value");
  });
});

describe("redactPreview", () => {
  it("passes a plain string through as its own text (no JSON quoting)", () => {
    expect(redactPreview("hello world", noSecrets)).toBe("hello world");
  });

  it("JSON-stringifies non-string values after redaction", () => {
    expect(redactPreview({ token: "abc", keep: 1 }, noSecrets)).toBe(
      `{"token":"${REDACTED}","keep":1}`,
    );
  });

  it("byte-caps the preview without splitting a multibyte character", () => {
    // Each "你" is 3 UTF-8 bytes; 100 of them = 300 bytes.
    const input = "你".repeat(100);
    const maxBytes = 50; // not a multiple of 3
    const output = redactPreview(input, { ...noSecrets, maxBytes });

    const marker = output.indexOf("…[+");
    expect(marker).toBeGreaterThan(0);
    const body = output.slice(0, marker);

    const bodyBytes = new TextEncoder().encode(body).length;
    expect(bodyBytes).toBeLessThanOrEqual(maxBytes);
    // 48 is the largest multiple of 3 <= 50, so 16 chars survive.
    expect(body).toBe("你".repeat(16));
    // Round-trips cleanly: no U+FFFD replacement characters.
    expect(body).not.toContain("�");
    expect(output).toBe(`${body}…[+${300 - bodyBytes} bytes]`);
  });

  it("does not append the suffix when nothing was dropped", () => {
    const output = redactPreview("short", { ...noSecrets, maxBytes: 2048 });
    expect(output).toBe("short");
  });
});
