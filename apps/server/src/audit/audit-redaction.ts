import { redactSensitiveText } from "../orchestration/handoff.js";
import type {
  AuditActorType,
  AuditCategory,
  AuditMetadata,
  AuditMetadataValue,
  AuditEventInput,
  AuditSpan,
} from "./audit-types.js";
import { AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES } from "./audit-types.js";
import type { Principal, ResourceRef } from "../access/access-types.js";

const auditSpanIdPattern = /^[A-Za-z0-9_.:-]{1,64}$/;

export const MAX_AUDIT_SUMMARY_LENGTH = 240;
export const MAX_AUDIT_ID_LENGTH = 160;
export const MAX_AUDIT_METADATA_KEYS = 16;
export const MAX_AUDIT_METADATA_VALUE_LENGTH = 160;

const unsafeText = /\b(?:prompt|raw\s+output|provider\s+body|response\s+body|headers?|environment|env|workspace\s+path|cwd|working\s+directory|command)\b/i;
const unsafeKey = /(?:prompt|output|body|header|secret|token|password|credential|authorization|environment|env|path|cwd|command)/i;
/** Numeric usage counters are safe evidence even though their names match the deny-list. */
const allowedMetadataKeys = new Set(["inputTokens", "cachedInputTokens", "outputTokens", "stdoutBytes", "stderrBytes", "commandHash"]);

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
    if (unsafeKey.test(key) && !allowedMetadataKeys.has(key)) continue;
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
  "agentId" | "projectId" | "runId" | "orchestrationId" | "permitRequestId" | "approvalRequestId" | "grantId"
> {
  const correlation = {} as Pick<
    AuditEventInput,
    "agentId" | "projectId" | "runId" | "orchestrationId" | "permitRequestId" | "approvalRequestId" | "grantId"
  >;
  for (const key of [
    "agentId",
    "projectId",
    "runId",
    "orchestrationId",
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

export type SafeAuditEventInput = Omit<
  AuditEventInput,
  "metadata" | "principal" | "span" | "durationMs" | "agentVersion" | "actorType" | "category"
> & {
  metadata: AuditMetadata;
  principal: Principal;
  span?: Partial<AuditSpan>;
  durationMs?: number;
  agentVersion?: string;
  actorType?: AuditActorType;
  category?: AuditCategory;
};

export function safeAuditInput(input: AuditEventInput): SafeAuditEventInput {
  const principalId = safeAuditIdentifier(input.principal.id) ?? "unknown";
  const principal: Principal = input.principal.kind === "agent"
    ? { kind: "agent", id: principalId }
    : input.principal.kind === "system"
      ? { kind: "system", id: "runtime" }
      : { kind: "human", id: "demo-owner" };
  const permission = safeAuditIdentifier(input.permission);
  const span = safeAuditSpan(input.span);
  const durationMs = safeDurationMs(input.durationMs);
  const agentVersion = safeAuditIdentifier(input.agentVersion);
  const actorType = safeActorType(input.actorType);
  const category = safeCategory(input.category);
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
  };
}
