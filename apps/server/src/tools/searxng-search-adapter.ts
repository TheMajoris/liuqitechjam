import { z } from "zod";
import {
  readBoundedResponseBody,
  SearchResponseTooLargeError,
} from "./search-http-utils.js";
import {
  isHttpUrl,
} from "./brave-search-adapter.js";
import {
  SearchProviderError,
  type SearchProvider,
  type SearchProviderHealth,
  type SearchResult,
} from "./search-provider.js";

export interface SearXngSearchAdapterOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxResults?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export class SearXngSearchError extends SearchProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SearXngSearchError";
  }
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:8080/search";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_LENGTH = 500;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 2_048;
const MAX_DESCRIPTION_LENGTH = 1_000;

const SearXngResultSchema = z.object({
  title: z.string().trim().max(MAX_TITLE_LENGTH),
  url: z
    .string()
    .trim()
    .url()
    .max(MAX_URL_LENGTH)
    .refine(isHttpUrl, "Only HTTP(S) result URLs are allowed"),
  content: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
});

const SearXngResponseSchema = z.object({
  results: z.array(SearXngResultSchema).max(100),
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

function safeEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only HTTP(S) endpoints are supported");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Search provider credentials and query data must not be embedded in the endpoint");
    }
    return parsed.toString();
  } catch (error) {
    throw new TypeError(
      error instanceof Error ? error.message : "Invalid SearXNG endpoint",
    );
  }
}

/** Dependency-free SearXNG JSON adapter for local/self-hosted deployments. */
export class SearXngSearchAdapter implements SearchProvider {
  readonly id = "searxng" as const;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxResponseBytes: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SearXngSearchAdapterOptions = {}) {
    this.timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.maxResults = Number.isInteger(options.maxResults) && options.maxResults !== undefined && options.maxResults > 0
      ? Math.min(options.maxResults, 20)
      : DEFAULT_MAX_RESULTS;
    this.maxResponseBytes = boundedResponseBytes(options.maxResponseBytes);
    this.endpoint = safeEndpoint(options.endpoint?.trim() || DEFAULT_ENDPOINT);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: string, count?: number): Promise<SearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new SearXngSearchError("A search query is required");
    if (normalizedQuery.length > MAX_QUERY_LENGTH) {
      throw new SearXngSearchError("The search query is too long");
    }

    const url = new URL(this.endpoint);
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("format", "json");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "User-Agent": "Volc-Agent-Launchpad/1.0",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SearXngSearchError("Web search provider returned an error");
      }
      let payload: unknown;
      try {
        const body = await readBoundedResponseBody(response, this.maxResponseBytes);
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SearXngSearchError("Web search timed out");
        }
        if (error instanceof SearchResponseTooLargeError) {
          throw new SearXngSearchError(error.message);
        }
        throw new SearXngSearchError("Web search provider returned invalid data", {
          cause: error,
        });
      }
      const parsed = SearXngResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new SearXngSearchError("Web search provider returned invalid data");
      }
      return parsed.data.results.slice(0, boundedCount(count, this.maxResults)).map((result) => ({
        title: boundedText(result.title, MAX_TITLE_LENGTH),
        url: result.url,
        description: boundedText(
          result.description ?? result.content ?? "",
          MAX_DESCRIPTION_LENGTH,
        ),
      }));
    } catch (error) {
      if (error instanceof SearXngSearchError) throw error;
      const isTimeout = controller.signal.aborted;
      throw new SearXngSearchError(
        isTimeout ? "Web search timed out" : "Web search provider is unavailable",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<SearchProviderHealth> {
    const checkedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 3_000));
    timeout.unref();
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set("q", "launchpad health check");
      url.searchParams.set("format", "json");
      const response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json", "User-Agent": "Volc-Agent-Launchpad/1.0" },
        signal: controller.signal,
      });
      if (response.body) void response.body.cancel().catch(() => undefined);
      return {
        provider: this.id,
        status: response.ok ? "available" : "unavailable",
        configured: true,
        endpoint: this.endpoint,
        message: response.ok ? "SearXNG is reachable" : "SearXNG returned an error",
        checkedAt,
      };
    } catch (error) {
      return {
        provider: this.id,
        status: "unavailable",
        configured: true,
        endpoint: this.endpoint,
        message: controller.signal.aborted ? "SearXNG health check timed out" : "SearXNG is unavailable",
        checkedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Keep the acronym-spelled name available to consumers that use SearXNG's
// canonical branding, while the filename/class above follows the project's
// existing PascalCase convention for acronyms.
export const SearXNGSearchAdapter = SearXngSearchAdapter;
export const SearXNGSearchError = SearXngSearchError;
