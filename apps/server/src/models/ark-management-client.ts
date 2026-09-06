import { createHash, createHmac } from "node:crypto";
import { ModelCatalogError } from "./errors.js";

export const ARK_MANAGEMENT_API_VERSION = "2024-01-01" as const;
export const ARK_MANAGEMENT_SERVICE = "ark" as const;
export const DEFAULT_ARK_MANAGEMENT_BASE_URL =
  "https://ark.ap-southeast-1.byteplusapi.com" as const;
export const DEFAULT_ARK_MANAGEMENT_REGION = "ap-southeast-1" as const;
export const DEFAULT_ARK_MANAGEMENT_TIMEOUT_MS = 10_000;
export const DEFAULT_ARK_MANAGEMENT_MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_ENDPOINT_PAGES = 16;
export const MAX_ENDPOINTS = 1_600;
export const MAX_MODEL_ACTIVATION_PAGES = 16;
export const MAX_MODEL_ACTIVATIONS = 1_600;
export const MAX_USAGE_DATA_COUNT = 1_000_000;
export const MAX_USAGE_ROWS = 10_000;
export const MAX_USAGE_COUNTER = 1_000_000_000_000_000;
export const MAX_FREE_RESOURCE_PACKS = 100;

const FREE_INFERENCE_PACK_TYPE = "FreeInference";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export type ArkUsageQueryInterval = "Hour" | "Day";

export interface ArkInferenceUsageCounters {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requests: number | null;
}

export interface ArkInferenceUsageRow extends ArkInferenceUsageCounters {
  modelEndpoint: string | null;
}

export interface ArkEndpointRecord {
  id: string;
  name: string | null;
  foundationModel: {
    name: string;
    version: string;
  } | null;
  status: string;
  statusReason: string | null;
  modelUnitId: string | null;
  rateLimit: {
    rpm: number | null;
    tpm: number | null;
  };
  updateTime: string | null;
  observedAt: string;
}

export interface ArkModelActivationRecord {
  foundationModelName: string;
  state: string;
  initialInferenceFreeUsage: {
    total: number | null;
    consumed: number | null;
  } | null;
  /**
   * Live free-inference pack counters, summed over FreeResourcePackItems.
   * ModelArk populates InitialInferenceFreeUsage only while a model is still
   * unactivated, so this is the quota source for models serving traffic.
   */
  freeInferenceUsage: {
    total: number;
    consumed: number;
  } | null;
  observedAt: string;
}

export interface ArkInferenceUsageRecord {
  dataCount: number;
  availability: "available" | "partial";
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requests: number | null;
  rows: ArkInferenceUsageRow[];
  modelEndpoint: string | null;
  modelEndpoints: string[];
  queryInterval: ArkUsageQueryInterval;
  startTime: string;
  endTime: string;
  showWindowDetail: boolean;
  observedAt: string;
}

export interface ArkManagementClientOptions {
  accessKey: string;
  secretKey: string;
  region?: string;
  baseUrl?: string;
  service?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface BoundedBody {
  text: string;
  truncated: boolean;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface EndpointPage {
  totalCount: number;
  pageNumber: number;
  pageSize: number;
  items: ArkEndpointRecord[];
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || CONTROL_CHARACTER.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function optionalText(value: unknown, maxLength: number, field = "field"): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = boundedText(value, maxLength);
  if (normalized === null) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk endpoint " + field + " is invalid",
    );
  }
  return normalized;
}

function boundedInteger(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function requireRecord(value: unknown, message: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelCatalogError("MODEL_LIST_FAILED", 502, message);
  }
  return value as JsonRecord;
}

function requireBodyString(value: unknown, field: string, maxLength: number): string {
  const result = boundedText(value, maxLength);
  if (result === null) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk management response contains an invalid " + field,
    );
  }
  return result;
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/u, "");
  try {
    const parsed = new URL(baseUrl);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("unsupported management URL");
    }
  } catch {
    throw new ModelCatalogError(
      "MODEL_RUNTIME_CONFIGURATION_INVALID",
      503,
      "The BytePlus management base URL is invalid",
    );
  }
  return baseUrl;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacSha256(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacSha256Hex(key: Uint8Array | string, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/[ \t]+/gu, " ");
}

function requestTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new ModelCatalogError(
      "MODEL_RUNTIME_CONFIGURATION_INVALID",
      503,
      "The server clock is invalid for BytePlus management signing",
    );
  }
  const iso = value.toISOString();
  return iso.slice(0, 10).replaceAll("-", "") +
    "T" +
    iso.slice(11, 19).replaceAll(":", "") +
    "Z";
}

function canonicalPath(url: URL): string {
  return url.pathname || "/";
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
    .join("&");
}

function buildAuthorization(
  accessKey: string,
  secretKey: string,
  region: string,
  service: string,
  timestamp: string,
  url: URL,
  payloadHash: string,
): string {
  const shortDate = timestamp.slice(0, 8);
  const signedHeaders = ["host", "x-content-sha256", "x-date"];
  const headers: Record<string, string> = {
    host: url.host,
    "x-content-sha256": payloadHash,
    "x-date": timestamp,
  };
  const canonicalHeaders = signedHeaders
    .map((name) => name + ":" + canonicalHeaderValue(headers[name] ?? "") + "\n")
    .join("");
  const canonicalRequest = [
    "POST",
    canonicalPath(url),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const credentialScope = shortDate + "/" + region + "/" + service + "/request";
  const stringToSign = [
    "HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmacSha256(secretKey, shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "request");
  const signature = hmacSha256Hex(kSigning, stringToSign);
  return (
    "HMAC-SHA256 Credential=" +
    accessKey +
    "/" +
    credentialScope +
    ", SignedHeaders=" +
    signedHeaders.join(";") +
    ", Signature=" +
    signature
  );
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > maxBytes
      ? { text: text.slice(0, maxBytes), truncated: true }
      : { text, truncated: false };
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

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk management response is not valid JSON",
    );
  }
}

function parseMetadata(root: JsonRecord, action: string): JsonRecord {
  const metadata = requireRecord(
    root.ResponseMetadata,
    "The ModelArk management response is missing response metadata",
  );
  if (metadata.Action !== action || metadata.Version !== ARK_MANAGEMENT_API_VERSION) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk management response does not match the requested action",
    );
  }
  return requireRecord(root.Result, "The ModelArk management response is missing its result");
}

function parseRateLimit(value: unknown): { rpm: number | null; tpm: number | null } {
  if (value === undefined || value === null) return { rpm: null, tpm: null };
  const record = requireRecord(value, "The ModelArk endpoint rate limit is invalid");
  // ModelArk uses -1 when an endpoint-specific override is unset. Preserve
  // that as unknown/inherited instead of presenting it as a real limit.
  const rate = (candidate: unknown, max: number): number | null =>
    candidate === -1 ? null : boundedInteger(candidate, max);
  const rpm = rate(record.Rpm, 10_000_000);
  const tpm = rate(record.Tpm, 10_000_000_000);
  if (
    (record.Rpm !== undefined && record.Rpm !== -1 && rpm === null) ||
    (record.Tpm !== undefined && record.Tpm !== -1 && tpm === null)
  ) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk endpoint rate limit is invalid",
    );
  }
  return { rpm, tpm };
}

function parseEndpoint(value: unknown, observedAt: string): ArkEndpointRecord {
  const record = requireRecord(value, "The ModelArk endpoint record is invalid");
  const id = requireBodyString(record.Id, "endpoint ID", 256);
  const status = requireBodyString(record.Status, "endpoint status", 64).toLowerCase();
  let foundationModel: ArkEndpointRecord["foundationModel"] = null;
  if (record.ModelReference !== undefined && record.ModelReference !== null) {
    const reference = requireRecord(
      record.ModelReference,
      "The ModelArk endpoint model reference is invalid",
    );
    if (reference.FoundationModel !== undefined && reference.FoundationModel !== null) {
      const model = requireRecord(
        reference.FoundationModel,
        "The ModelArk endpoint foundation model is invalid",
      );
      foundationModel = {
        name: requireBodyString(model.Name, "foundation model name", 256),
        version: requireBodyString(model.ModelVersion, "foundation model version", 128),
      };
    }
  }
  return {
    id,
    name: optionalText(record.Name, 256, "name"),
    foundationModel,
    status,
    statusReason: optionalText(record.StatusReason, 2_000, "status reason"),
    modelUnitId: optionalText(record.ModelUnitId, 256, "model unit ID"),
    rateLimit: parseRateLimit(record.RateLimit),
    updateTime: optionalText(record.UpdateTime, 128, "update time"),
    observedAt,
  };
}

function parseEndpointPage(body: string, page: number, observedAt: string): EndpointPage {
  const root = requireRecord(parseJsonBody(body), "The ModelArk management response is invalid");
  const result = parseMetadata(root, "ListEndpoints");
  const totalCount = boundedInteger(result.TotalCount, MAX_ENDPOINTS);
  const pageNumber = boundedInteger(result.PageNumber, MAX_ENDPOINT_PAGES);
  const pageSize = boundedInteger(result.PageSize, 100);
  if (
    totalCount === null ||
    pageNumber === null ||
    pageSize === null ||
    pageSize < 1 ||
    pageNumber !== page
  ) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk endpoint pagination metadata is invalid",
    );
  }
  if (!Array.isArray(result.Items) || result.Items.length > pageSize || result.Items.length > 100) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk endpoint list is invalid",
    );
  }
  return {
    totalCount,
    pageNumber,
    pageSize,
    items: result.Items.map((item) => parseEndpoint(item, observedAt)),
  };
}

interface ModelActivationPage {
  totalCount: number;
  pageNumber: number;
  pageSize: number;
  items: ArkModelActivationRecord[];
}

function parseInitialInferenceFreeUsage(
  value: unknown,
): ArkModelActivationRecord["initialInferenceFreeUsage"] {
  if (value === undefined || value === null) return null;
  const record = requireRecord(
    value,
    "The ModelArk model activation free usage is invalid",
  );
  return {
    total: parseUsageCounter(record.Total, "InitialInferenceFreeUsage.Total"),
    consumed: parseUsageCounter(record.Consumed, "InitialInferenceFreeUsage.Consumed"),
  };
}

/**
 * Sum the account's free inference packs for one foundation model.
 *
 * Only FreeInference packs are counted; image or video packs use the same
 * envelope with unrelated units. A pack missing either counter is skipped
 * rather than treated as zero, so a partial provider record cannot present
 * itself as an exhausted quota.
 */
function parseFreeInferenceUsage(
  value: unknown,
): ArkModelActivationRecord["freeInferenceUsage"] {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_FREE_RESOURCE_PACKS) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk free resource pack list is invalid",
    );
  }
  let total = 0;
  let consumed = 0;
  let found = false;
  for (const item of value) {
    const record = requireRecord(item, "The ModelArk free resource pack is invalid");
    if (record.Type !== FREE_INFERENCE_PACK_TYPE) continue;
    const packTotal = parseUsageCounter(record.Total, "FreeResourcePackItems.Total");
    const packConsumed = parseUsageCounter(record.Consumed, "FreeResourcePackItems.Consumed");
    if (packTotal === null || packConsumed === null) continue;
    total += packTotal;
    consumed += packConsumed;
    found = true;
  }
  return found ? { total, consumed } : null;
}

function parseModelActivation(value: unknown, observedAt: string): ArkModelActivationRecord {
  const record = requireRecord(value, "The ModelArk model activation record is invalid");
  return {
    foundationModelName: requireBodyString(
      record.FoundationModelName,
      "foundation model name",
      256,
    ),
    state: requireBodyString(record.State, "model activation state", 64),
    initialInferenceFreeUsage: parseInitialInferenceFreeUsage(
      record.InitialInferenceFreeUsage,
    ),
    freeInferenceUsage: parseFreeInferenceUsage(record.FreeResourcePackItems),
    observedAt,
  };
}

function parseModelActivationPage(
  body: string,
  page: number,
  observedAt: string,
): ModelActivationPage {
  const root = requireRecord(
    parseJsonBody(body),
    "The ModelArk model activation response is invalid",
  );
  const result = parseMetadata(root, "ListModelActivations");
  const totalCount = boundedInteger(result.TotalCount, MAX_MODEL_ACTIVATIONS);
  const pageNumber = boundedInteger(result.PageNumber, MAX_MODEL_ACTIVATION_PAGES);
  const pageSize = boundedInteger(result.PageSize, 100);
  if (
    totalCount === null ||
    pageNumber === null ||
    pageSize === null ||
    pageSize < 1 ||
    pageNumber !== page
  ) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk model activation pagination metadata is invalid",
    );
  }
  if (
    !Array.isArray(result.Items) ||
    result.Items.length > pageSize ||
    result.Items.length > 100
  ) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk model activation list is invalid",
    );
  }
  return {
    totalCount,
    pageNumber,
    pageSize,
    items: result.Items.map((item) => parseModelActivation(item, observedAt)),
  };
}

function parseUsageCounter(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  let normalized: number;
  if (typeof value === "number") {
    normalized = value;
  } else if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    normalized = Number(value.trim());
  } else {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk usage field " + field + " is invalid",
    );
  }
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > MAX_USAGE_COUNTER
  ) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk usage field " + field + " is invalid",
    );
  }
  return normalized;
}

function usageRowValue(record: JsonRecord, field: string): unknown {
  const direct = record[field];
  if (direct !== undefined) return direct;
  // Typed Fields responses have been observed with the same names but
  // different casing in Data objects. Keep the normalized contract stable
  // while accepting that provider representation.
  const matched = Object.entries(record).find(
    ([key]) => key.toLowerCase() === field.toLowerCase(),
  );
  return matched?.[1];
}

function parseUsageRow(
  value: unknown,
  fields: readonly string[] | undefined,
): ArkInferenceUsageRow {
  let record: JsonRecord;
  const typedRow = Array.isArray(value)
    ? undefined
    : requireRecord(value, "The ModelArk usage row is invalid");
  const rowValues = Array.isArray(value)
    ? value
    : Array.isArray(typedRow?.Values)
      ? typedRow.Values
      : Array.isArray(typedRow?.values)
        ? typedRow.values
        : null;
  if (rowValues !== null) {
    if (fields === undefined || rowValues.length > fields.length) {
      throw new ModelCatalogError(
        "MODEL_LIST_FAILED",
        502,
        "The ModelArk usage row does not match its fields",
      );
    }
    record = {};
    rowValues.forEach((entry, index) => {
      const field = fields[index];
      if (field !== undefined) record[field] = entry;
    });
  } else {
    record = typedRow!;
  }

  const endpointValue = usageRowValue(record, "ModelEndpoint");
  let modelEndpoint: string | null = null;
  if (endpointValue !== undefined && endpointValue !== null && endpointValue !== "") {
    modelEndpoint = boundedText(endpointValue, 256);
    if (modelEndpoint === null) {
      throw new ModelCatalogError(
        "MODEL_LIST_FAILED",
        502,
        "The ModelArk usage ModelEndpoint is invalid",
      );
    }
  }
  return {
    modelEndpoint,
    inputTokens: parseUsageCounter(usageRowValue(record, "InputTokens"), "InputTokens"),
    cachedInputTokens: parseUsageCounter(
      usageRowValue(record, "CacheTokensHit"),
      "CacheTokensHit",
    ),
    outputTokens: parseUsageCounter(usageRowValue(record, "OutputTokens"), "OutputTokens"),
    totalTokens: parseUsageCounter(usageRowValue(record, "TotalTokens"), "TotalTokens"),
    requests: parseUsageCounter(usageRowValue(record, "ReqCnt"), "ReqCnt"),
  };
}

function parseUsageFields(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const descriptors = Array.isArray(value)
    ? value
    : Object.keys(requireRecord(value, "The ModelArk usage fields are invalid"));
  if (descriptors.length > 64) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk usage fields are invalid",
    );
  }
  const fields = descriptors.map((field) => {
    const candidate = typeof field === "string"
      ? field
      : (() => {
          const descriptor = requireRecord(
            field,
            "The ModelArk usage field descriptor is invalid",
          );
          return descriptor.Name ?? descriptor.FieldName ?? descriptor.name ?? descriptor.fieldName;
        })();
    const normalized = boundedText(candidate, 128);
    if (normalized === null) {
      throw new ModelCatalogError(
        "MODEL_LIST_FAILED",
        502,
        "The ModelArk usage fields are invalid",
      );
    }
    return normalized;
  });
  if (new Set(fields).size !== fields.length) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk usage fields contain duplicates",
    );
  }
  return fields;
}

function sumUsageField(
  rows: readonly ArkInferenceUsageRow[],
  field: keyof ArkInferenceUsageCounters,
): number | null {
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = row[field];
    if (value === null) continue;
    if (total > MAX_USAGE_COUNTER - value) {
      throw new ModelCatalogError(
        "MODEL_LIST_FAILED",
        502,
        "The ModelArk usage counters exceeded the server limit",
      );
    }
    total += value;
    found = true;
  }
  return found ? total : null;
}

function parseUsageResponse(
  body: string,
  query: ArkInferenceUsageQuery,
  observedAt: string,
): ArkInferenceUsageRecord {
  const root = requireRecord(parseJsonBody(body), "The ModelArk usage response is invalid");
  const result = parseMetadata(root, "GetInferenceUsage");
  const parsedDataCount = parseUsageCounter(result.DataCount, "DataCount");
  if (parsedDataCount === null || parsedDataCount > MAX_USAGE_DATA_COUNT) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk usage response is missing a valid data count",
    );
  }
  const dataCount = parsedDataCount;
  const fields = parseUsageFields(result.Fields);
  const data = result.Data;
  if (data !== undefined && !Array.isArray(data)) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk usage data is invalid",
    );
  }
  if (Array.isArray(data) && data.length > MAX_USAGE_ROWS) {
    throw new ModelCatalogError(
      "MODEL_LIST_FAILED",
      502,
      "The ModelArk usage data exceeded the server limit",
    );
  }
  const rows = (Array.isArray(data) ? data : []).map((row) =>
    parseUsageRow(row, fields),
  );
  const availability =
    rows.length === 0 && dataCount > 0 ||
    rows.some((row) =>
      row.inputTokens === null ||
      row.cachedInputTokens === null ||
      row.outputTokens === null ||
      row.totalTokens === null ||
      row.requests === null,
    )
      ? "partial"
      : "available";
  const modelEndpoints = query.modelEndpoints ??
    (query.modelEndpoint === undefined ? [] : [query.modelEndpoint]);
  return {
    dataCount,
    availability,
    inputTokens: sumUsageField(rows, "inputTokens"),
    cachedInputTokens: sumUsageField(rows, "cachedInputTokens"),
    outputTokens: sumUsageField(rows, "outputTokens"),
    totalTokens: sumUsageField(rows, "totalTokens"),
    requests: sumUsageField(rows, "requests"),
    rows,
    modelEndpoint: modelEndpoints.length === 1 ? modelEndpoints[0]! : null,
    modelEndpoints: [...modelEndpoints],
    queryInterval: query.queryInterval ?? "Day",
    startTime: query.startTime,
    endTime: query.endTime,
    showWindowDetail: query.showWindowDetail ?? false,
    observedAt,
  };
}

function validateUsageDate(value: string, field: string): string {
  const normalized = value.trim();
  if (!DATE_PATTERN.test(normalized)) {
    throw new ModelCatalogError(
      "MODEL_RUNTIME_CONFIGURATION_INVALID",
      422,
      "The ModelArk usage " + field + " must use YYYY-MM-DD format",
    );
  }
  const parsed = new Date(normalized + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new ModelCatalogError(
      "MODEL_RUNTIME_CONFIGURATION_INVALID",
      422,
      "The ModelArk usage " + field + " is invalid",
    );
  }
  return normalized;
}

export interface ArkInferenceUsageQuery {
  queryInterval?: ArkUsageQueryInterval;
  startTime: string;
  endTime: string;
  showWindowDetail?: boolean;
  /** Optional endpoint filter accepted by the management API. */
  modelEndpoint?: string;
  /** Bulk endpoint filter; sent as Filters[{Key: ModelEndpoint, Values}]. */
  modelEndpoints?: readonly string[];
}

/**
 * Minimal BytePlus/Volcengine V4 management adapter. It signs only the
 * server-side management requests; inference API keys remain a separate
 * credential used by Codex workers.
 */
export class ArkManagementClient {
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly region: string;
  private readonly baseUrl: string;
  private readonly service: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: ArkManagementClientOptions) {
    this.accessKey = options.accessKey.trim();
    this.secretKey = options.secretKey.trim();
    this.region = boundedText(
      options.region ?? DEFAULT_ARK_MANAGEMENT_REGION,
      64,
    ) ?? DEFAULT_ARK_MANAGEMENT_REGION;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? DEFAULT_ARK_MANAGEMENT_BASE_URL,
    );
    this.service = boundedText(options.service ?? ARK_MANAGEMENT_SERVICE, 64) ??
      ARK_MANAGEMENT_SERVICE;
    this.timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_ARK_MANAGEMENT_TIMEOUT_MS);
    this.maxResponseBytes = positiveLimit(
      options.maxResponseBytes,
      DEFAULT_ARK_MANAGEMENT_MAX_RESPONSE_BYTES,
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    if (typeof this.fetchImpl !== "function") {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        503,
        "BytePlus management requests are unavailable",
      );
    }
  }

  isConfigured(): boolean {
    return (
      this.accessKey.length > 0 &&
      this.secretKey.length > 0 &&
      !this.accessKey.startsWith("replace-") &&
      !this.secretKey.startsWith("replace-")
    );
  }

  async listEndpoints(): Promise<ArkEndpointRecord[]> {
    if (!this.isConfigured()) {
      throw new ModelCatalogError(
        "MODEL_PROVIDER_UNAVAILABLE",
        503,
        "BytePlus management credentials are not configured",
      );
    }
    const endpoints: ArkEndpointRecord[] = [];
    const endpointIds = new Set<string>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= MAX_ENDPOINT_PAGES; page += 1) {
      const response = await this.request("ListEndpoints", {
        PageNumber: page,
        PageSize: 100,
      });
      const observedAt = this.now().toISOString();
      const parsed = parseEndpointPage(response, page, observedAt);
      expectedTotal ??= parsed.totalCount;
      if (parsed.totalCount !== expectedTotal) {
        throw new ModelCatalogError(
          "MODEL_LIST_FAILED",
          502,
          "The ModelArk endpoint pagination changed during discovery",
        );
      }
      for (const endpoint of parsed.items) {
        if (endpointIds.has(endpoint.id)) {
          throw new ModelCatalogError(
            "MODEL_LIST_FAILED",
            502,
            "The ModelArk endpoint list contains duplicate IDs",
          );
        }
        endpointIds.add(endpoint.id);
      }
      endpoints.push(...parsed.items);
      if (endpoints.length > MAX_ENDPOINTS) {
        throw new ModelCatalogError(
          "MODEL_LIST_FAILED",
          502,
          "The ModelArk endpoint list exceeded the server limit",
        );
      }
      if (endpoints.length >= parsed.totalCount) break;
      if (parsed.items.length === 0) {
        throw new ModelCatalogError(
          "MODEL_LIST_FAILED",
          502,
          "The ModelArk endpoint pagination ended before all endpoints were returned",
        );
      }
    }
    if (expectedTotal !== undefined && endpoints.length < expectedTotal) {
      throw new ModelCatalogError(
        "MODEL_LIST_FAILED",
        502,
        "The ModelArk endpoint list exceeded the pagination limit",
      );
    }
    return endpoints;
  }

  async listRunningEndpoints(): Promise<ArkEndpointRecord[]> {
    // The server-side filter is intentionally not relied on. ModelArk status
    // is external input; only an exact Running state reaches worker selectors.
    const endpoints = await this.listEndpoints();
    return endpoints.filter((endpoint) => endpoint.status === "running");
  }

  /**
   * Return model activation records with the account's live free-token
   * counters. The activation API is the quota authority; GetInferenceUsage
   * remains a consumed-usage telemetry source only.
   */
  async listModelActivations(): Promise<ArkModelActivationRecord[]> {
    if (!this.isConfigured()) {
      throw new ModelCatalogError(
        "MODEL_PROVIDER_UNAVAILABLE",
        503,
        "BytePlus management credentials are not configured",
      );
    }
    const activations: ArkModelActivationRecord[] = [];
    const foundationModelNames = new Set<string>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= MAX_MODEL_ACTIVATION_PAGES; page += 1) {
      const response = await this.request("ListModelActivations", {
        PageNumber: page,
        PageSize: 100,
        WithFreeUsage: true,
      });
      const observedAt = this.now().toISOString();
      const parsed = parseModelActivationPage(response, page, observedAt);
      expectedTotal ??= parsed.totalCount;
      if (parsed.totalCount !== expectedTotal) {
        throw new ModelCatalogError(
          "MODEL_LIST_FAILED",
          502,
          "The ModelArk model activation pagination changed during discovery",
        );
      }
      for (const activation of parsed.items) {
        if (foundationModelNames.has(activation.foundationModelName)) {
          throw new ModelCatalogError(
            "MODEL_LIST_FAILED",
            502,
            "The ModelArk model activation list contains duplicate foundation models",
          );
        }
        foundationModelNames.add(activation.foundationModelName);
      }
      activations.push(...parsed.items);
      if (activations.length > MAX_MODEL_ACTIVATIONS) {
        throw new ModelCatalogError(
          "MODEL_LIST_FAILED",
          502,
          "The ModelArk model activation list exceeded the server limit",
        );
      }
      if (activations.length >= parsed.totalCount) break;
      if (parsed.items.length === 0) {
        throw new ModelCatalogError(
          "MODEL_LIST_FAILED",
          502,
          "The ModelArk model activation list ended before all records were returned",
        );
      }
    }
    if (expectedTotal !== undefined && activations.length < expectedTotal) {
      throw new ModelCatalogError(
        "MODEL_LIST_FAILED",
        502,
        "The ModelArk model activation list exceeded the pagination limit",
      );
    }
    return activations;
  }

  async getInferenceUsage(input: ArkInferenceUsageQuery): Promise<ArkInferenceUsageRecord> {
    if (!this.isConfigured()) {
      throw new ModelCatalogError(
        "MODEL_PROVIDER_UNAVAILABLE",
        503,
        "BytePlus management credentials are not configured",
      );
    }
    const requestedEndpoints = input.modelEndpoints ??
      (input.modelEndpoint === undefined ? undefined : [input.modelEndpoint]);
    const modelEndpoints = requestedEndpoints === undefined
      ? undefined
      : requestedEndpoints.map((value) => boundedText(value, 256));
    if (
      modelEndpoints?.some((value) => value === null) ||
      (modelEndpoints !== undefined &&
        (modelEndpoints.length === 0 || modelEndpoints.length > MAX_ENDPOINTS))
    ) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "The ModelArk usage model endpoint filter is invalid",
      );
    }
    const normalizedModelEndpoints = modelEndpoints?.filter(
      (value): value is string => value !== null,
    );
    if (
      normalizedModelEndpoints !== undefined &&
      new Set(normalizedModelEndpoints).size !== normalizedModelEndpoints.length
    ) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "The ModelArk usage model endpoint filter contains duplicates",
      );
    }
    const query = {
      queryInterval: input.queryInterval ?? "Day",
      startTime: validateUsageDate(input.startTime, "startTime"),
      endTime: validateUsageDate(input.endTime, "endTime"),
      showWindowDetail: input.showWindowDetail ?? false,
      ...(normalizedModelEndpoints === undefined
        ? {}
        : { modelEndpoints: normalizedModelEndpoints }),
    };
    if (query.queryInterval !== "Day" && query.queryInterval !== "Hour") {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "The ModelArk usage query interval is invalid",
      );
    }
    if (query.startTime > query.endTime) {
      throw new ModelCatalogError(
        "MODEL_RUNTIME_CONFIGURATION_INVALID",
        422,
        "The ModelArk usage startTime must not be after endTime",
      );
    }
    const response = await this.request("GetInferenceUsage", {
      QueryInterval: query.queryInterval,
      StartTime: query.startTime,
      EndTime: query.endTime,
      ShowWindowDetail: query.showWindowDetail,
      ...(query.modelEndpoints === undefined
        ? {}
        : {
            Filters: [{
              Key: "ModelEndpoint",
              Values: query.modelEndpoints,
            }],
          }),
    });
    return parseUsageResponse(response, query, this.now().toISOString());
  }

  private async request(action: string, payload: Record<string, unknown>): Promise<string> {
    const url = new URL(this.baseUrl + "/");
    url.searchParams.set("Action", action);
    url.searchParams.set("Version", ARK_MANAGEMENT_API_VERSION);
    const body = JSON.stringify(payload);
    const payloadHash = sha256Hex(body);
    const timestamp = requestTimestamp(this.now());
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json; charset=UTF-8",
      Host: url.host,
      "X-Content-Sha256": payloadHash,
      "X-Date": timestamp,
      Authorization: buildAuthorization(
        this.accessKey,
        this.secretKey,
        this.region,
        this.service,
        timestamp,
        url,
        payloadHash,
      ),
    };
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      const bounded = await readBoundedBody(response, this.maxResponseBytes);
      if (timedOut) {
        throw new ModelCatalogError(
          "MODEL_PROVIDER_UNAVAILABLE",
          503,
          "BytePlus management request timed out",
        );
      }
      if (bounded.truncated) {
        throw new ModelCatalogError(
          "MODEL_LIST_FAILED",
          502,
          "The ModelArk management response exceeded the response limit",
        );
      }
      if (!response.ok) {
        throw new ModelCatalogError(
          "MODEL_PROVIDER_UNAVAILABLE",
          503,
          "BytePlus management request failed",
        );
      }
      return bounded.text;
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error;
      if (timedOut) {
        throw new ModelCatalogError(
          "MODEL_PROVIDER_UNAVAILABLE",
          503,
          "BytePlus management request timed out",
        );
      }
      throw new ModelCatalogError(
        "MODEL_PROVIDER_UNAVAILABLE",
        503,
        "BytePlus management request failed",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
