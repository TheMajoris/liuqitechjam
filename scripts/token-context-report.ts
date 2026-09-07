import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentPrincipal } from "../apps/server/src/access/access-types.js";
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
import type { McpSessionContext } from "../apps/server/src/tools/mcp-session-service.js";
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

export const TOKEN_CONTEXT_REPORT_VERSION = 1 as const;

export type UsageScope =
  | "last-request"
  | "cumulative-session"
  | "app-run"
  | "unknown";

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

export interface UsageScopeSummary {
  scope: UsageScope;
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
    | "unknown";
  availability: UsageAvailability;
  counters: UsageCounters;
}

export interface UsageSummary {
  source: "none" | "synthetic-fixture" | "offline-file" | "invalid-file";
  /** Parsed candidate records, excluding arbitrary text and unsupported objects. */
  records: number;
  unsupportedOrAmbiguousRecords: number;
  scopes: Record<UsageScope, UsageScopeSummary>;
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
]);

const USAGE_SCOPES: readonly UsageScope[] = [
  "last-request",
  "cumulative-session",
  "app-run",
  "unknown",
];

interface UsageCandidate {
  scope: UsageScope;
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

function emptyScopeSummary(scope: UsageScope): UsageScopeSummary {
  return {
    scope,
    records: 0,
    duplicateRecords: 0,
    distinctStates: 0,
    distinctIdentities: 0,
    aggregation:
      scope === "last-request"
        ? "sum-distinct-requests"
        : scope === "cumulative-session" || scope === "app-run"
          ? "latest-cumulative-state"
          : "unknown",
    availability: "unknown",
    counters: emptyCounters(),
  };
}

function emptyUsageSummary(source: UsageSummary["source"] = "none"): UsageSummary {
  return {
    source,
    records: 0,
    unsupportedOrAmbiguousRecords: 0,
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
  if (parent.type === "turn.completed") return "last-request";
  if (parent.type === "turn.failed") return "last-request";
  if (parent.type === "model_turn") return "app-run";
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
    parent.event_id,
    parent.eventId,
    parent.id,
    payload.request_id,
    payload.requestId,
    payload.session_id,
    payload.sessionId,
    payload.run_id,
    payload.runId,
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
): UsageCandidate | null {
  const counters = readCounters(payload);
  if (!counters.hasCounter) return null;
  return {
    scope: inferScope(parent, payload),
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
function collectUsageCandidates(value: unknown): CandidateCollection {
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
        const candidate = candidateFor(parent, usage, eventIndex++);
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
        );
        if (candidate && candidate.hasCounter) candidates.push(candidate);
        else unsupportedOrAmbiguousRecords += 1;
        continue;
      }
      if (key === "usage") continue;
      visit(nested);
    }

    // Support a saved event represented directly as {scope, input_tokens, ...}.
    const direct = candidateFor(parent, parent, eventIndex++);
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
  return {
    inputTokens:
      left.inputTokens === null || right.inputTokens === null
        ? left.inputTokens ?? right.inputTokens
        : left.inputTokens + right.inputTokens,
    cachedInputTokens:
      left.cachedInputTokens === null || right.cachedInputTokens === null
        ? left.cachedInputTokens ?? right.cachedInputTokens
        : left.cachedInputTokens + right.cachedInputTokens,
    outputTokens:
      left.outputTokens === null || right.outputTokens === null
        ? left.outputTokens ?? right.outputTokens
        : left.outputTokens + right.outputTokens,
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
): UsageSummary {
  const collected = collectUsageCandidates(value);
  const summary = emptyUsageSummary(source);
  summary.records = collected.candidates.length;
  summary.unsupportedOrAmbiguousRecords = collected.unsupportedOrAmbiguousRecords;
  const accumulators = createUsageAccumulators();

  for (const candidate of collected.candidates) {
    const accumulator = accumulators[candidate.scope];
    accumulator.records += 1;
    const identity = candidate.identity;
    const identityKey = identity === null ? null : `${candidate.scope}:${identity}`;

    if (candidate.scope === "last-request") {
      if (identityKey !== null && accumulator.seenRequestIdentities.has(identityKey)) {
        accumulator.duplicateRecords += 1;
        continue;
      }
      if (identityKey !== null) {
        accumulator.seenRequestIdentities.add(identityKey);
        accumulator.distinctIdentities += 1;
      }
      accumulator.distinctStates += 1;
      accumulator.counters = addCounterValues(accumulator.counters, candidate.counters);
      accumulator.availability = counterAvailability(accumulator.counters);
      continue;
    }

    if (candidate.scope === "cumulative-session" || candidate.scope === "app-run") {
      const stateKey = identityKey ?? `${candidate.scope}:unidentified`;
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
    if (scope === "cumulative-session" || scope === "app-run") {
      const states = [...accumulator.cumulativeStates.values()];
      if (states.length === 1) {
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
    summary.scopes[scope] = {
      scope,
      records: accumulator.records,
      duplicateRecords: accumulator.duplicateRecords,
      distinctStates: accumulator.distinctStates,
      distinctIdentities: accumulator.distinctIdentities,
      aggregation: accumulator.aggregation,
      availability: accumulator.availability,
      counters: { ...accumulator.counters },
    };
  }
  return summary;
}

export async function summarizeUsageFile(filePath: string): Promise<UsageSummary> {
  try {
    const text = await readFile(filePath, "utf8");
    try {
      return summarizeUsageValue(JSON.parse(text), "offline-file");
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
  return new SkillService(createBuiltInSkillRegistry(), resolver);
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

async function runMcpFixture(output: WebFetchResult): Promise<{
  structured: string;
  compatibility: string;
  wire: string;
}> {
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
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const wireResult = await client.callTool({
      name: outputDefinition.id,
      arguments: {},
    });
    const structured = JSON.stringify(output);
    const compatibility = JSON.stringify(output);
    return {
      structured,
      compatibility,
      wire: JSON.stringify(wireResult),
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
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return {
    version: TOKEN_CONTEXT_REPORT_VERSION,
    units: {
      characters: "unicode-code-points",
      utf8Bytes: "utf8-byte-count",
      tokenCounts: "reported-counters-only",
    },
    scenarios,
    deliveryComparisons,
    usage: summarizeUsageValue(REPORT_USAGE_EVENTS),
  };
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
    `Source: ${report.usage.source}; parsed candidate records: ${report.usage.records}; unsupported/ambiguous records: ${report.usage.unsupportedOrAmbiguousRecords}.`,
    "",
    "| Scope | Records | Duplicate records | Distinct states | Distinct identities | Aggregation | Availability | Input | Cached input | Output |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |",
  );
  for (const scope of USAGE_SCOPES) {
    const item = report.usage.scopes[scope];
    lines.push(
      `| ${scope} | ${item.records} | ${item.duplicateRecords} | ${item.distinctStates} | ${item.distinctIdentities} | ${item.aggregation} | ${item.availability} | ${item.counters.inputTokens ?? "unknown"} | ${item.counters.cachedInputTokens ?? "unknown"} | ${item.counters.outputTokens ?? "unknown"} |`,
    );
  }
  lines.push(
    "",
    "## Interpretation and limits",
    "",
    "- Cached input is reported as its own counter and is not added to input tokens.",
    "- Repeated cumulative session/app-run snapshots are deduplicated per identity and never summed; files with multiple identity streams remain explicitly unknown.",
    "- Comparable reductions demonstrate duplicate-delivery payload changes only; they do not prove equivalent model behavior, provider billing, or a percentage saving.",
    "- Codex base instructions, cache conditions, resumed history, and provider-side tokenization are outside this offline measurement.",
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
