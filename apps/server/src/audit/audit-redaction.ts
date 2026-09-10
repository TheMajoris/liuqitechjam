import { redactSensitiveText } from "../orchestration/handoff.js";
import type {
  AuditActorType,
  AuditCategory,
  AuditMetadata,
  AuditMetadataValue,
  AuditEventInput,
  AuditSpan,
  AuditEventSource,
} from "./audit-types.js";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_CATEGORIES,
  AUDIT_EVENT_SOURCES,
} from "./audit-types.js";
import type { Principal, ResourceRef } from "../access/access-types.js";

const auditSpanIdPattern = /^[A-Za-z0-9_.:-]{1,64}$/;

export const MAX_AUDIT_SUMMARY_LENGTH = 240;
export const MAX_AUDIT_ID_LENGTH = 160;
export const MAX_AUDIT_METADATA_KEYS = 16;
export const MAX_AUDIT_METADATA_VALUE_LENGTH = 160;
export const MAX_AUDIT_SOURCE_LENGTH = 64;
export const MAX_AUDIT_SCHEMA_VERSION = 100;

const unsafeText = /\b(?:prompt|raw\s+output|provider\s+body|response\s+body|headers?|environment|env|workspace\s+path|cwd|working\s+directory|command|reason|input|output|binding|handle)\b/i;
/**
 * Audit metadata is an allowlist in spirit: identifiers and enum-like
 * counters are retained, while request contents, decision explanations and
 * process/transport handles are discarded even when a caller uses a new key.
 */
const unsafeKey = /(?:^|_)(?:prompt|raw|input|output|body|header|headers|secret|token|password|credential|authorization|environment|env|path|cwd|command|reason|binding|handle)(?:_|$)/;

function unsafeMetadataKey(key: string): boolean {
  // Normalize camelCase before applying segment boundaries. This avoids
  // rejecting the legitimate `reasoningItems` counter while still dropping
  // `decisionReason`, `inputBinding`, and `completionHandle`.
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  return unsafeKey.test(normalized);
}
/** Numeric usage counters are safe evidence even though their names match the deny-list. */
const allowedMetadataKeys = new Set([
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "stdoutBytes",
  "stderrBytes",
  "resultBytes",
  "commandHash",
  "workspaceFile",
  "pathHash",
  "argHash",
  "commandItems",
]);

const shellWrappers = new Set(["bash", "sh", "zsh"]);
const envAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const shellCommandFlag = /^-[a-z]*c$/;

function basename(token: string): string {
  const trimmed = token.replace(/^['"`]+/, "").replace(/['"`]+$/, "");
  const segment = trimmed.split(/[\\/]/).at(-1) ?? "";
  return segment.replace(/\.exe$/i, "").slice(0, 64);
}

/**
 * The executable name of a sandbox command. The arguments, paths, and any
 * inline script body are discarded; only the program identity is evidence.
 */
export function programBasename(command: unknown): string {
  if (typeof command !== "string") return "unknown";
  const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length && envAssignment.test(tokens[index] ?? "")) index += 1;
  const head = tokens[index];
  if (head === undefined) return "unknown";
  if (
    shellWrappers.has(basename(head).toLowerCase()) &&
    shellCommandFlag.test(tokens[index + 1] ?? "")
  ) {
    const inner = tokens[index + 2];
    if (inner === undefined) return "unknown";
    return basename(inner) || "unknown";
  }
  return basename(head) || "unknown";
}

/** Filenames whose mere name is a credential signal; never retained verbatim. */
export const SECRET_LIKE_FILENAME =
  /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|.*\.p12|.*\.pfx|.*secret.*|.*credential.*|\.npmrc|\.netrc)$/i;

export function isSecretLikeFilename(path: string): boolean {
  return SECRET_LIKE_FILENAME.test(path);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function compact(value: string): string {
  return redactSensitiveText(value)
    .replace(/https?:\/\/[^\s]+/gi, "[REDACTED URL]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function safeAuditIdentifier(value: unknown): string | undefined {
  const normalized = compact(asText(value));
  if (!normalized || normalized.length > MAX_AUDIT_ID_LENGTH) return undefined;
  return normalized;
}

/**
 * Audit summaries are intentionally generic. Suspicious caller text is not
 * retained because a summary is evidence, not a prompt or provider response.
 */
export function safeAuditSummary(value: unknown, fallback: string): string {
  const normalized = compact(asText(value));
  const candidate = normalized && !unsafeText.test(normalized) ? normalized : compact(fallback);
  if (candidate.length <= MAX_AUDIT_SUMMARY_LENGTH) return candidate;
  return candidate.slice(0, MAX_AUDIT_SUMMARY_LENGTH - 14).trimEnd() + " [TRUNCATED]";
}

function safeMetadataValue(value: unknown): AuditMetadataValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = compact(value);
  if (!normalized || unsafeText.test(normalized)) return undefined;
  return normalized.length <= MAX_AUDIT_METADATA_VALUE_LENGTH
    ? normalized
    : normalized.slice(0, MAX_AUDIT_METADATA_VALUE_LENGTH - 14).trimEnd() + " [TRUNCATED]";
}

export function safeAuditMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): AuditMetadata {
  if (!metadata) return {};
  const entries: [string, AuditMetadataValue][] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (entries.length >= MAX_AUDIT_METADATA_KEYS) continue;
    if (unsafeMetadataKey(key) && !allowedMetadataKeys.has(key)) continue;
    const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
    if (!safeKey) continue;
    const safeValue = safeMetadataValue(value);
    if (safeValue === undefined) continue;
    entries.push([safeKey, safeValue]);
  }
  return Object.fromEntries(entries);
}

function safeCorrelation(input: AuditEventInput): Pick<
  AuditEventInput,
  "agentId" | "projectId" | "runId" | "orchestrationId" | "turnId" | "sessionId" |
  "invocationId" | "approvalId" | "workflowRunId" | "permitRequestId" | "approvalRequestId" | "grantId"
> {
  const correlation = {} as Pick<
    AuditEventInput,
    "agentId" | "projectId" | "runId" | "orchestrationId" | "turnId" | "sessionId" |
    "invocationId" | "approvalId" | "workflowRunId" | "permitRequestId" | "approvalRequestId" | "grantId"
  >;
  for (const key of [
    "agentId",
    "projectId",
    "runId",
    "orchestrationId",
    "turnId",
    "sessionId",
    "invocationId",
    "approvalId",
    "workflowRunId",
    "permitRequestId",
    "approvalRequestId",
    "grantId",
  ] as const) {
    const value = safeAuditIdentifier(input[key]);
    if (value !== undefined) correlation[key] = value;
  }
  return correlation;
}

function safeSpanIdentifier(value: unknown): string | undefined {
  const normalized = safeAuditIdentifier(value);
  if (normalized === undefined || !auditSpanIdPattern.test(normalized)) return undefined;
  return normalized;
}

function safeAuditSpan(span: Partial<AuditSpan> | undefined): Partial<AuditSpan> | undefined {
  if (!span) return undefined;
  const traceId = safeSpanIdentifier(span.traceId);
  const spanId = safeSpanIdentifier(span.spanId);
  const parentSpanId = safeSpanIdentifier(span.parentSpanId);
  const result: Partial<AuditSpan> = {};
  if (traceId !== undefined) result.traceId = traceId;
  if (spanId !== undefined) result.spanId = spanId;
  if (parentSpanId !== undefined) result.parentSpanId = parentSpanId;
  return Object.keys(result).length === 0 ? undefined : result;
}

function safeDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeActorType(value: unknown): AuditActorType | undefined {
  return AUDIT_ACTOR_TYPES.includes(value as AuditActorType) ? (value as AuditActorType) : undefined;
}

function safeCategory(value: unknown): AuditCategory | undefined {
  return AUDIT_CATEGORIES.includes(value as AuditCategory) ? (value as AuditCategory) : undefined;
}

function safeSchemaVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_AUDIT_SCHEMA_VERSION
    ? value
    : undefined;
}

function safeSource(value: unknown): AuditEventSource | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_AUDIT_SOURCE_LENGTH ||
    !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(normalized)
  ) {
    return undefined;
  }
  return AUDIT_EVENT_SOURCES.includes(normalized as AuditEventSource)
    ? (normalized as AuditEventSource)
    : undefined;
}

export type SafeAuditEventInput = Omit<
  AuditEventInput,
  "metadata" | "principal" | "span" | "durationMs" | "agentVersion" | "actorType" | "category" |
  "schemaVersion" | "source"
> & {
  metadata: AuditMetadata;
  principal: Principal;
  span?: Partial<AuditSpan>;
  durationMs?: number;
  agentVersion?: string;
  actorType?: AuditActorType;
  category?: AuditCategory;
  schemaVersion?: number;
  source?: string;
};

export function safeAuditInput(input: AuditEventInput): SafeAuditEventInput {
  const principalId = safeAuditIdentifier(input.principal.id) ?? "unknown";
  const principal: Principal = input.principal.kind === "agent"
    ? { kind: "agent", id: principalId }
    : input.principal.kind === "system"
      ? { kind: "system", id: "runtime" }
      : { kind: "human", id: principalId };
  const permission = safeAuditIdentifier(input.permission);
  const span = safeAuditSpan(input.span);
  const durationMs = safeDurationMs(input.durationMs);
  const agentVersion = safeAuditIdentifier(input.agentVersion);
  const actorType = safeActorType(input.actorType);
  const category = safeCategory(input.category);
  const schemaVersion = safeSchemaVersion(input.schemaVersion);
  const source = safeSource(input.source);
  const resource: ResourceRef | undefined = input.resource === undefined
    ? undefined
    : input.resource.kind === "preview"
      ? {
          kind: "preview" as const,
          owner: input.resource.owner.kind === "agent"
            ? { kind: "agent" as const, agentId: safeAuditIdentifier(input.resource.owner.agentId) ?? "unknown" }
            : { kind: "project" as const, projectId: safeAuditIdentifier(input.resource.owner.projectId) ?? "unknown" },
        }
      : {
          kind: input.resource.kind,
          id: safeAuditIdentifier(input.resource.id) ?? "unknown",
        };
  return {
    ...safeCorrelation(input),
    type: input.type,
    status: input.status,
    summary: safeAuditSummary(input.summary, "Server audit event"),
    principal,
    ...(permission === undefined ? {} : { permission }),
    ...(resource === undefined ? {} : { resource }),
    metadata: safeAuditMetadata(input.metadata),
    ...(span === undefined ? {} : { span }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(agentVersion === undefined ? {} : { agentVersion }),
    ...(actorType === undefined ? {} : { actorType }),
    ...(category === undefined ? {} : { category }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(source === undefined ? {} : { source }),
  };
}
