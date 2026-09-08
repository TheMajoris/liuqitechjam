import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentPrincipal } from "../apps/server/src/access/access-types.js";
import { DefaultAuthorizationService } from "../apps/server/src/access/default-authorization-service.js";
import { AgentRuntimePromptComposer } from "../apps/server/src/agent-runtime-prompt.js";
import {
  buildHandoffPrompt,
  type HandoffSource,
  type SharedConversationTurn,
} from "../apps/server/src/orchestration/handoff.js";
import {
  buildSupervisorPrompt,
} from "../apps/server/src/orchestration/supervisor/context.js";
import type { SupervisorSelectionContext } from "../apps/server/src/orchestration/supervisor/types.js";
import { createMcpServer } from "../apps/server/src/mcp-server.js";
import { projectRuntimeContextLines } from "../apps/server/src/projects/project-execution.js";
import { ProjectWorkspaceManager } from "../apps/server/src/projects/project-workspace.js";
import { SkillService, type SkillCapabilityResolver } from "../apps/server/src/skills/skill-service.js";
import { createBuiltInSkillRegistry } from "../apps/server/src/skills/index.js";
import type { SkillRuntimeContext } from "../apps/server/src/skills/skill-types.js";
import { ToolRegistry } from "../apps/server/src/tools/tool-registry.js";
import type {
  ToolCapabilitiesView,
  ToolDefinition,
  ToolMetadata,
} from "../apps/server/src/tools/tool-types.js";
import { WebFetchAdapter, type WebFetchResult } from "../apps/server/src/tools/web-fetch-adapter.js";
import {
  countToolsListMessages,
  MCP_TOOLS_LIST_REQUEST_BOUND,
  type McpSessionContext,
} from "../apps/server/src/tools/mcp-session-service.js";
import type { ToolService } from "../apps/server/src/tools/tool-service.js";
import type { Agent } from "../apps/server/src/types.js";
import { WorkspaceManager } from "../apps/server/src/workspace.js";
import {
  REPORT_AGENT,
  REPORT_AGENT_WITH_SKILL,
  REPORT_FETCH_URL,
  REPORT_HTML,
  REPORT_MCP_OUTPUT,
  REPORT_PARTICIPANTS,
  REPORT_PROJECT,
  REPORT_PROMPTS,
  REPORT_USAGE_EVENTS,
} from "./token-context-fixtures.js";

export const TOKEN_CONTEXT_REPORT_VERSION = 2 as const;

export type UsageScope =
  | "last-request"
  | "cumulative-session"
  | "app-run"
  | "endpoint-window"
  | "unknown";

export type UsageSource =
  | "runtime-jsonl"
  | "provider-response"
  | "provider-management-aggregate"
  | "unknown";

export type FreshnessState = "fresh" | "resumed" | "unknown";
export type FallbackStatus = "used" | "not-used" | "unknown";
export type DiscoveryCountStatus = "bounded" | "overflow" | "unknown";
export type RunCorrelationStatus = "authenticated" | "synthetic-unverified" | "unknown";

export interface TextMeasurement {
  /** Unicode code-point count; this is not an exact model token count. */
  characters: number;
  /** UTF-8 byte count; this is not an exact model token count. */
  utf8Bytes: number;
}

export interface BoundaryMeasurement {
  scenario: string;
  boundary: string;
  before: TextMeasurement;
  after: TextMeasurement;
  delta: TextMeasurement;
  note: string;
}

export interface UsageCounters {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export type UsageAvailability = "available" | "partial" | "unknown";

export type CacheHitRatioStatus =
  | "valid"
  | "unknown"
  | "invalid-cached-input";

export interface ToolSchemaEstimator {
  identity: string | null;
  version: string | null;
  approximate: boolean | null;
}

export interface TokenContextDiagnostics {
  runId: string | null;
  runCorrelationStatus: RunCorrelationStatus;
  /** Optional normalized counters; null means no trustworthy counter exists. */
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  usageSource: UsageSource;
  usageScope: UsageScope;
  configuredCatalogueSize: number | null;
  numberOfToolsExposed: number | null;
  toolsListRequestsObserved: number | null;
  toolsListRequestBound: number;
  toolsListRequestCountStatus: DiscoveryCountStatus;
  discoveryObserved: boolean | null;
  authenticatedDiscoveryObserved: boolean | null;
  toolSchemaBytes: number | null;
  toolSchemaEstimatedTokens: number | null;
  toolSchemaEstimator: ToolSchemaEstimator;
  stableContextFingerprint: string | null;
  catalogueFingerprint: string | null;
  rawTaskBytes: number | null;
  rawRuntimeEnvelopeBytes: number | null;
  runtimeVersion: string | null;
  providerId: string | null;
  modelId: string | null;
  freshness: FreshnessState;
  fallbackStatus: FallbackStatus;
}

export interface UsageScopeSummary {
  scope: UsageScope;
  usageSource: UsageSource;
  /** Number of candidate records assigned to this scope. */
  records: number;
  /** Candidate records discarded because they repeated an identified state. */
  duplicateRecords: number;
  /** Number of distinct cumulative states represented by this summary. */
  distinctStates: number;
  /** Number of identity streams seen in this scope. */
  distinctIdentities: number;
  /** Cumulative scopes keep one identity's latest state; multiple identities are unknown. */
  aggregation:
    | "sum-distinct-requests"
    | "latest-cumulative-state"
    | "ambiguous-multiple-identities"
    | "ambiguous-missing-identity"
    | "ambiguous-mixed-sources"
    | "unknown";
  availability: UsageAvailability;
  counters: UsageCounters;
  cacheHitRatio: number | null;
  cacheHitRatioStatus: CacheHitRatioStatus;
}

export interface UsageSummary {
  source: "none" | "synthetic-fixture" | "offline-file" | "invalid-file";
  usageSource: UsageSource;
  /** Parsed candidate records, excluding arbitrary text and unsupported objects. */
  records: number;
  unsupportedOrAmbiguousRecords: number;
  rawEvidence: RawRuntimeEvidenceStatus;
  scopes: Record<UsageScope, UsageScopeSummary>;
}

export interface RawRuntimeEvidenceStatus {
  /** Raw evidence is intentionally kept outside normalized benchmark output. */
  status: "not-collected" | "pending-sanitized-capture";
  path: string | null;
  records: number | null;
}

export interface TokenContextScenario {
  id: string;
  measurements: BoundaryMeasurement[];
}

/**
 * A comparable delivery pair. Both sides use the same synthetic task and
 * public renderer; only the delivery variant (legacy duplicate vs canonical)
 * changes. A positive reduction means fewer characters/bytes after the pair.
 */
export interface DeliveryComparison {
  scenario: string;
  boundary: string;
  before: TextMeasurement;
  after: TextMeasurement;
  delta: TextMeasurement;
  reduction: TextMeasurement;
  note: string;
}

export interface OfflineTokenContextReport {
  version: typeof TOKEN_CONTEXT_REPORT_VERSION;
  units: {
    characters: "unicode-code-points";
    utf8Bytes: "utf8-byte-count";
    tokenCounts: "reported-counters-only";
  };
  scenarios: TokenContextScenario[];
  deliveryComparisons: DeliveryComparison[];
  diagnostics: TokenContextDiagnostics;
  usage: UsageSummary;
}

const COUNTER_KEYS = {
  inputTokens: ["input_tokens", "inputTokens", "input"],
  cachedInputTokens: ["cached_input_tokens", "cachedInputTokens", "cachedInput"],
  outputTokens: ["output_tokens", "outputTokens", "output"],
} as const;

const SCOPE_ALIASES: ReadonlyMap<string, UsageScope> = new Map([
  ["last-request", "last-request"],
  ["last_request", "last-request"],
  ["lastrequest", "last-request"],
  ["request", "last-request"],
  ["per-request", "last-request"],
  ["per_request", "last-request"],
  ["cumulative-session", "cumulative-session"],
  ["cumulative_session", "cumulative-session"],
  ["cumulativesession", "cumulative-session"],
  ["session", "cumulative-session"],
  ["app-run", "app-run"],
  ["app_run", "app-run"],
  ["apprun", "app-run"],
  ["run", "app-run"],
  ["per-run", "app-run"],
  ["per_run", "app-run"],
  ["endpoint-window", "endpoint-window"],
  ["endpoint_window", "endpoint-window"],
  ["endpointwindow", "endpoint-window"],
  ["window", "endpoint-window"],
]);

const USAGE_SCOPES: readonly UsageScope[] = [
  "last-request",
  "cumulative-session",
  "app-run",
  "endpoint-window",
  "unknown",
];

export const TOOLS_LIST_REQUEST_BOUND = MCP_TOOLS_LIST_REQUEST_BOUND;

interface UsageCandidate {
  scope: UsageScope;
  source: UsageSource;
  counters: UsageCounters;
  identity: string | null;
  hasCounter: boolean;
  eventIndex: number;
}

interface CandidateCollection {
  candidates: UsageCandidate[];
  unsupportedOrAmbiguousRecords: number;
}

interface UsageAccumulator {
  scope: UsageScope;
  records: number;
  duplicateRecords: number;
  distinctStates: number;
  distinctIdentities: number;
  availability: UsageAvailability;
  counters: UsageCounters;
  aggregation: UsageScopeSummary["aggregation"];
  sourceValues: Set<UsageSource>;
  mixedSources: boolean;
  ambiguousMissingIdentity: boolean;
  seenRequestIdentities: Set<string>;
  cumulativeStates: Map<string, UsageCounters>;
}

function emptyCounters(): UsageCounters {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
  };
}

function emptyToolSchemaEstimator(): ToolSchemaEstimator {
  return {
    identity: null,
    version: null,
    approximate: null,
  };
}

function usageSourceFromValue(value: unknown): UsageSource {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "runtime-jsonl" || normalized === "runtime_jsonl" || normalized === "jsonl") {
    return "runtime-jsonl";
  }
  if (normalized === "provider-response" || normalized === "provider_response" || normalized === "response") {
    return "provider-response";
  }
  if (
    normalized === "provider-management-aggregate" ||
    normalized === "provider_management_aggregate" ||
    normalized === "management-aggregate" ||
    normalized === "management_aggregate"
  ) {
    return "provider-management-aggregate";
  }
  return "unknown";
}

function usageSourceFromRecord(
  parent: Record<string, unknown>,
  payload: Record<string, unknown>,
  fallback: UsageSource,
): UsageSource {
  for (const value of [
    parent.usageSource,
    parent.usage_source,
    parent.source,
    payload.usageSource,
    payload.usage_source,
    payload.source,
  ]) {
    const source = usageSourceFromValue(value);
    if (source !== "unknown") return source;
  }
  return fallback;
}

function emptyScopeSummary(scope: UsageScope): UsageScopeSummary {
  return {
    scope,
    usageSource: "unknown",
    records: 0,
    duplicateRecords: 0,
    distinctStates: 0,
    distinctIdentities: 0,
    aggregation:
      scope === "last-request"
        ? "sum-distinct-requests"
        : scope === "cumulative-session" || scope === "app-run" || scope === "endpoint-window"
          ? "latest-cumulative-state"
          : "unknown",
    availability: "unknown",
    counters: emptyCounters(),
    cacheHitRatio: null,
    cacheHitRatioStatus: "unknown",
  };
}

function emptyUsageSummary(source: UsageSummary["source"] = "none"): UsageSummary {
  return {
    source,
    usageSource: "unknown",
    records: 0,
    unsupportedOrAmbiguousRecords: 0,
    rawEvidence: {
      status: source === "offline-file" ? "pending-sanitized-capture" : "not-collected",
      path: null,
      records: null,
    },
    scopes: Object.fromEntries(
      USAGE_SCOPES.map((scope) => [scope, emptyScopeSummary(scope)]),
    ) as Record<UsageScope, UsageScopeSummary>,
  };
}

/** Measure Unicode code points and UTF-8 bytes without estimating tokens. */
export function measureText(value: string): TextMeasurement {
  return {
    characters: Array.from(value).length,
    utf8Bytes: Buffer.byteLength(value, "utf8"),
  };
}

function compareMeasurements(beforeText: string, afterText: string): {
  before: TextMeasurement;
  after: TextMeasurement;
  delta: TextMeasurement;
} {
  const before = measureText(beforeText);
  const after = measureText(afterText);
  return {
    before,
    after,
    delta: {
      characters: after.characters - before.characters,
      utf8Bytes: after.utf8Bytes - before.utf8Bytes,
    },
  };
}

function compareDelivery(
  scenario: string,
  boundary: string,
  beforeText: string,
  afterText: string,
  note: string,
): DeliveryComparison {
  const measured = compareMeasurements(beforeText, afterText);
  return {
    scenario,
    boundary,
    ...measured,
    reduction: {
      characters: measured.before.characters - measured.after.characters,
      utf8Bytes: measured.before.utf8Bytes - measured.after.utf8Bytes,
    },
    note,
  };
}

function addMeasurement(
  scenario: TokenContextScenario,
  boundary: string,
  before: string,
  after: string,
  note: string,
): void {
  scenario.measurements.push({
    scenario: scenario.id,
    boundary,
    ...compareMeasurements(before, after),
    note,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function scopeFromValue(value: unknown): UsageScope | null {
  if (typeof value !== "string") return null;
  return SCOPE_ALIASES.get(value.trim().toLocaleLowerCase()) ?? null;
}

function inferScope(
  parent: Record<string, unknown>,
  payload: Record<string, unknown>,
): UsageScope {
  const explicit =
    scopeFromValue(parent.scope) ??
    scopeFromValue(parent.usage_scope) ??
    scopeFromValue(parent.usageScope) ??
    scopeFromValue(payload.scope) ??
    scopeFromValue(payload.usage_scope) ??
    scopeFromValue(payload.usageScope);
  if (explicit) return explicit;
  return "unknown";
}

function identityFrom(
  parent: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | null {
  for (const candidate of [
    parent.request_id,
    parent.requestId,
    parent.session_id,
    parent.sessionId,
    parent.run_id,
    parent.runId,
    parent.window_id,
    parent.windowId,
    parent.endpoint_id,
    parent.endpointId,
    parent.event_id,
    parent.eventId,
    parent.id,
    payload.request_id,
    payload.requestId,
    payload.session_id,
    payload.sessionId,
    payload.run_id,
    payload.runId,
    payload.window_id,
    payload.windowId,
    payload.endpoint_id,
    payload.endpointId,
    payload.event_id,
    payload.eventId,
    payload.id,
  ]) {
    const value = asNonEmptyString(candidate);
    if (value) return value;
  }
  return null;
}

function readCounter(
  value: unknown,
  keys: readonly string[],
): { value: number | null; supplied: boolean; valid: boolean } {
  for (const key of keys) {
    if (!(key in (value as object))) continue;
    const candidate = (value as Record<string, unknown>)[key];
    if (
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
    ) {
      return { value: candidate, supplied: true, valid: true };
    }
    return { value: null, supplied: true, valid: false };
  }
  return { value: null, supplied: false, valid: true };
}

function readCounters(value: Record<string, unknown>): {
  counters: UsageCounters;
  hasCounter: boolean;
  valid: boolean;
} {
  const input = readCounter(value, COUNTER_KEYS.inputTokens);
  const cached = readCounter(value, COUNTER_KEYS.cachedInputTokens);
  const output = readCounter(value, COUNTER_KEYS.outputTokens);
  return {
    counters: {
      inputTokens: input.value,
      cachedInputTokens: cached.value,
      outputTokens: output.value,
    },
    hasCounter: input.supplied || cached.supplied || output.supplied,
    valid: input.valid && cached.valid && output.valid,
  };
}

function candidateFor(
  parent: Record<string, unknown>,
  payload: Record<string, unknown>,
  eventIndex: number,
  fallbackSource: UsageSource,
): UsageCandidate | null {
  const counters = readCounters(payload);
  if (!counters.hasCounter) return null;
  return {
    scope: inferScope(parent, payload),
    source: usageSourceFromRecord(parent, payload, fallbackSource),
    counters: counters.counters,
    identity: identityFrom(parent, payload),
    hasCounter: counters.hasCounter && counters.valid,
    eventIndex,
  };
}

/**
 * Find only explicit usage objects. Arbitrary strings and ordinary metadata
 * that happen to contain the word "input" are never interpreted as counters.
 */
function collectUsageCandidates(
  value: unknown,
  fallbackSource: UsageSource,
): CandidateCollection {
  const candidates: UsageCandidate[] = [];
  let unsupportedOrAmbiguousRecords = 0;
  let eventIndex = 0;
  const visited = new WeakSet<object>();

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isRecord(current) || visited.has(current)) return;
    visited.add(current);
    const parent = current;

    if (Object.prototype.hasOwnProperty.call(parent, "usage")) {
      const usage = parent.usage;
      if (isRecord(usage)) {
        const candidate = candidateFor(parent, usage, eventIndex++, fallbackSource);
        if (candidate && candidate.hasCounter) candidates.push(candidate);
        else unsupportedOrAmbiguousRecords += 1;
      } else {
        unsupportedOrAmbiguousRecords += 1;
      }
    }

    for (const [key, nested] of Object.entries(parent)) {
      const nestedScope = scopeFromValue(key);
      if (nestedScope && isRecord(nested)) {
        const candidate = candidateFor(
          { ...parent, scope: nestedScope },
          nested,
          eventIndex++,
          fallbackSource,
        );
        if (candidate && candidate.hasCounter) candidates.push(candidate);
        else unsupportedOrAmbiguousRecords += 1;
        continue;
      }
      if (key === "usage") continue;
      visit(nested);
    }

    // Support a saved event represented directly as {scope, input_tokens, ...}.
    const direct = candidateFor(parent, parent, eventIndex++, fallbackSource);
    if (direct && direct.hasCounter) candidates.push(direct);
    else if (readCounters(parent).hasCounter) unsupportedOrAmbiguousRecords += 1;
  }

  visit(value);
  return { candidates, unsupportedOrAmbiguousRecords };
}

function addCounterValues(
  left: UsageCounters,
  right: UsageCounters,
): UsageCounters {
  const add = (leftValue: number | null, rightValue: number | null): number | null => {
    if (leftValue === null) return rightValue;
    if (rightValue === null) return leftValue;
    const value = leftValue + rightValue;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    cachedInputTokens: add(left.cachedInputTokens, right.cachedInputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
  };
}

function counterAvailability(counters: UsageCounters): UsageAvailability {
  const present = Object.values(counters).filter((value) => value !== null).length;
  return present === 0 ? "unknown" : present === 3 ? "available" : "partial";
}

function countersEqual(left: UsageCounters, right: UsageCounters): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens
  );
}

export function computeCacheHitRatio(
  counters: UsageCounters,
): { ratio: number | null; status: CacheHitRatioStatus } {
  const { inputTokens, cachedInputTokens } = counters;
  if (inputTokens === null || cachedInputTokens === null || inputTokens <= 0) {
    return { ratio: null, status: "unknown" };
  }
  if (cachedInputTokens < 0 || cachedInputTokens > inputTokens) {
    return { ratio: null, status: "invalid-cached-input" };
  }
  return {
    ratio: cachedInputTokens / inputTokens,
    status: "valid",
  };
}

export interface UsageSnapshotDifference {
  valid: boolean;
  reason:
    | "valid"
    | "missing-counter"
    | "counter-reset"
    | "invalid-counter"
    | "invalid-cached-input"
    | "incompatible-evidence";
  counters: UsageCounters;
}

export interface UsageSnapshotEvidence {
  counters: UsageCounters;
  source: UsageSource;
  scope: UsageScope;
  /** Stable session/thread identity shared by the before and after snapshots. */
  identity: string | null;
}

/**
 * Subtract only verified compatible snapshots. A missing field, reset, or
 * impossible cached-input relationship keeps the difference unknown.
 */
export function subtractUsageSnapshots(
  before: UsageSnapshotEvidence,
  after: UsageSnapshotEvidence,
): UsageSnapshotDifference {
  if (
    before.source === "unknown" ||
    after.source === "unknown" ||
    before.source !== after.source ||
    before.scope === "unknown" ||
    after.scope === "unknown" ||
    before.scope !== after.scope ||
    (before.scope !== "cumulative-session" &&
      before.scope !== "app-run") ||
    before.identity === null ||
    after.identity === null ||
    before.identity !== after.identity
  ) {
    return { valid: false, reason: "incompatible-evidence", counters: emptyCounters() };
  }
  const beforeCounters = before.counters;
  const afterCounters = after.counters;
  if (Object.values(beforeCounters).some((value) => value === null) || Object.values(afterCounters).some((value) => value === null)) {
    return { valid: false, reason: "missing-counter", counters: emptyCounters() };
  }
  if (
    Object.values(beforeCounters).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    Object.values(afterCounters).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    return { valid: false, reason: "invalid-counter", counters: emptyCounters() };
  }
  const beforeRatio = computeCacheHitRatio(beforeCounters);
  const afterRatio = computeCacheHitRatio(afterCounters);
  if (
    beforeRatio.status === "invalid-cached-input" ||
    afterRatio.status === "invalid-cached-input"
  ) {
    return { valid: false, reason: "invalid-cached-input", counters: emptyCounters() };
  }
  const counters = {
    inputTokens: afterCounters.inputTokens! - beforeCounters.inputTokens!,
    cachedInputTokens: afterCounters.cachedInputTokens! - beforeCounters.cachedInputTokens!,
    outputTokens: afterCounters.outputTokens! - beforeCounters.outputTokens!,
  };
  if (Object.values(counters).some((value) => value < 0)) {
    return { valid: false, reason: "counter-reset", counters: emptyCounters() };
  }
  if (computeCacheHitRatio(counters).status === "invalid-cached-input") {
    return { valid: false, reason: "invalid-cached-input", counters: emptyCounters() };
  }
  return { valid: true, reason: "valid", counters };
}

/** Stable JSON used only for private comparison fingerprints. */
export function stableSerialize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`);
  return `{${entries.join(",")}}`;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex");
}

/** Fingerprint only the stable prefix before mutable runtime state begins. */
export function stableRuntimeContextFingerprint(prompt: string): string | null {
  const mutableStateMarker = "\npreview.status = ";
  const stateIndex = prompt.indexOf(mutableStateMarker);
  if (stateIndex < 0) return null;
  return fingerprint(prompt.slice(0, stateIndex));
}

export interface ToolsListRequestObservation {
  count: number | null;
  status: DiscoveryCountStatus;
}

/** Count tools/list requests with a bounded, explicit observation contract. */
export function observeToolsListRequests(
  message: unknown,
  priorCount = 0,
  bound = TOOLS_LIST_REQUEST_BOUND,
): ToolsListRequestObservation {
  if (!Number.isSafeInteger(priorCount) || priorCount < 0 || priorCount > bound) {
    return { count: null, status: "unknown" };
  }
  const observed = countToolsListMessages(message);
  if (observed === null) return { count: null, status: "unknown" };
  if (priorCount + observed > bound) return { count: null, status: "overflow" };
  return { count: priorCount + observed, status: "bounded" };
}

/** Compatibility helper for callers that only need a bounded count. */
export function countToolsListRequests(message: unknown): number | null {
  return observeToolsListRequests(message).count;
}

function createUsageAccumulators(): Record<UsageScope, UsageAccumulator> {
  return Object.fromEntries(
    USAGE_SCOPES.map((scope) => {
      const summary = emptyScopeSummary(scope);
      return [
        scope,
        {
          scope,
          records: 0,
          duplicateRecords: 0,
          distinctStates: 0,
          distinctIdentities: 0,
          availability: summary.availability,
          counters: emptyCounters(),
          aggregation: summary.aggregation,
          sourceValues: new Set<UsageSource>(),
          mixedSources: false,
          ambiguousMissingIdentity: false,
          seenRequestIdentities: new Set<string>(),
          cumulativeStates: new Map(),
        } satisfies UsageAccumulator,
      ];
    }),
  ) as Record<UsageScope, UsageAccumulator>;
}

/**
 * Summarize saved rollout/event JSON without summing cumulative snapshots.
 * Last-request records are summed only when their request identity is new;
 * cumulative session/app-run scopes retain the latest state for each file.
 */
export function summarizeUsageValue(
  value: unknown,
  source: UsageSummary["source"] = "synthetic-fixture",
  fallbackUsageSource: UsageSource = "unknown",
): UsageSummary {
  const collected = collectUsageCandidates(value, fallbackUsageSource);
  const summary = emptyUsageSummary(source);
  summary.records = collected.candidates.length;
  summary.unsupportedOrAmbiguousRecords = collected.unsupportedOrAmbiguousRecords;
  const accumulators = createUsageAccumulators();

  for (const candidate of collected.candidates) {
    const accumulator = accumulators[candidate.scope];
    accumulator.records += 1;
    if (
      accumulator.sourceValues.size > 0 &&
      !accumulator.sourceValues.has(candidate.source)
    ) {
      accumulator.mixedSources = true;
      summary.unsupportedOrAmbiguousRecords += 1;
    }
    accumulator.sourceValues.add(candidate.source);
    const identity = candidate.identity;
    const identityKey = identity === null ? null : `${candidate.scope}:${identity}`;

    if (candidate.scope === "last-request") {
      if (identityKey === null) {
        accumulator.ambiguousMissingIdentity = true;
        summary.unsupportedOrAmbiguousRecords += 1;
        accumulator.distinctStates += 1;
        continue;
      }
      if (accumulator.seenRequestIdentities.has(identityKey)) {
        accumulator.duplicateRecords += 1;
        continue;
      }
      accumulator.seenRequestIdentities.add(identityKey);
      accumulator.distinctIdentities += 1;
      accumulator.distinctStates += 1;
      accumulator.counters = addCounterValues(accumulator.counters, candidate.counters);
      accumulator.availability = counterAvailability(accumulator.counters);
      continue;
    }

    if (
      candidate.scope === "cumulative-session" ||
      candidate.scope === "app-run" ||
      candidate.scope === "endpoint-window"
    ) {
      if (identityKey === null) {
        accumulator.ambiguousMissingIdentity = true;
        summary.unsupportedOrAmbiguousRecords += 1;
        accumulator.distinctStates += 1;
        continue;
      }
      const stateKey = identityKey;
      const prior = accumulator.cumulativeStates.get(stateKey);
      if (prior !== undefined && countersEqual(prior, candidate.counters)) {
        accumulator.duplicateRecords += 1;
        continue;
      }
      if (prior === undefined) accumulator.distinctIdentities += 1;
      accumulator.cumulativeStates.set(stateKey, candidate.counters);
      accumulator.distinctStates += 1;
      // Keep the newest snapshot for this identity. Never add cumulative
      // snapshots; a multi-identity file is marked ambiguous below.
      continue;
    }

    // Unknown-scope candidates are deliberately not attributed to any known
    // accounting scope; their counters remain unknown in the result.
    accumulator.distinctStates += 1;
  }

  for (const scope of USAGE_SCOPES) {
    const accumulator = accumulators[scope];
    if (accumulator.mixedSources) {
      accumulator.counters = emptyCounters();
      accumulator.availability = "unknown";
      accumulator.aggregation = "ambiguous-mixed-sources";
    }
    if (!accumulator.mixedSources && scope === "last-request" && accumulator.ambiguousMissingIdentity) {
      accumulator.counters = emptyCounters();
      accumulator.availability = "unknown";
      accumulator.aggregation = "ambiguous-missing-identity";
    }
    if (
      !accumulator.mixedSources &&
      (scope === "cumulative-session" ||
        scope === "app-run" ||
        scope === "endpoint-window")
    ) {
      const states = [...accumulator.cumulativeStates.values()];
      if (accumulator.ambiguousMissingIdentity) {
        accumulator.counters = emptyCounters();
        accumulator.availability = "unknown";
        accumulator.aggregation = "ambiguous-missing-identity";
      } else if (states.length === 1) {
        accumulator.counters = { ...states[0]! };
        accumulator.availability = counterAvailability(accumulator.counters);
      } else if (states.length > 1) {
        // A file may contain several independent sessions/runs. Choosing one
        // global latest snapshot would silently attribute the wrong state, so
        // expose the ambiguity instead of inventing an aggregate.
        accumulator.counters = emptyCounters();
        accumulator.availability = "unknown";
        accumulator.aggregation = "ambiguous-multiple-identities";
      }
    }
    const usageSource =
      accumulator.sourceValues.size === 1 && !accumulator.sourceValues.has("unknown")
        ? [...accumulator.sourceValues][0]!
        : "unknown";
    const computedCacheHitRatio = computeCacheHitRatio(accumulator.counters);
    const cacheHitRatio =
      computedCacheHitRatio.status === "invalid-cached-input"
        ? computedCacheHitRatio
        : usageSource === "unknown"
          ? { ratio: null, status: "unknown" as const }
          : computedCacheHitRatio;
    summary.scopes[scope] = {
      scope,
      usageSource,
      records: accumulator.records,
      duplicateRecords: accumulator.duplicateRecords,
      distinctStates: accumulator.distinctStates,
      distinctIdentities: accumulator.distinctIdentities,
      aggregation: accumulator.aggregation,
      availability: accumulator.availability,
      counters: { ...accumulator.counters },
      cacheHitRatio: cacheHitRatio.ratio,
      cacheHitRatioStatus: cacheHitRatio.status,
    };
  }
  const allSources = new Set(
    Object.values(accumulators).flatMap((accumulator) => [...accumulator.sourceValues]),
  );
  summary.usageSource =
    allSources.size === 1 && !allSources.has("unknown")
      ? [...allSources][0]!
      : "unknown";
  return summary;
}

export async function summarizeUsageFile(filePath: string): Promise<UsageSummary> {
  try {
    const text = await readFile(filePath, "utf8");
    try {
      const summary = summarizeUsageValue(JSON.parse(text), "offline-file");
      summary.rawEvidence.records = summary.records;
      return summary;
    } catch {
      const records: unknown[] = [];
      let parseFailures = 0;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          parseFailures += 1;
        }
      }
      const summary = summarizeUsageValue(records, "offline-file");
      summary.unsupportedOrAmbiguousRecords += parseFailures;
      summary.rawEvidence.records = summary.records;
      return summary;
    }
  } catch {
    return emptyUsageSummary("invalid-file");
  }
}

function fixedCapabilityMetadata(): ToolMetadata[] {
  return [
    {
      id: "project.preview.inspect",
      title: "Inspect preview",
      description: "Inspect the current shared preview status.",
      risk: "read",
      requiredPermission: "tool.execute:project.preview.inspect",
    },
  ];
}

function createOfflineSkillService(): SkillService {
  const metadata = fixedCapabilityMetadata();
  const resolver: SkillCapabilityResolver = {
    listMetadata: () => metadata,
    listCapabilities: async (
      agentId: string,
      projectId?: string,
    ): Promise<ToolCapabilitiesView> => ({
      agentId,
      projectId: projectId ?? null,
      tools: metadata.map((tool) => ({
        tool,
        availability: "available",
        reason: "Synthetic capability is available for this report.",
      })),
    }),
  };
  return new SkillService(
    createBuiltInSkillRegistry(),
    resolver,
    new DefaultAuthorizationService(),
  );
}

function runtimeComposer(skillService: SkillService): AgentRuntimePromptComposer {
  return new AgentRuntimePromptComposer(
    () => ({
      getForAgent: async () => ({ status: "running" }),
    }),
    (agent, projectId, runId, orchestrationId) =>
      skillService.runtimeContext(agent, projectId, runId, orchestrationId),
  );
}

function sourceOutput(turn: SharedConversationTurn): string {
  return turn.output;
}

async function measureWorkspaceInstructions(
  root: string,
  agent: Agent,
  skillContext: SkillRuntimeContext | undefined,
): Promise<string> {
  const workspacePath = path.join(root, agent.id);
  await mkdir(workspacePath, { recursive: true });
  const scopedAgent = { ...agent, workspacePath };
  const manager = new WorkspaceManager(root);
  await manager.writeInstructions(scopedAgent, skillContext);
  return readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
}

async function measureProjectInstructions(
  root: string,
  _agent: Agent,
  _skillContext: SkillRuntimeContext | undefined,
): Promise<string> {
  const workspacePath = path.join(root, REPORT_PROJECT.id, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const scopedProject = { ...REPORT_PROJECT, workspacePath };
  const manager = new ProjectWorkspaceManager(root);
  // The shared contract is agent-neutral now, so this side of the transfer no
  // longer varies by Agent or skill assignment. The per-turn identity block it
  // gave up is measured with the runtime prompt, not here.
  await manager.ensureWorkspaceContract(scopedProject);
  return readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
}

async function runOfflineFetch(): Promise<WebFetchResult> {
  const fetcher = new WebFetchAdapter({
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () =>
      new Response(REPORT_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  return fetcher.fetch(REPORT_FETCH_URL);
}

interface McpFixtureResult {
  structured: string;
  compatibility: string;
  wire: string;
  catalogue: Pick<
    TokenContextDiagnostics,
    | "configuredCatalogueSize"
    | "numberOfToolsExposed"
    | "toolsListRequestsObserved"
    | "toolsListRequestBound"
    | "toolsListRequestCountStatus"
    | "discoveryObserved"
    | "authenticatedDiscoveryObserved"
    | "toolSchemaBytes"
    | "toolSchemaEstimatedTokens"
    | "toolSchemaEstimator"
    | "catalogueFingerprint"
  >;
  runId: string;
  runCorrelationStatus: RunCorrelationStatus;
}

async function runMcpFixture(output: WebFetchResult): Promise<McpFixtureResult> {
  const outputDefinition: ToolDefinition = {
    id: "report.fixture.fetch",
    title: "Synthetic fetch fixture",
    description: "Returns a bounded offline fetch result.",
    risk: "read",
    requiredPermission: "tool.execute:web.fetch",
    inputSchema: z.object({}),
    outputSchema: z.object({
      url: z.string(),
      finalUrl: z.string(),
      status: z.number(),
      contentType: z.string(),
      content: z.string(),
    }),
    execute: async () => output,
  };
  const registry = new ToolRegistry([outputDefinition]);
  const toolService = {
    getRegistry: () => registry,
    execute: async () => output,
  } as unknown as ToolService;
  const context: McpSessionContext = {
    principal: agentPrincipal(REPORT_AGENT.id),
    agentId: REPORT_AGENT.id,
    runId: "run-token-report",
    expiresAt: "2026-01-01T00:10:00.000Z",
  };
  const server = createMcpServer(context, toolService);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "token-context-report", version: "1.0.0" });
  let toolsListObservation: ToolsListRequestObservation = {
    count: 0,
    status: "bounded",
  };
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (message, options) => {
    if (toolsListObservation.status === "bounded") {
      toolsListObservation = observeToolsListRequests(
        message,
        toolsListObservation.count ?? 0,
        TOOLS_LIST_REQUEST_BOUND,
      );
    }
    await originalSend(message, options);
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const toolsList = await client.listTools();
    const wireResult = await client.callTool({
      name: outputDefinition.id,
      arguments: {},
    });
    const structured = JSON.stringify(output);
    const compatibility = JSON.stringify(output);
    const serializedToolsList = JSON.stringify(toolsList);
    return {
      structured,
      compatibility,
      wire: JSON.stringify(wireResult),
      runId: context.runId,
      runCorrelationStatus: "synthetic-unverified",
      catalogue: {
        configuredCatalogueSize: registry.list().length,
        numberOfToolsExposed: Array.isArray(toolsList.tools)
          ? toolsList.tools.length
          : null,
        toolsListRequestsObserved: toolsListObservation.count,
        toolsListRequestBound: TOOLS_LIST_REQUEST_BOUND,
        toolsListRequestCountStatus: toolsListObservation.status,
        discoveryObserved:
          toolsListObservation.status === "bounded"
            ? toolsListObservation.count! > 0
            : null,
        authenticatedDiscoveryObserved: null,
        toolSchemaBytes: Buffer.byteLength(serializedToolsList, "utf8"),
        toolSchemaEstimatedTokens: null,
        toolSchemaEstimator: emptyToolSchemaEstimator(),
        catalogueFingerprint: fingerprint(toolsList),
      },
    };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function newScenario(id: string): TokenContextScenario {
  return { id, measurements: [] };
}

function completedConversationTurns(): SharedConversationTurn[] {
  return Array.from({ length: 10 }, (_, index) => ({
    participantId: index % 2 === 0 ? REPORT_PARTICIPANTS[0]!.id : REPORT_PARTICIPANTS[1]!.id,
    agentId: index % 2 === 0 ? REPORT_PARTICIPANTS[0]!.agentId : REPORT_PARTICIPANTS[1]!.agentId,
    position: index % 2,
    stepIndex: index,
    output: `Completed synthetic turn ${index + 1}: preserve the bounded implementation context.`,
    outputTruncated: false,
  }));
}

function deliveryWithAssignedSkillCopy(
  workspaceInstructions: string,
  runtimeSkillLines: string,
  copies: number,
): string {
  return [
    workspaceInstructions,
    ...Array.from({ length: copies }, () => runtimeSkillLines),
  ].join("\n");
}

function supervisorContextWithTurn(
  previousHandoff: NonNullable<SupervisorSelectionContext["previousHandoff"]>,
  turn: SharedConversationTurn,
): SupervisorSelectionContext {
  return {
    sessionId: "session-token-report",
    originalPrompt: REPORT_PROMPTS.supervisor,
    participants: REPORT_PARTICIPANTS,
    participantProfiles: REPORT_PARTICIPANTS.map((participant) => ({
      ...participant,
      name: `Synthetic ${participant.role}`,
      description: `A bounded ${participant.role.toLocaleLowerCase()} participant.`,
    })),
    stepIndex: 1,
    maxSteps: 12,
    previousHandoff,
    recentTurns: [
      {
        participantId: turn.participantId,
        agentId: turn.agentId,
        ...(turn.runId === undefined ? {} : { runId: turn.runId }),
        position: turn.position,
        ...(turn.stepIndex === undefined ? {} : { stepIndex: turn.stepIndex }),
        output: turn.output,
        outputTruncated: turn.outputTruncated,
      },
    ],
  };
}

function runtimeEnvelopeBytes(prompt: string, task: string): number {
  const taskIndex = prompt.indexOf(task);
  if (taskIndex < 0) return measureText(prompt).utf8Bytes;
  return measureText(prompt.slice(0, taskIndex) + prompt.slice(taskIndex + task.length)).utf8Bytes;
}

function buildOfflineDiagnostics(
  freshPrompt: string,
  catalogue: McpFixtureResult["catalogue"],
  runId: string,
  runCorrelationStatus: RunCorrelationStatus,
): TokenContextDiagnostics {
  return {
    runId,
    runCorrelationStatus,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    usageSource: "unknown",
    usageScope: "unknown",
    ...catalogue,
    rawTaskBytes: measureText(REPORT_PROMPTS.fresh).utf8Bytes,
    rawRuntimeEnvelopeBytes: runtimeEnvelopeBytes(freshPrompt, REPORT_PROMPTS.fresh),
    stableContextFingerprint: stableRuntimeContextFingerprint(freshPrompt),
    runtimeVersion: null,
    providerId: null,
    modelId: null,
    freshness: "fresh",
    fallbackStatus: "not-used",
  };
}

export async function buildOfflineTokenContextReport(): Promise<OfflineTokenContextReport> {
  const skillService = createOfflineSkillService();
  const noSkillContext = await skillService.runtimeContext(REPORT_AGENT);
  const skillContext = await skillService.runtimeContext(REPORT_AGENT_WITH_SKILL);
  const composer = runtimeComposer(skillService);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "lqam-token-context-"));
  const scenarios: TokenContextScenario[] = [];
  const deliveryComparisons: DeliveryComparison[] = [];

  try {
    const fresh = newScenario("fresh-message-no-skills");
    const freshPrompt = await composer.compose(
      REPORT_AGENT,
      REPORT_PROMPTS.fresh,
      null,
    );
    addMeasurement(
      fresh,
      "raw-user-message-to-runtime-envelope",
      REPORT_PROMPTS.fresh,
      freshPrompt,
      "Runtime envelope added around a fresh private request.",
    );
    scenarios.push(fresh);

    const assigned = newScenario("assigned-skill");
    const skillBody = skillContext.skills.map((skill) => skill.instructions).join("\n");
    const runtimeSkillLines = skillContext.lines.join("\n");
    const assignedPrompt = await composer.compose(
      REPORT_AGENT_WITH_SKILL,
      REPORT_PROMPTS.assignedSkill,
      null,
    );
    const assignedPrivateInstructions = await measureWorkspaceInstructions(
      temporaryRoot,
      REPORT_AGENT_WITH_SKILL,
      skillContext,
    );
    addMeasurement(
      assigned,
      "skill-body-to-runtime-skill-lines",
      skillBody,
      runtimeSkillLines,
      "Skill body versus the bounded runtime representation returned by SkillService.",
    );
    addMeasurement(
      assigned,
      "agent-instructions-to-private-workspace-instructions",
      REPORT_AGENT_WITH_SKILL.instructions,
      assignedPrivateInstructions,
      "WorkspaceManager.writeInstructions output; this is app-owned file text, not a model token count.",
    );
    addMeasurement(
      assigned,
      "raw-user-message-to-skilled-runtime-envelope",
      REPORT_PROMPTS.assignedSkill,
      assignedPrompt,
      "Runtime envelope includes one assigned skill projection and capability state.",
    );
    deliveryComparisons.push(
      compareDelivery(
        "assigned-skill",
        "synthetic-legacy-duplicate-to-canonical-current-delivery",
        deliveryWithAssignedSkillCopy(assignedPrivateInstructions, runtimeSkillLines, 2),
        deliveryWithAssignedSkillCopy(assignedPrivateInstructions, runtimeSkillLines, 1),
        "Synthetic legacy delivery repeats the current SkillService projection in the workspace and runtime; canonical delivery keeps the current workspace builder plus one runtime projection.",
      ),
    );
    scenarios.push(assigned);

    const privateWorkspace = newScenario("private-workspace");
    const privatePrompt = await composer.compose(
      REPORT_AGENT,
      REPORT_PROMPTS.fresh,
      null,
    );
    const privateInstructions = await measureWorkspaceInstructions(
      temporaryRoot,
      REPORT_AGENT,
      noSkillContext,
    );
    addMeasurement(
      privateWorkspace,
      "private-workspace-instructions",
      REPORT_AGENT.instructions,
      privateInstructions,
      "Private Agent workspace instruction file composed through WorkspaceManager.",
    );
    addMeasurement(
      privateWorkspace,
      "private-runtime-envelope",
      REPORT_PROMPTS.fresh,
      privatePrompt,
      "Private runtime uses the Agent preview context provider seam.",
    );
    scenarios.push(privateWorkspace);

    const projectWorkspace = newScenario("project-workspace");
    const projectBinding = {
      projectId: REPORT_PROJECT.id,
      projectName: REPORT_PROJECT.name,
      workspacePath: path.join(temporaryRoot, "project-token-report", "workspace"),
      codexThreadId: null,
      previewStatus: "running" as const,
    };
    const projectPrompt = await composer.compose(
      REPORT_AGENT_WITH_SKILL,
      REPORT_PROMPTS.project,
      projectBinding,
      REPORT_PROJECT.id,
      "run-token-report-project",
    );
    const projectInstructions = await measureProjectInstructions(
      temporaryRoot,
      REPORT_AGENT_WITH_SKILL,
      skillContext,
    );
    addMeasurement(
      projectWorkspace,
      "project-workspace-instructions",
      REPORT_PROJECT.description,
      projectInstructions,
      "ProjectWorkspaceManager shared workspace contract (agent-neutral).",
    );
    addMeasurement(
      projectWorkspace,
      "project-runtime-envelope",
      REPORT_PROMPTS.project,
      projectPrompt,
      "Project binding contributes projectRuntimeContextLines and uses project preview state.",
    );
    addMeasurement(
      projectWorkspace,
      "project-runtime-lines",
      projectRuntimeContextLines(projectBinding).join("\n"),
      projectPrompt,
      "Project lines are measured separately from the raw request for comparison only.",
    );
    scenarios.push(projectWorkspace);

    const handoff = newScenario("two-participant-handoff");
    const legacyPreviousTurn = {
      participantId: REPORT_PARTICIPANTS[0]!.id,
      agentId: REPORT_PARTICIPANTS[0]!.agentId,
      position: REPORT_PARTICIPANTS[0]!.position,
      stepIndex: 0,
      output: "Planner completed the bounded design and identified the next implementation step.",
      outputTruncated: false,
    } satisfies SharedConversationTurn;
    const canonicalPreviousTurn = {
      ...legacyPreviousTurn,
      runId: "run-token-report-handoff",
    } satisfies SharedConversationTurn;
    const handoffSource: HandoffSource = {
      sourceParticipantId: legacyPreviousTurn.participantId,
      sourceAgentId: legacyPreviousTurn.agentId,
      sourceRunId: "run-token-report-handoff",
      content: sourceOutput(legacyPreviousTurn),
    };
    const legacyHandoffResult = buildHandoffPrompt({
      originalPrompt: REPORT_PROMPTS.handoff,
      participant: {
        id: REPORT_PARTICIPANTS[1]!.id,
        agentId: REPORT_PARTICIPANTS[1]!.agentId,
        role: REPORT_PARTICIPANTS[1]!.role,
        position: REPORT_PARTICIPANTS[1]!.position,
      },
      recentTurns: [legacyPreviousTurn],
      previous: handoffSource,
    });
    const canonicalHandoffResult = buildHandoffPrompt({
      originalPrompt: REPORT_PROMPTS.handoff,
      participant: {
        id: REPORT_PARTICIPANTS[1]!.id,
        agentId: REPORT_PARTICIPANTS[1]!.agentId,
        role: REPORT_PARTICIPANTS[1]!.role,
        position: REPORT_PARTICIPANTS[1]!.position,
      },
      recentTurns: [canonicalPreviousTurn],
      previous: handoffSource,
    });
    if (canonicalHandoffResult.envelope === null) {
      throw new Error("Synthetic handoff did not produce an envelope");
    }
    addMeasurement(
      handoff,
      "source-output-to-worker-handoff-prompt",
      handoffSource.content,
      canonicalHandoffResult.prompt,
      "Two-participant handoff through buildHandoffPrompt; output remains bounded and untrusted.",
    );
    addMeasurement(
      handoff,
      "source-output-to-handoff-envelope",
      handoffSource.content,
      canonicalHandoffResult.envelope.content,
      "createHandoffEnvelope output is measured separately from the rendered prompt.",
    );
    deliveryComparisons.push(
      compareDelivery(
        "two-participant-handoff",
        "same-run-legacy-no-runId-duplicate-to-runId-dedup",
        legacyHandoffResult.prompt,
        canonicalHandoffResult.prompt,
        "Both prompts use the same task, participants, source output, and public buildHandoffPrompt renderer; only the reliable runId on the shared turn changes.",
      ),
    );
    scenarios.push(handoff);

    const completed = newScenario("longer-completed-conversation");
    const turns = completedConversationTurns();
    const completedPrompt = buildHandoffPrompt({
      originalPrompt: REPORT_PROMPTS.completedConversation,
      participant: {
        id: REPORT_PARTICIPANTS[0]!.id,
        agentId: REPORT_PARTICIPANTS[0]!.agentId,
        role: REPORT_PARTICIPANTS[0]!.role,
        position: REPORT_PARTICIPANTS[0]!.position,
      },
      contextTurns: turns,
      recentTurns: [],
    });
    addMeasurement(
      completed,
      "completed-turns-to-worker-handoff-prompt",
      turns.map((turn) => turn.output).join("\n"),
      completedPrompt.prompt,
      "Ten completed synthetic turns exercise the bounded recent shared conversation projection.",
    );

    const supervisorContext: SupervisorSelectionContext = {
      sessionId: "session-token-report",
      originalPrompt: REPORT_PROMPTS.supervisor,
      participants: REPORT_PARTICIPANTS,
      participantProfiles: REPORT_PARTICIPANTS.map((participant) => ({
        ...participant,
        name: `Synthetic ${participant.role}`,
        description: `A bounded ${participant.role.toLocaleLowerCase()} participant.`,
      })),
      stepIndex: turns.length,
      maxSteps: 12,
      previousHandoff: canonicalHandoffResult.envelope,
      recentTurns: turns.map((turn) => ({
        participantId: turn.participantId,
        agentId: turn.agentId,
        position: turn.position,
        ...(turn.stepIndex === undefined ? {} : { stepIndex: turn.stepIndex }),
        output: turn.output,
        outputTruncated: turn.outputTruncated,
      })),
    };
    const supervisorPrompt = buildSupervisorPrompt(supervisorContext);
    addMeasurement(
      completed,
      "supervisor-context-to-supervisor-prompt",
      JSON.stringify(supervisorContext),
      supervisorPrompt,
      "Supervisor prompt uses sanitized roster, bounded history, and explicit untrusted-data boundaries.",
    );
    const legacySupervisorPrompt = buildSupervisorPrompt(
      supervisorContextWithTurn(canonicalHandoffResult.envelope, legacyPreviousTurn),
    );
    const canonicalSupervisorPrompt = buildSupervisorPrompt(
      supervisorContextWithTurn(canonicalHandoffResult.envelope, canonicalPreviousTurn),
    );
    deliveryComparisons.push(
      compareDelivery(
        "longer-completed-conversation",
        "same-run-supervisor-legacy-no-runId-duplicate-to-runId-dedup",
        legacySupervisorPrompt,
        canonicalSupervisorPrompt,
        "Both prompts use the same previous handoff and roster through buildSupervisorPrompt; the run-aware shared turn is omitted as a duplicate while the legacy turn is retained.",
      ),
    );
    scenarios.push(completed);

    const htmlFetch = newScenario("html-fetch-result-and-mcp-serialization");
    const fetchResult = await runOfflineFetch();
    const mcp = await runMcpFixture(fetchResult);
    addMeasurement(
      htmlFetch,
      "html-body-to-web-fetch-result",
      REPORT_HTML,
      JSON.stringify(fetchResult),
      "WebFetchAdapter exercised with an injected in-memory response; no network request is made.",
    );
    addMeasurement(
      htmlFetch,
      "logical-result-to-mcp-structured-content",
      JSON.stringify(REPORT_MCP_OUTPUT),
      mcp.structured,
      "Structured MCP output fixture; source URL/content are not emitted by this report.",
    );
    addMeasurement(
      htmlFetch,
      "logical-result-to-mcp-compatibility-text",
      JSON.stringify(REPORT_MCP_OUTPUT),
      mcp.compatibility,
      "Compatibility text is the JSON string representation returned beside structured content.",
    );
    addMeasurement(
      htmlFetch,
      "logical-result-to-mcp-wire-result",
      JSON.stringify(REPORT_MCP_OUTPUT),
      mcp.wire,
      "MCP Client/InMemoryTransport fixture measures the actual SDK wire result without a network call.",
    );
    scenarios.push(htmlFetch);

    const diagnostics = buildOfflineDiagnostics(
      freshPrompt,
      mcp.catalogue,
      mcp.runId,
      mcp.runCorrelationStatus,
    );
    return {
      version: TOKEN_CONTEXT_REPORT_VERSION,
      units: {
        characters: "unicode-code-points",
        utf8Bytes: "utf8-byte-count",
        tokenCounts: "reported-counters-only",
      },
      scenarios,
      deliveryComparisons,
      diagnostics,
      usage: summarizeUsageValue(REPORT_USAGE_EVENTS),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function markdownCell(value: number | string): string {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatTokenContextReportMarkdown(
  report: OfflineTokenContextReport,
): string {
  const lines = [
    "# Offline token-context baseline",
    "",
    "This report measures app-owned payload sizes from deterministic synthetic fixtures. Character and UTF-8 byte counts are payload measurements, not exact model tokens or billing values.",
    "",
    "## Diagnostics",
    "",
    `Fixture run: ${report.diagnostics.runId ?? "unknown"}; correlation: ${report.diagnostics.runCorrelationStatus}; authenticated discovery: ${report.diagnostics.authenticatedDiscoveryObserved === null ? "pending" : report.diagnostics.authenticatedDiscoveryObserved}; usage source/scope: ${report.diagnostics.usageSource} / ${report.diagnostics.usageScope}; runtime/provider/model: ${report.diagnostics.runtimeVersion ?? "unknown"} / ${report.diagnostics.providerId ?? "unknown"} / ${report.diagnostics.modelId ?? "unknown"}; freshness: ${report.diagnostics.freshness}; fallback: ${report.diagnostics.fallbackStatus}.`,
    "",
    `Catalogue: configured ${report.diagnostics.configuredCatalogueSize ?? "unknown"}; exposed ${report.diagnostics.numberOfToolsExposed ?? "unknown"}; observed tools/list requests ${report.diagnostics.toolsListRequestsObserved ?? "unknown"}/${report.diagnostics.toolsListRequestBound} (${report.diagnostics.toolsListRequestCountStatus}); local discovery observed ${report.diagnostics.discoveryObserved === null ? "unknown" : report.diagnostics.discoveryObserved}; schema UTF-8 bytes ${report.diagnostics.toolSchemaBytes ?? "unknown"}; estimated tokens ${report.diagnostics.toolSchemaEstimatedTokens ?? "unknown"}.`,
    "",
    `Estimator: ${report.diagnostics.toolSchemaEstimator.identity ?? "unknown"} ${report.diagnostics.toolSchemaEstimator.version ?? ""}`.trim() + `; approximate: ${report.diagnostics.toolSchemaEstimator.approximate === null ? "unknown" : report.diagnostics.toolSchemaEstimator.approximate}.`,
    "",
    `Raw task UTF-8 bytes: ${report.diagnostics.rawTaskBytes ?? "unknown"}; raw runtime-envelope UTF-8 bytes: ${report.diagnostics.rawRuntimeEnvelopeBytes ?? "unknown"}; stable-context fingerprint: ${report.diagnostics.stableContextFingerprint ?? "unknown"}; catalogue fingerprint: ${report.diagnostics.catalogueFingerprint ?? "unknown"}.`,
    "",
    "## Before/after payload table",
    "",
    "This composition table measures the logical input at each named boundary against the composed or serialized payload. It is not a pre-change/post-change comparison. No model or network call is used.",
    "",
    "| Scenario | Boundary | Before chars | Before UTF-8 bytes | After chars | After UTF-8 bytes | Delta chars | Delta UTF-8 bytes |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of report.scenarios) {
    for (const measurement of scenario.measurements) {
      lines.push(
        `| ${markdownCell(scenario.id)} | ${markdownCell(measurement.boundary)} | ${measurement.before.characters} | ${measurement.before.utf8Bytes} | ${measurement.after.characters} | ${measurement.after.utf8Bytes} | ${measurement.delta.characters} | ${measurement.delta.utf8Bytes} |`,
      );
    }
  }
  lines.push(
    "",
    "## Comparable before/after delivery reductions",
    "",
    "These rows compare the same public builders with only the delivery variant changed. `Legacy` retains the duplicate; `Canonical` uses the current run-aware or single-delivery path. Reductions are payload characters/bytes only, not model tokens or billing savings.",
    "",
    "| Scenario | Delivery comparison | Legacy chars | Legacy UTF-8 bytes | Canonical chars | Canonical UTF-8 bytes | Reduction chars | Reduction UTF-8 bytes |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const comparison of report.deliveryComparisons) {
    lines.push(
      `| ${markdownCell(comparison.scenario)} | ${markdownCell(comparison.boundary)} | ${comparison.before.characters} | ${comparison.before.utf8Bytes} | ${comparison.after.characters} | ${comparison.after.utf8Bytes} | ${comparison.reduction.characters} | ${comparison.reduction.utf8Bytes} |`,
    );
  }
  lines.push(
    "",
    "Comparison notes:",
    "",
    ...report.deliveryComparisons.map(
      (comparison) => `- ${markdownCell(comparison.boundary)}: ${comparison.note}`,
    ),
    "",
    "## Usage input contract",
    "",
    `Source: ${report.usage.source}; usage source: ${report.usage.usageSource}; parsed candidate records: ${report.usage.records}; unsupported/ambiguous records: ${report.usage.unsupportedOrAmbiguousRecords}; raw runtime evidence: ${report.usage.rawEvidence.status} (${report.usage.rawEvidence.records ?? "unknown"} records, path ${report.usage.rawEvidence.path ?? "pending"}).`,
    "",
    "| Scope | Usage source | Records | Duplicate records | Distinct states | Distinct identities | Aggregation | Availability | Input | Cached input | Output | Cache-hit ratio | Ratio status |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const scope of USAGE_SCOPES) {
    const item = report.usage.scopes[scope];
    lines.push(
      `| ${scope} | ${item.usageSource} | ${item.records} | ${item.duplicateRecords} | ${item.distinctStates} | ${item.distinctIdentities} | ${item.aggregation} | ${item.availability} | ${item.counters.inputTokens ?? "unknown"} | ${item.counters.cachedInputTokens ?? "unknown"} | ${item.counters.outputTokens ?? "unknown"} | ${item.cacheHitRatio ?? "unknown"} | ${item.cacheHitRatioStatus} |`,
    );
  }
  lines.push(
    "",
    "## Interpretation and limits",
    "",
    "- Cached input is reported as its own counter and is not added to input tokens.",
    "- Repeated cumulative session/app-run snapshots are deduplicated per identity and never summed; files with multiple identity streams remain explicitly unknown.",
    "- Scope is not inferred from event names. Missing identity or provenance leaves the affected accounting and cache-hit ratio unknown; endpoint-window totals are cross-checks, not per-run usage.",
    "- Tool schema bytes are the actual SDK tools/list JSON serialization including advertised metadata. No documented token estimator is available in this offline fixture, so estimated tokens remain unknown.",
    "- The MCP fixture uses a direct in-memory server context; it is not an authenticated MCP route exercise. Authenticated discovery correlation and sanitized raw runtime evidence capture remain pending.",
    "- Comparable reductions demonstrate duplicate-delivery payload changes only; they do not prove equivalent model behavior, provider billing, or a percentage saving.",
    "- Codex base instructions, cache conditions, resumed history, and provider-side tokenization are outside this offline measurement.",
    "- Live BytePlus token/cache validation is pending; no paid or live provider call is made by this report.",
    "",
  );
  return lines.join("\n");
}

export function formatTokenContextReportJson(report: OfflineTokenContextReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

interface CliOptions {
  usageFile: string | null;
  format: "json" | "markdown";
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let usageFile: string | null = null;
  let format: CliOptions["format"] = "markdown";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--markdown") {
      format = "markdown";
      continue;
    }
    if (arg === "--usage-file") {
      usageFile = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--usage-file=")) {
      usageFile = arg.slice("--usage-file=".length) || null;
    }
  }
  return { usageFile, format };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(args);
  const report = await buildOfflineTokenContextReport();
  if (options.usageFile !== null) report.usage = await summarizeUsageFile(options.usageFile);
  process.stdout.write(
    options.format === "json"
      ? formatTokenContextReportJson(report)
      : formatTokenContextReportMarkdown(report),
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  await main();
}
