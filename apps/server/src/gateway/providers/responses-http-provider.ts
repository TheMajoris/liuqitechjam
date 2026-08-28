import type { RunUsage } from "../../types.js";
import type {
  ResponsesProvider,
  ResponsesReply,
  ResponsesRequest,
} from "../types.js";

/**
 * Responses-compatible HTTP adapter. This is the ONLY place a provider
 * credential is attached to an outbound request, and only ever as
 * `Authorization: Bearer <key>` to the provider's fixed, pre-configured base
 * URL. Upstream bodies and headers are never surfaced to the caller; failures
 * are normalized to a small set of safe codes.
 */

export type ProviderErrorCode =
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR";

export class ProviderHttpError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ResponsesHttpProviderOptions {
  /** Fixed, allowlisted provider base URL (no trailing slash). */
  baseUrl: string;
  /** Provider credential VALUE. Held only here; never logged or returned. */
  apiKey: string;
  fetchImpl?: FetchLike;
  /** Hard cap on the number of response bytes read. Default 1 MiB. */
  maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

function codeForStatus(status: number): ProviderErrorCode {
  if (status === 429) {
    return "PROVIDER_RATE_LIMITED";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "PROVIDER_UNAVAILABLE";
  }
  return "PROVIDER_ERROR";
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ProviderHttpError(
        "PROVIDER_ERROR",
        502,
        "Provider response exceeded the size limit",
      );
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderHttpError(
        "PROVIDER_ERROR",
        502,
        "Provider response exceeded the size limit",
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizePayload(parsed: unknown, fallbackModel: string): ResponsesReply {
  const payload = (parsed ?? {}) as Record<string, unknown>;
  const model =
    typeof payload.model === "string" ? payload.model : fallbackModel;

  let output = "";
  if (typeof payload.output_text === "string") {
    output = payload.output_text;
  } else if (Array.isArray(payload.output)) {
    const segments: string[] = [];
    for (const item of payload.output as unknown[]) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const chunk of content) {
        if (
          chunk &&
          typeof chunk === "object" &&
          typeof (chunk as { text?: unknown }).text === "string"
        ) {
          segments.push((chunk as { text: string }).text);
        }
      }
    }
    output = segments.join("");
  }

  const usageRaw = (payload.usage ?? {}) as Record<string, unknown>;
  const details = (usageRaw.input_tokens_details ?? {}) as Record<string, unknown>;
  const usage: RunUsage = {};
  const inputTokens = numberOrUndefined(usageRaw.input_tokens);
  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  const outputTokens = numberOrUndefined(usageRaw.output_tokens);
  if (outputTokens !== undefined) {
    usage.outputTokens = outputTokens;
  }
  usage.cachedInputTokens = numberOrUndefined(details.cached_tokens) ?? 0;

  return { output, usage, model };
}

export class ResponsesHttpProvider implements ResponsesProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxResponseBytes: number;

  constructor(options: ResponsesHttpProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async respond(
    request: ResponsesRequest,
    signal: AbortSignal,
  ): Promise<ResponsesReply> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: request.input,
      stream: false,
    };
    if (request.instructions !== undefined) {
      body.instructions = request.instructions;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ProviderHttpError(
        "PROVIDER_UNAVAILABLE",
        502,
        "Provider request could not be completed",
      );
    }

    if (!response.ok) {
      // Deliberately do not read or forward the upstream body/headers.
      throw new ProviderHttpError(
        codeForStatus(response.status),
        response.status,
        `Provider responded with status ${response.status}`,
      );
    }

    const raw = await readBoundedText(response, this.maxResponseBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderHttpError(
        "PROVIDER_ERROR",
        502,
        "Provider returned a malformed response",
      );
    }
    return normalizePayload(parsed, request.model);
  }
}
