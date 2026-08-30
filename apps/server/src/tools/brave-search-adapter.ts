import { z } from "zod";

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveSearchAdapterOptions {
  apiKey?: string;
  timeoutMs?: number;
  maxResults?: number;
  maxResponseBytes?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export class BraveSearchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BraveSearchError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_LENGTH = 500;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 2_048;
const MAX_DESCRIPTION_LENGTH = 1_000;

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const BraveResultSchema = z.object({
  title: z.string().trim().max(MAX_TITLE_LENGTH),
  url: z
    .string()
    .trim()
    .url()
    .max(MAX_URL_LENGTH)
    .refine(isHttpUrl, "Only HTTP(S) result URLs are allowed"),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
});

const BraveResponseSchema = z.object({
  web: z.object({
    results: z.array(BraveResultSchema).max(20),
  }),
});

function boundedCount(value: number | undefined, maxResults: number): number {
  const requested = value !== undefined && Number.isInteger(value) ? value : maxResults;
  return Math.min(Math.max(requested, 1), maxResults);
}

function boundedText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function boundedResponseBytes(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? Math.min(value, MAX_RESPONSE_BYTES)
    : DEFAULT_MAX_RESPONSE_BYTES;
}

class ResponseTooLargeError extends Error {
  constructor() {
    super("Web search provider response was too large");
    this.name = "ResponseTooLargeError";
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ResponseTooLargeError();
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * Small, dependency-free Brave adapter. Provider payloads never leave this
 * boundary and provider errors intentionally do not include response bodies.
 */
export class BraveSearchAdapter {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxResponseBytes: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BraveSearchAdapterOptions | string = {}) {
    const resolved = typeof options === "string" ? { apiKey: options } : options;
    this.apiKey = resolved.apiKey?.trim() ?? "";
    this.timeoutMs = Number.isInteger(resolved.timeoutMs) && resolved.timeoutMs !== undefined && resolved.timeoutMs > 0
      ? resolved.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.maxResults = Number.isInteger(resolved.maxResults) && resolved.maxResults !== undefined && resolved.maxResults > 0
      ? Math.min(resolved.maxResults, 20)
      : DEFAULT_MAX_RESULTS;
    this.maxResponseBytes = boundedResponseBytes(resolved.maxResponseBytes);
    this.endpoint = resolved.endpoint?.trim() || DEFAULT_ENDPOINT;
    this.fetchImpl = resolved.fetchImpl ?? fetch;
  }

  async search(query: string, count?: number): Promise<BraveSearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new BraveSearchError("A search query is required");
    if (normalizedQuery.length > MAX_QUERY_LENGTH) {
      throw new BraveSearchError("The search query is too long");
    }
    if (!this.apiKey || this.apiKey.startsWith("replace-")) {
      throw new BraveSearchError("Web search is not configured");
    }

    const url = new URL(this.endpoint);
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("count", String(boundedCount(count, this.maxResults)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BraveSearchError("Web search provider returned an error");
      }
      let payload: unknown;
      try {
        const body = await readBoundedBody(response, this.maxResponseBytes);
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new BraveSearchError("Web search timed out");
        }
        if (error instanceof ResponseTooLargeError) {
          throw new BraveSearchError(error.message);
        }
        throw new BraveSearchError("Web search provider returned invalid data", {
          cause: error,
        });
      }
      const parsed = BraveResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new BraveSearchError("Web search provider returned invalid data");
      }
      return parsed.data.web.results.slice(0, this.maxResults).map((result) => ({
        title: boundedText(result.title, MAX_TITLE_LENGTH),
        url: result.url,
        description: boundedText(result.description ?? "", MAX_DESCRIPTION_LENGTH),
      }));
    } catch (error) {
      if (error instanceof BraveSearchError) throw error;
      const isTimeout = controller.signal.aborted;
      throw new BraveSearchError(
        isTimeout
          ? "Web search timed out"
          : "Web search provider is unavailable",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type BraveSearchClient = BraveSearchAdapter;
