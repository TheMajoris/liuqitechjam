import { redactSensitiveText } from "./orchestration/handoff.js";

/** Runtime failures are persisted on Agent/Run records and must stay small. */
export const MAX_SAFE_RUNTIME_ERROR_LENGTH = 512;
const TRUNCATION_MARKER = " [TRUNCATED]";

/*
 * The handoff redactor covers the common workspace forms. This additional
 * boundary redactor intentionally treats every absolute filesystem path as
 * host topology, including paths outside the usual /Users, /tmp, and
 * /workspace roots.
 */
const absolutePathPattern = /(?:[A-Za-z]:[\\/]|\/)(?:[^\\/\s"'`<>]+[\\/])+[^\\/\s"'`<>]*/g;
const jsonSecretPattern = /(["']?(?:api[_-]?key|access[_-]?token|token|secret(?:[_-]?key)?|password|passwd|credential|authorization)["']?\s*:\s*)(["'][^"']*["']|[^,}\s]+)/gi;
const rawDetailPattern =
  /\b(?:stderr|stdout|stack)\b|\b(?:payload|response|body|json|detail)\b\s*[:=]|(?:\{[\s\S]*\}|\[[\s\S]*\])/i;

function bounded(value: string): string {
  if (value.length <= MAX_SAFE_RUNTIME_ERROR_LENGTH) return value;
  return value.slice(0, MAX_SAFE_RUNTIME_ERROR_LENGTH - TRUNCATION_MARKER.length).trimEnd() + TRUNCATION_MARKER;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
}

/**
 * Keep useful stable runtime messages while dropping raw provider details.
 * Codex/container stderr and JSON payloads are treated as implementation
 * detail; they never cross into persisted Agent/Run error fields.
 */
export function safeRuntimeError(
  error: unknown,
  fallback = "Agent runtime failed",
): string {
  const raw = errorText(error).replaceAll("\0", "").trim();
  if (!raw) return fallback;

  // Structured provider payloads and explicit stderr/stdout annotations can
  // contain arbitrary secrets and host paths. Keep only the stable fallback.
  if (raw.startsWith("{") || raw.startsWith("[") || rawDetailPattern.test(raw)) {
    return fallback;
  }

  const safe = redactSensitiveText(raw)
    .replace(jsonSecretPattern, "$1[REDACTED]")
    .replace(absolutePathPattern, "[REDACTED PATH]")
    .trim();
  return bounded(safe || fallback);
}
