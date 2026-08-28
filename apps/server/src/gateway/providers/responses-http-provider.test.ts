import { describe, expect, it, vi } from "vitest";
import {
  ProviderHttpError,
  ResponsesHttpProvider,
} from "./responses-http-provider.js";
import type { ResponsesRequest } from "../types.js";

const KEY = "provider-secret-key-do-not-leak";
const BASE_URL = "https://provider.invalid/api/v3";

const request: ResponsesRequest = {
  model: "ark-model",
  input: "summarize this",
  instructions: "be terse",
};

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: async () => text,
  } as unknown as Response;
}

describe("ResponsesHttpProvider", () => {
  it("attaches the bearer credential to the fixed base URL and normalizes output_text", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        model: "ark-model",
        output_text: "done",
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 3 },
        },
      }),
    );
    const provider = new ResponsesHttpProvider({ baseUrl: BASE_URL, apiKey: KEY, fetchImpl });

    const reply = await provider.respond(request, new AbortController().signal);

    expect(reply).toEqual({
      output: "done",
      model: "ark-model",
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/responses`);
    expect((init as RequestInit).headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
    });
    expect((init as RequestInit).body).toContain('"stream":false');
  });

  it("normalizes the structured output array shape", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        output: [
          { content: [{ type: "output_text", text: "a" }] },
          { content: [{ type: "output_text", text: "b" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    const provider = new ResponsesHttpProvider({ baseUrl: BASE_URL, apiKey: KEY, fetchImpl });

    const reply = await provider.respond(request, new AbortController().signal);
    expect(reply.output).toBe("ab");
    expect(reply.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 0,
    });
  });

  it.each([
    [429, "PROVIDER_RATE_LIMITED"],
    [502, "PROVIDER_UNAVAILABLE"],
    [503, "PROVIDER_UNAVAILABLE"],
    [504, "PROVIDER_UNAVAILABLE"],
    [400, "PROVIDER_ERROR"],
    [500, "PROVIDER_ERROR"],
  ] as const)("maps upstream %i to %s without leaking the body", async (status, code) => {
    const fetchImpl = vi.fn(async () =>
      textResponse(status, `secret-upstream-body ${KEY}`),
    );
    const provider = new ResponsesHttpProvider({ baseUrl: BASE_URL, apiKey: KEY, fetchImpl });

    const error = await provider
      .respond(request, new AbortController().signal)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).code).toBe(code);
    expect((error as ProviderHttpError).message).not.toContain(KEY);
    expect((error as ProviderHttpError).message).not.toContain("secret-upstream-body");
  });

  it("maps a network failure to PROVIDER_UNAVAILABLE", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = new ResponsesHttpProvider({ baseUrl: BASE_URL, apiKey: KEY, fetchImpl });

    const error = await provider
      .respond(request, new AbortController().signal)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("rethrows an abort without converting it to a provider error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const provider = new ResponsesHttpProvider({ baseUrl: BASE_URL, apiKey: KEY, fetchImpl });

    const error = await provider
      .respond(request, new AbortController().signal)
      .catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(ProviderHttpError);
    expect((error as Error).name).toBe("AbortError");
  });

  it("bounds an oversized response body", async () => {
    const fetchImpl = vi.fn(async () => textResponse(200, "x".repeat(5000)));
    const provider = new ResponsesHttpProvider({
      baseUrl: BASE_URL,
      apiKey: KEY,
      fetchImpl,
      maxResponseBytes: 128,
    });

    const error = await provider
      .respond(request, new AbortController().signal)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).code).toBe("PROVIDER_ERROR");
  });

  it("rejects malformed JSON as PROVIDER_ERROR", async () => {
    const fetchImpl = vi.fn(async () => textResponse(200, "{not json"));
    const provider = new ResponsesHttpProvider({ baseUrl: BASE_URL, apiKey: KEY, fetchImpl });

    const error = await provider
      .respond(request, new AbortController().signal)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).code).toBe("PROVIDER_ERROR");
  });
});
