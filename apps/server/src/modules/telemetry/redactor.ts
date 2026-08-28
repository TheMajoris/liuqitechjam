/**
 * Pure redaction helpers for the telemetry ledger.
 *
 * No I/O, no clock access. Everything here is deterministic given its inputs so
 * the ledger (and its tests) can rely on stable output. The ledger is the only
 * sanctioned path from a raw structured payload to a persisted preview string.
 */

export interface RedactOptions {
  /** Configured secret values; only non-empty strings are honoured. */
  secretValues: string[];
}

export const REDACTED = "[REDACTED]";
export const TRUNCATED = "[TRUNCATED]";

/** Maximum object/array nesting the redactor will walk before truncating. */
const MAX_DEPTH = 8;

/** Default preview byte budget (2 KiB). */
const DEFAULT_MAX_BYTES = 2048;

/**
 * Case-insensitive key-name fragments. A field whose key CONTAINS any of these
 * has its entire value replaced, regardless of the value's shape.
 */
const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  "authorization",
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "secret",
  "password",
  "passwd",
  "token",
  "bearer",
  "cookie",
  "credential",
  "private_key",
  "ark_api_key",
  "admin_token",
  "lease",
];

/** `Bearer <token>` anywhere inside a string. */
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Standalone credential-shaped tokens with a well-known prefix. Kept
 * deliberately narrow so ordinary long words, hex blobs and UUIDs survive.
 */
const PREFIXED_TOKEN_PATTERN = /\b(?:glease_|lease_|sk-)[A-Za-z0-9_-]{4,}/g;

const isSensitiveKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Redact a single string: configured secret substrings first, then
 * `Bearer <token>` sequences, then prefixed credential tokens. UUIDs and
 * ordinary long tokens are intentionally left intact.
 */
const redactString = (input: string, secretValues: string[]): string => {
  let output = input;

  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length > 0 && output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }
  }

  output = output.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  output = output.replace(PREFIXED_TOKEN_PATTERN, REDACTED);

  return output;
};

const redactAtDepth = (
  value: unknown,
  secretValues: string[],
  depth: number,
): unknown => {
  if (depth > MAX_DEPTH) {
    return TRUNCATED;
  }

  if (typeof value === "string") {
    return redactString(value, secretValues);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactAtDepth(item, secretValues, depth + 1));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSensitiveKey(key)
        ? REDACTED
        : redactAtDepth(item, secretValues, depth + 1);
    }
    return result;
  }

  // Dates, Maps, class instances, functions, symbols: never persist these
  // structurally. Fall back to a redacted string form.
  return redactString(String(value), secretValues);
};

const activeSecrets = (opts: RedactOptions): string[] =>
  opts.secretValues.filter(
    (secret): secret is string => typeof secret === "string" && secret.length > 0,
  );

/**
 * Deep-clone `value` with redaction applied. Primitives other than strings pass
 * through untouched; nesting deeper than {@link MAX_DEPTH} becomes
 * {@link TRUNCATED}.
 */
export const redactValue = (value: unknown, opts: RedactOptions): unknown =>
  redactAtDepth(value, activeSecrets(opts), 0);

const safeStringify = (value: unknown): string => {
  try {
    const json = JSON.stringify(value);
    return json ?? "null";
  } catch {
    return String(value);
  }
};

/**
 * Truncate `input` to at most `maxBytes` UTF-8 bytes without splitting a
 * multibyte code point, appending `…[+N bytes]` when anything was dropped.
 */
const truncateUtf8 = (input: string, maxBytes: number): string => {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(input).length;
  if (totalBytes <= maxBytes) {
    return input;
  }

  let kept = "";
  let keptBytes = 0;
  for (const codePoint of input) {
    const size = encoder.encode(codePoint).length;
    if (keptBytes + size > maxBytes) {
      break;
    }
    kept += codePoint;
    keptBytes += size;
  }

  const dropped = totalBytes - keptBytes;
  return `${kept}…[+${dropped} bytes]`;
};

/**
 * Redact, serialise, then byte-cap. Strings pass through as their own text;
 * everything else is `JSON.stringify`d. Default budget is 2 KiB.
 */
export const redactPreview = (
  value: unknown,
  opts: RedactOptions & { maxBytes?: number },
): string => {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const redacted = redactValue(value, { secretValues: opts.secretValues });
  const serialized =
    typeof redacted === "string" ? redacted : safeStringify(redacted);
  return truncateUtf8(serialized, maxBytes);
};
