import { describe, expect, it } from "vitest";
import { DeterministicMockProvider } from "./deterministic-mock-provider.js";
import type { ResponsesRequest } from "../types.js";

const provider = new DeterministicMockProvider();
const signal = new AbortController().signal;

describe("DeterministicMockProvider", () => {
  it("produces identical output and usage for identical input", async () => {
    const request: ResponsesRequest = { model: "mock-model", input: "one two three" };
    const a = await provider.respond(request, signal);
    const b = await provider.respond(request, signal);

    expect(a).toEqual(b);
    expect(a.model).toBe("mock-model");
    expect(a.output).toMatch(/^mock:[0-9a-f]{32}$/);
    expect(a.usage).toEqual({
      inputTokens: 3,
      cachedInputTokens: 0,
      outputTokens: Math.ceil("one two three".length / 4),
    });
  });

  it("changes output when the input changes", async () => {
    const a = await provider.respond({ model: "mock-model", input: "alpha" }, signal);
    const b = await provider.respond({ model: "mock-model", input: "beta" }, signal);
    expect(a.output).not.toBe(b.output);
  });

  it("flattens structured input deterministically", async () => {
    const structured: ResponsesRequest = {
      model: "mock-model",
      input: [{ role: "user", content: "hello world" }],
    };
    const flat: ResponsesRequest = { model: "mock-model", input: "hello world" };
    expect((await provider.respond(structured, signal)).output).toBe(
      (await provider.respond(flat, signal)).output,
    );
  });

  it("rejects a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.respond({ model: "mock-model", input: "x" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
