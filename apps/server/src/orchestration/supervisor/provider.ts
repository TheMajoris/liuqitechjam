import { redactSensitiveText } from "../handoff.js";
import type { AppConfig } from "../../config.js";
import { SupervisorError, createAbortError, isAbortError } from "./errors.js";
import { buildSupervisorPrompt } from "./context.js";
import { parseSupervisorRoutingText } from "./schemas.js";
import {
  DEFAULT_SUPERVISOR_MAX_HTTP_CALLS,
  createSupervisorRequestBudget,
} from "./types.js";
import type {
  SupervisorProvider,
  SupervisorProviderOptions,
  SupervisorRoutingDecision,
  SupervisorRequestBudget,
  SupervisorSelectionContext,
} from "./types.js";

export const DEFAULT_SUPERVISOR_TIMEOUT_MS = 120_000;
export const DEFAULT_SUPERVISOR_MAX_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_SUPERVISOR_MAX_ERROR_BODY_BYTES = 8 * 1024;
export const DEFAULT_SUPERVISOR_MAX_ERROR_MESSAGE_CHARS = 2_000;
export const DEFAULT_SUPERVISOR_MAX_TRANSPORT_ATTEMPTS = 3;
export const SUPERVISOR_RETRY_BACKOFF_BASE_MS = 500;
export const SUPERVISOR_RETRY_BACKOFF_CAP_MS = 4_000;

const HARD_QUOTA_ERROR_CODES = new Set([
  "set_limit_exceeded",
  "setlimitexceeded",
  "inference_limit",
  "inference_limit_exceeded",
  "model_inference_limit_exceeded",
  "insufficient_quota",
  "quota_exceeded",
  "quota_depleted",
  "quota_exhausted",
]);

/** Provider error classes that cannot become transient by repeating a request. */
const PERMANENT_ERROR_CODES = new Set([
  ...HARD_QUOTA_ERROR_CODES,
  "authentication_error",
  "authentication_failed",
  "authorization_error",
  "authorization_failed",
  "invalid_api_key",
  "invalid_token",
  "unauthorized",
  "forbidden",
  "permission_denied",
  "access_denied",
  "invalid_model",
  "model_not_found",
  "model_not_available",
  "model_unavailable",
  "model_not_supported",
  "model_not_exist",
  "resource_not_found_error",
  "invalid_request",
  "invalid_request_error",
  "bad_request",
  "configuration_error",
  "invalid_configuration",
  "invalid_config",
  "config_error",
  "invalid_endpoint",
  "endpoint_not_found",
  "context_length_exceeded",
  "context_limit_exceeded",
  "context_window_exceeded",
  "input_too_long",
]);

const PERMANENT_ERROR_TEXT = [
  /\b(?:unauthorized|forbidden)\b/i,
  /\b(?:authentication|authorization)\s+(?:failed|error|denied|required)\b/i,
  /\b(?:permission|access)\s+denied\b/i,
  /\binvalid[\s_-]+(?:api[\s_-]+key|token|model|request|configuration|config|endpoint)\b/i,
  /\bmodel[\s_-]+(?:not[\s_-]+(?:found|available|supported)|unavailable|does\s+not\s+exist)\b/i,
  /\b(?:configuration|config)[\s_-]+(?:error|invalid|failed)\b/i,
  /\b(?:context|input)[\s_-]+(?:length|window)[\s_-]+(?:exceeded|too\s+long)\b/i,
];

export type SupervisorClock = () => number;
export type SupervisorRandom = () => number;
export type SupervisorSleep = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;

export interface ArkResponsesSupervisorProviderOptions {
  apiKey: string;
  baseUrl: string;
  /** Optional legacy/default model; new sessions supply one per Agent. */
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: SupervisorClock;
  random?: SupervisorRandom;
  sleep?: SupervisorSleep;
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

function requestBudgetLimit(budget: SupervisorRequestBudget): number {
  const configured = budget.maxCalls;
  return configured !== undefined && Number.isInteger(configured) && configured > 0
    ? Math.min(configured, DEFAULT_SUPERVISOR_MAX_HTTP_CALLS)
    : DEFAULT_SUPERVISOR_MAX_HTTP_CALLS;
}

function retryableHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function normalizeProviderErrorCode(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * Inspect only the provider's structured error fields. A bounded nested JSON
 * string is accepted because Ark may wrap its error payload more than once;
 * arbitrary response prose is not treated as a provider code.
 */
function hasProviderErrorCode(
  value: unknown,
  codes: ReadonlySet<string>,
  depth = 0,
): boolean {
  if (depth > 3) return false;
  if (typeof value === "string") {
    if (codes.has(normalizeProviderErrorCode(value))) return true;
    if (Buffer.byteLength(value, "utf8") > DEFAULT_SUPERVISOR_MAX_ERROR_BODY_BYTES) {
      return false;
    }
    try {
      return hasProviderErrorCode(JSON.parse(value) as unknown, codes, depth + 1);
    } catch {
      return false;
    }
  }
  const record = asRecord(value);
  if (!record) return false;
  for (const key of ["code", "type", "error_code", "errorCode"]) {
    const candidate = record[key];
    if (
      typeof candidate === "string" &&
      codes.has(normalizeProviderErrorCode(candidate))
    ) {
      return true;
    }
  }
  return [record.error, record.details, record.message].some((nested) =>
    hasProviderErrorCode(nested, codes, depth + 1),
  );
}

function parseProviderErrorBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function hasKnownHardQuota(body: string): boolean {
  if (hasProviderErrorCode(parseProviderErrorBody(body), HARD_QUOTA_ERROR_CODES)) {
    return true;
  }
  return /(?:SetLimitExceeded|set[\s_-]*limit[\s_-]*exceeded|inference[\s_-]*limit(?:[\s_-]*(?:exceeded|reached))?|insufficient[\s_-]*quota|quota[\s_-]*(?:exceeded|depleted|exhausted)|out[\s_-]+of[\s_-]+(?:credits|quota)|billing|payment[\s_-]+required)/i.test(
    body,
  );
}

function hasKnownPermanentProviderFailure(status: number, body: string): boolean {
  const evidence = parseProviderErrorBody(body);
  if (hasProviderErrorCode(evidence, PERMANENT_ERROR_CODES)) return true;
  if (hasKnownHardQuota(body)) return true;
  return retryableHttpStatus(status) && PERMANENT_ERROR_TEXT.some((pattern) => pattern.test(body));
}

function retryAfterMs(response: Response, nowMs: number): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, Number.MAX_SAFE_INTEGER);
  }
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

function fullJitterDelayMs(attempt: number, random: number): number {
  const cap = Math.min(
    SUPERVISOR_RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
    SUPERVISOR_RETRY_BACKOFF_CAP_MS,
  );
  const sample = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  return Math.floor(sample * cap);
}

function isRetryableNetworkError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const record =
    typeof error === "object" && error !== null
      ? (error as {
          code?: unknown;
          name?: unknown;
          message?: unknown;
          cause?: unknown;
        })
      : undefined;
  const candidates = [record, record?.cause];
  return candidates.some((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const details = candidate as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
    };
    const code = typeof details.code === "string" ? details.code : "";
    const name = typeof details.name === "string" ? details.name : "";
    const message =
      typeof details.message === "string" ? details.message : String(candidate);
    return (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      code === "UND_ERR_SOCKET" ||
      name === "TimeoutError" ||
      /(?:connection reset|socket hang up|network timeout|connect timeout|ECONNRESET|ETIMEDOUT)/i.test(
        message,
      )
    );
  });
}

function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal.aborted) return Promise.reject(createAbortError());
    return Promise.resolve();
  }
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function budgetExhaustedError(): SupervisorError {
  return new SupervisorError(
    "SUPERVISOR_REQUEST_FAILED",
    "Supervisor request call budget was exhausted",
  );
}

function httpFailure(
  response: Response,
  body: BoundedBody,
): SupervisorError {
  const suffix = body.text.trim()
    ? ": " + boundedSafeText(body.text, DEFAULT_SUPERVISOR_MAX_ERROR_MESSAGE_CHARS - 400)
    : "";
  return new SupervisorError(
    "SUPERVISOR_REQUEST_FAILED",
    "Supervisor request failed with HTTP " + String(response.status) + suffix,
  );
}

/**
 * Bounded Ark Responses API adapter. It requests a JSON-only route, sends no
 * tools/reasoning configuration, and never stores raw provider text.
 */
export class ArkResponsesSupervisorProvider implements SupervisorProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: SupervisorClock;
  private readonly random: SupervisorRandom;
  private readonly sleep: SupervisorSleep;
  private readonly maxResponseBytes: number;
  private readonly maxErrorBodyBytes: number;

  constructor(options: ArkResponsesSupervisorProviderOptions) {
    const apiKey = options.apiKey.trim();
    const model = options.model?.trim() ?? "";
    if (!apiKey || apiKey.startsWith("replace-")) {
      throw new SupervisorError(
        "SUPERVISOR_NOT_CONFIGURED",
        "Supervisor requires ARK_API_KEY",
      );
    }
    // The session supplies its resolved supervisor model per call. Keep accepting
    // a configured default for legacy callers, but do not require a global
    // model merely to construct the provider.
    const timeoutMs = positiveLimit(
      options.timeoutMs,
      DEFAULT_SUPERVISOR_TIMEOUT_MS,
    );
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? sleepWithAbort;
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
    const model = options.model?.trim() || this.model;
    if (!model || model.includes("replace-")) {
      throw new SupervisorError(
        "SUPERVISOR_NOT_CONFIGURED",
        "Supervisor requires an Agent model assignment",
      );
    }
    const timeoutMs = positiveLimit(options.timeoutMs, this.timeoutMs);
    const requestBudget =
      options.requestBudget ??
      createSupervisorRequestBudget(this.now() + timeoutMs);
    if (!Number.isFinite(requestBudget.deadlineAt)) {
      throw new SupervisorError(
        "SUPERVISOR_REQUEST_FAILED",
        "Supervisor request deadline is invalid",
      );
    }
    const maxCalls = requestBudgetLimit(requestBudget);
    const initialRemainingMs = requestBudget.deadlineAt - this.now();
    if (initialRemainingMs <= 0) throw timeoutError(timeoutMs);

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(Math.max(0, initialRemainingMs), 2_147_483_647));
    timeout.unref?.();

    let attempts = 0;
    let lastRetryableError: SupervisorError | undefined;
    try {
      const request = {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: buildSupervisorPrompt(context),
          store: false,
          // Routing needs only the declared JSON decision. Do not request or
          // retain a private reasoning trace from the provider.
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      } satisfies RequestInit;

      while (attempts < DEFAULT_SUPERVISOR_MAX_TRANSPORT_ATTEMPTS) {
        if (options.signal?.aborted) throw createAbortError();
        if (timedOut || this.now() >= requestBudget.deadlineAt) {
          throw timeoutError(timeoutMs);
        }
        if (requestBudget.calls >= maxCalls) {
          throw lastRetryableError ?? budgetExhaustedError();
        }

        requestBudget.calls += 1;
        attempts += 1;
        try {
          const response = await this.fetchImpl(
            this.baseUrl + "/responses",
            request,
          );
          if (options.signal?.aborted) throw createAbortError();
          if (timedOut || this.now() >= requestBudget.deadlineAt) {
            throw timeoutError(timeoutMs);
          }
          const body = await readBoundedBody(
            response,
            response.ok ? this.maxResponseBytes : this.maxErrorBodyBytes,
          );
          if (options.signal?.aborted) throw createAbortError();
          if (timedOut || this.now() >= requestBudget.deadlineAt) {
            throw timeoutError(timeoutMs);
          }
          if (!response.ok) {
            const failure = httpFailure(response, body);
            if (
              !retryableHttpStatus(response.status) ||
              hasKnownPermanentProviderFailure(response.status, body.text) ||
              attempts >= DEFAULT_SUPERVISOR_MAX_TRANSPORT_ATTEMPTS
            ) {
              throw failure;
            }
            lastRetryableError = failure;
            if (requestBudget.calls >= maxCalls) throw failure;
            const delayMs = Math.max(
              fullJitterDelayMs(attempts, this.random()),
              retryAfterMs(response, this.now()) ?? 0,
            );
            const remainingMs = requestBudget.deadlineAt - this.now();
            if (remainingMs <= 0 || delayMs >= remainingMs) throw failure;
            await this.sleep(delayMs, controller.signal);
            continue;
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
          if (timedOut || this.now() >= requestBudget.deadlineAt) {
            throw timeoutError(timeoutMs);
          }
          if (isAbortError(error)) throw error;
          if (error instanceof SupervisorError) throw error;
          if (
            !isRetryableNetworkError(error) ||
            attempts >= DEFAULT_SUPERVISOR_MAX_TRANSPORT_ATTEMPTS
          ) {
            throw new SupervisorError(
              "SUPERVISOR_REQUEST_FAILED",
              "Supervisor request failed: " + boundedSafeText(error, 1_600),
              { cause: error },
            );
          }
          const failure = new SupervisorError(
            "SUPERVISOR_REQUEST_FAILED",
            "Supervisor request failed: " + boundedSafeText(error, 1_600),
            { cause: error },
          );
          lastRetryableError = failure;
          if (requestBudget.calls >= maxCalls) throw failure;
          const delayMs = fullJitterDelayMs(attempts, this.random());
          const remainingMs = requestBudget.deadlineAt - this.now();
          if (remainingMs <= 0 || delayMs >= remainingMs) throw failure;
          await this.sleep(delayMs, controller.signal);
        }
      }
      throw lastRetryableError ?? budgetExhaustedError();
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
