import { ModelCatalogError } from "./errors.js";
import type {
  ModelDescriptor,
  ModelProviderAdapter,
  ModelScope,
  ProviderDescriptor,
} from "./types.js";

export const ARK_WORKER_PROVIDER_ID = "volcengine_ark" as const;
export const ARK_WORKER_PROVIDER_LABEL = "BytePlus ModelArk";
export const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;
export const DEFAULT_MODEL_LIST_MAX_RESPONSE_BYTES = 256 * 1024;

export interface ArkModelProviderOptions {
  apiKey: string;
  baseUrl: string;
  curatedModelIds: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

interface BoundedBody {
  text: string;
  truncated: boolean;
}

interface ModelListItem {
  id?: unknown;
}

function safeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) return null;
  return id;
}

function safeLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/u, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ModelCatalogError(
      "MODEL_RUNTIME_CONFIGURATION_INVALID",
      503,
      "The worker provider base URL is invalid",
    );
  }
  return baseUrl;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length <= maxBytes) return { text, truncated: false };
    return { text: text.slice(0, maxBytes), truncated: true };
  }

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

function parseModelIds(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The worker provider returned an invalid model list",
    );
  }

  const record =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  const candidates = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(parsed)
        ? parsed
        : null;
  if (!candidates) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The worker provider returned an invalid model list",
    );
  }

  const ids = new Set<string>();
  for (const candidate of candidates) {
    const value =
      typeof candidate === "string"
        ? candidate
        : typeof candidate === "object" && candidate !== null
          ? (candidate as ModelListItem).id
          : null;
    const id = safeModelId(value);
    if (id) ids.add(id);
  }
  return [...ids];
}

function descriptor(id: string, scope: ModelScope): ModelDescriptor {
  return {
    id,
    label: id,
    providerId: ARK_WORKER_PROVIDER_ID,
    capabilities: {
      scopes: [scope],
      reasoning: false,
    },
  };
}

/**
 * Ark's OpenAI-compatible `/models` response is treated as discovery input,
 * never as proof that a model is executable. The registry applies the
 * authoritative WorkerModelResolver after this adapter returns.
 */
export class ArkModelProvider implements ModelProviderAdapter {
  readonly id = ARK_WORKER_PROVIDER_ID;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly curatedModelIds: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ArkModelProviderOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.curatedModelIds = Array.from(
      new Set(options.curatedModelIds.map((value) => safeModelId(value)).filter(
        (value): value is string => value !== null,
      )),
    );
    this.timeoutMs = safeLimit(options.timeoutMs, DEFAULT_MODEL_LIST_TIMEOUT_MS);
    this.maxResponseBytes = safeLimit(
      options.maxResponseBytes,
      DEFAULT_MODEL_LIST_MAX_RESPONSE_BYTES,
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        503,
        "Worker model discovery is unavailable",
      );
    }
  }

  describe(): ProviderDescriptor {
    return {
      id: this.id,
      label: ARK_WORKER_PROVIDER_LABEL,
      capabilities: {
        worker: true,
        supervisor: true,
        dynamicModelListing: true,
      },
    };
  }

  async listModels(input: { scope: ModelScope }): Promise<ModelDescriptor[]> {
    const curated = this.curatedModelIds.map((id) => descriptor(id, input.scope));
    // Without credentials, the safe server-owned catalog is still useful for
    // rendering/configuring an Agent; no provider request is attempted.
    if (!this.apiKey) return curated;

    let discovered: string[];
    try {
      discovered = await this.discoverModelIds();
    } catch (error) {
      // A configured allowlist is an intentional safe fallback. The registry
      // may additionally serve a stale cached dynamic list.
      if (curated.length > 0) return curated;
      throw error;
    }

    const allowed = new Set(this.curatedModelIds);
    // The configured default/allowlist is the runtime proof. Provider output
    // is intersected with it, and curated entries remain visible if discovery
    // omits an endpoint that is known to be configured and executable.
    const filtered = discovered.filter((id) => allowed.has(id));
    const ids = new Set([...filtered, ...this.curatedModelIds]);
    return [...ids].map((id) => descriptor(id, input.scope));
  }

  private async discoverModelIds(): Promise<string[]> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timeout.unref?.();

    try {
      const response = await this.fetchImpl(this.baseUrl + "/models", {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + this.apiKey,
        },
        signal: controller.signal,
      });
      if (timedOut) {
        throw new ModelCatalogError(
          "MODEL_PROVIDER_UNAVAILABLE",
          503,
          "Worker provider model discovery timed out",
        );
      }
      const body = await readBoundedBody(response, this.maxResponseBytes);
      if (!response.ok) {
        throw new ModelCatalogError(
          "MODEL_PROVIDER_UNAVAILABLE",
          503,
          "Worker provider model discovery is unavailable",
        );
      }
      if (body.truncated) {
        throw new ModelCatalogError(
          "MODEL_LIST_FAILED",
          502,
          "The worker provider model list exceeded the response limit",
        );
      }
      return parseModelIds(body.text);
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error;
      if (timedOut) {
        throw new ModelCatalogError(
          "MODEL_PROVIDER_UNAVAILABLE",
          503,
          "Worker provider model discovery timed out",
        );
      }
      throw new ModelCatalogError(
        "MODEL_PROVIDER_UNAVAILABLE",
        503,
        "Worker provider model discovery is unavailable",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
