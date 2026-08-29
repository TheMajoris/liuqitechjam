import { redactSensitiveText } from "../handoff.js";
import type { AppConfig } from "../../config.js";
import { SupervisorError, createAbortError, isAbortError } from "./errors.js";
import { buildSupervisorPrompt } from "./context.js";
import { parseSupervisorRoutingText } from "./schemas.js";
import type {
  SupervisorProvider,
  SupervisorProviderOptions,
  SupervisorRoutingDecision,
  SupervisorSelectionContext,
} from "./types.js";

export const DEFAULT_SUPERVISOR_TIMEOUT_MS = 120_000;
export const DEFAULT_SUPERVISOR_MAX_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_SUPERVISOR_MAX_ERROR_BODY_BYTES = 8 * 1024;
export const DEFAULT_SUPERVISOR_MAX_ERROR_MESSAGE_CHARS = 2_000;

export interface ArkResponsesSupervisorProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  maxErrorBodyBytes?: number;
}

export type ArkResponsesSupervisorConfig = Pick<
  AppConfig,
  "arkApiKey" | "arkBaseUrl" | "supervisorModel" | "supervisorTimeoutMs"
>;

interface BoundedBody {
  text: string;
  truncated: boolean;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function boundedSafeText(value: unknown, maxChars: number): string {
  const safe = redactSensitiveText(
    value instanceof Error ? value.message : String(value ?? ""),
  ).trim();
  if (safe.length <= maxChars) return safe;
  if (maxChars <= 3) return safe.slice(0, maxChars);
  return safe.slice(0, maxChars - 3).trimEnd() + "...";
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new SupervisorError(
      "SUPERVISOR_NOT_CONFIGURED",
      "Supervisor base URL is invalid",
    );
  }
  return baseUrl;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function extractOutputText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text;
  }
  if (!Array.isArray(record.output)) return null;

  const texts: string[] = [];
  for (const item of record.output) {
    const message = asRecord(item);
    if (!message || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      const block = asRecord(content);
      if (
        block?.type === "output_text" &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        texts.push(block.text);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SupervisorError(
      "SUPERVISOR_INVALID_RESPONSE",
      "Supervisor returned a non-JSON response envelope",
    );
  }
}

function timeoutError(timeoutMs: number): SupervisorError {
  return new SupervisorError(
    "SUPERVISOR_TIMED_OUT",
    "Supervisor request timed out after " + String(timeoutMs) + " ms",
  );
}

/**
 * Minimal, no-retry Ark Responses API adapter. It requests a JSON-only route,
 * sends no tools/reasoning configuration, and never stores raw provider text.
 */
export class ArkResponsesSupervisorProvider implements SupervisorProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxErrorBodyBytes: number;

  constructor(options: ArkResponsesSupervisorProviderOptions) {
    const apiKey = options.apiKey.trim();
    const model = options.model.trim();
    if (!apiKey || apiKey.startsWith("replace-")) {
      throw new SupervisorError(
        "SUPERVISOR_NOT_CONFIGURED",
        "Supervisor requires ARK_API_KEY",
      );
    }
    if (!model || model.includes("replace-")) {
      throw new SupervisorError(
        "SUPERVISOR_NOT_CONFIGURED",
        "Supervisor requires SUPERVISOR_MODEL or ARK_MODEL",
      );
    }
    const timeoutMs = positiveLimit(
      options.timeoutMs,
      DEFAULT_SUPERVISOR_TIMEOUT_MS,
    );
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxResponseBytes = positiveLimit(
      options.maxResponseBytes,
      DEFAULT_SUPERVISOR_MAX_RESPONSE_BYTES,
    );
    this.maxErrorBodyBytes = positiveLimit(
      options.maxErrorBodyBytes,
      DEFAULT_SUPERVISOR_MAX_ERROR_BODY_BYTES,
    );
    if (typeof this.fetchImpl !== "function") {
      throw new SupervisorError(
        "SUPERVISOR_NOT_CONFIGURED",
        "Supervisor fetch is unavailable",
      );
    }
  }

  async decide(
    context: SupervisorSelectionContext,
    options: SupervisorProviderOptions = {},
  ): Promise<SupervisorRoutingDecision> {
    if (options.signal?.aborted) throw createAbortError();
    const controller = new AbortController();
    const timeoutMs = positiveLimit(options.timeoutMs, this.timeoutMs);
    let timedOut = false;
    const onAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeout.unref?.();

    try {
      const response = await this.fetchImpl(this.baseUrl + "/responses", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: buildSupervisorPrompt(context),
          store: false,
          // Routing needs only the declared JSON decision. Do not request or
          // retain a private reasoning trace from the provider.
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      });
      if (options.signal?.aborted) throw createAbortError();
      if (timedOut) throw timeoutError(timeoutMs);
      const body = await readBoundedBody(
        response,
        response.ok ? this.maxResponseBytes : this.maxErrorBodyBytes,
      );
      if (options.signal?.aborted) throw createAbortError();
      if (timedOut) throw timeoutError(timeoutMs);
      if (!response.ok) {
        const suffix = body.text.trim()
          ? ": " + boundedSafeText(body.text, DEFAULT_SUPERVISOR_MAX_ERROR_MESSAGE_CHARS - 400)
          : "";
        throw new SupervisorError(
          "SUPERVISOR_REQUEST_FAILED",
          "Supervisor request failed with HTTP " + String(response.status) + suffix,
        );
      }
      if (body.truncated) {
        throw new SupervisorError(
          "SUPERVISOR_INVALID_RESPONSE",
          "Supervisor response exceeded the response limit",
        );
      }
      const outputText = extractOutputText(parseJsonBody(body.text));
      if (!outputText) {
        throw new SupervisorError(
          "SUPERVISOR_INVALID_RESPONSE",
          "Supervisor response did not contain output_text content",
        );
      }
      return parseSupervisorRoutingText(outputText);
    } catch (error) {
      if (options.signal?.aborted) {
        if (isAbortError(error)) throw error;
        throw createAbortError();
      }
      if (timedOut) throw timeoutError(timeoutMs);
      if (isAbortError(error)) throw error;
      if (error instanceof SupervisorError) throw error;
      throw new SupervisorError(
        "SUPERVISOR_REQUEST_FAILED",
        "Supervisor request failed: " + boundedSafeText(error, 1_600),
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Build the built-in provider from the resolved application environment. */
export function createArkResponsesSupervisorProvider(
  config: ArkResponsesSupervisorConfig,
): ArkResponsesSupervisorProvider {
  return new ArkResponsesSupervisorProvider({
    apiKey: config.arkApiKey,
    baseUrl: config.arkBaseUrl,
    model: config.supervisorModel,
    timeoutMs: config.supervisorTimeoutMs,
  });
}
