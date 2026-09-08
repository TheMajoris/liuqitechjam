import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentPrincipal } from "../access/access-types.js";
import { agentPrincipal } from "../access/access-types.js";
import { DEFAULT_MCP_TOKEN_TTL_MS } from "../config.js";
import { WEB_TOOL_PERMISSION_DENIED } from "../errors.js";
import type { AuditRecorder } from "../audit/audit-types.js";

export const MCP_BEARER_TOKEN_ENV = "LAUNCHPAD_MCP_BEARER_TOKEN";

/** Bounded observation state kept for one in-memory run/session. */
export const MCP_TOOLS_LIST_REQUEST_BOUND = 32;

/** Classify JSON-RPC tools/list messages without retaining their contents. */
export function countToolsListMessages(message: unknown): number | null {
  const messages = Array.isArray(message) ? message : [message];
  let count = 0;
  for (const item of messages) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    if ((item as { method?: unknown }).method === "tools/list") count += 1;
  }
  return count;
}

export type McpSessionResolutionStatus = "scoped" | "legacy-full" | "failed";
export type McpToolsListRequestCountStatus =
  | "not-observed"
  | "observed"
  | "capped"
  | "unknown";

export interface McpSessionDiagnostics {
  readonly configuredCatalogueSize?: number;
  readonly advertisedToolCount?: number;
  readonly resolutionStatus?: McpSessionResolutionStatus;
  readonly toolsListRequestsObserved?: number;
  readonly toolsListRequestBound?: number;
  readonly toolsListRequestCountStatus?: McpToolsListRequestCountStatus;
}

export interface McpSessionContext {
  readonly principal: AgentPrincipal;
  readonly agentId: string;
  readonly projectId?: string;
  readonly runId: string;
  readonly orchestrationId?: string;
  readonly traceparent?: string;
  readonly expiresAt: string;
  /** Undefined means legacy full advertisement; [] is an explicit empty snapshot. */
  readonly advertisedToolIds?: readonly string[];
  /** Non-secret catalogue facts; raw requests and transport headers never enter this object. */
  readonly diagnostics?: Readonly<McpSessionDiagnostics>;
}

type SessionRecord = Omit<McpSessionContext, "diagnostics"> & {
  diagnostics?: McpSessionDiagnostics;
  tokenHash: string;
  revokedAt?: string;
  /** Set once an expiry event has been emitted so prune/resolve never double-report. */
  expiryReported?: boolean;
};

export interface McpSessionServiceOptions {
  audit?: AuditRecorder;
  now?: () => number;
}

export type ResolveMcpSessionResult =
  | { context: McpSessionContext }
  | { context: null; reason: "missing" | "invalid" | "expired" };

export interface MintMcpSessionInput {
  agentId: string;
  projectId?: string;
  runId: string;
  orchestrationId?: string;
  traceparent?: string;
  /** Omitted preserves the legacy full catalogue; an empty array is fail-closed. */
  advertisedToolIds?: readonly string[];
  diagnostics?: McpSessionDiagnostics;
}

export interface MintedMcpSession {
  token: string;
  context: McpSessionContext;
}

export type McpWebToolDenialCode = typeof WEB_TOOL_PERMISSION_DENIED;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function cloneAdvertisedToolIds(
  ids: readonly string[] | undefined,
): readonly string[] | undefined {
  if (ids === undefined) return undefined;
  const seen = new Set<string>();
  const cloned: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    cloned.push(id);
  }
  return Object.freeze(cloned);
}

function cloneDiagnostics(
  diagnostics: McpSessionDiagnostics | undefined,
): Readonly<McpSessionDiagnostics> | undefined {
  if (diagnostics === undefined) return undefined;
  const cloned = normalizeDiagnostics(diagnostics);
  return cloned === undefined ? undefined : Object.freeze(cloned);
}

function normalizeDiagnostics(
  diagnostics: McpSessionDiagnostics | undefined,
): McpSessionDiagnostics | undefined {
  if (diagnostics === undefined) return undefined;
  const configuredCatalogueSize = nonnegativeSafeInteger(diagnostics.configuredCatalogueSize);
  const advertisedToolCount = nonnegativeSafeInteger(diagnostics.advertisedToolCount);
  const rawToolsListRequestsObserved = nonnegativeSafeInteger(diagnostics.toolsListRequestsObserved);
  const toolsListRequestsObserved = rawToolsListRequestsObserved === undefined
    ? undefined
    : Math.min(rawToolsListRequestsObserved, MCP_TOOLS_LIST_REQUEST_BOUND);
  const resolutionStatus = diagnostics.resolutionStatus;
  const toolsListRequestCountStatus = diagnostics.toolsListRequestCountStatus;
  return {
    ...(configuredCatalogueSize === undefined ? {} : { configuredCatalogueSize }),
    ...(advertisedToolCount === undefined ? {} : { advertisedToolCount }),
    ...(resolutionStatus === "scoped" || resolutionStatus === "legacy-full" || resolutionStatus === "failed"
      ? { resolutionStatus }
      : {}),
    ...(toolsListRequestsObserved === undefined
      ? {}
      : {
          toolsListRequestsObserved,
          toolsListRequestBound: MCP_TOOLS_LIST_REQUEST_BOUND,
          toolsListRequestCountStatus:
            rawToolsListRequestsObserved !== undefined &&
            rawToolsListRequestsObserved > MCP_TOOLS_LIST_REQUEST_BOUND
              ? "capped" as const
              : toolsListRequestCountStatus === "not-observed" ||
                  toolsListRequestCountStatus === "observed" ||
                  toolsListRequestCountStatus === "capped" ||
                  toolsListRequestCountStatus === "unknown"
                ? toolsListRequestCountStatus
                : "observed" as const,
        }),
    ...(toolsListRequestsObserved === undefined &&
    (toolsListRequestCountStatus === "not-observed" ||
      toolsListRequestCountStatus === "observed" ||
      toolsListRequestCountStatus === "capped" ||
      toolsListRequestCountStatus === "unknown")
      ? {
          toolsListRequestBound: MCP_TOOLS_LIST_REQUEST_BOUND,
          toolsListRequestCountStatus,
        }
      : {}),
  };
}

function contextFromRecord(record: SessionRecord): McpSessionContext {
  const advertisedToolIds = record.advertisedToolIds === undefined
    ? undefined
    : cloneAdvertisedToolIds(record.advertisedToolIds);
  const diagnostics = record.diagnostics === undefined
    ? undefined
    : cloneDiagnostics(record.diagnostics);
  return Object.freeze({
    principal: { ...record.principal },
    agentId: record.agentId,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    runId: record.runId,
    ...(record.orchestrationId === undefined ? {} : { orchestrationId: record.orchestrationId }),
    ...(record.traceparent === undefined ? {} : { traceparent: record.traceparent }),
    expiresAt: record.expiresAt,
    ...(advertisedToolIds === undefined ? {} : { advertisedToolIds }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}

/** In-memory opaque bearer sessions scoped to one Agent run. */
export class McpSessionService {
  private readonly sessions = new Map<string, SessionRecord>();
  /** Terminal web denial state survives token expiry until the owning Run ends. */
  private readonly webToolDenials = new Map<string, McpWebToolDenialCode>();
  private readonly ttlMs: number;
  private readonly audit?: AuditRecorder;
  private readonly now: () => number;

  constructor(ttlMs = DEFAULT_MCP_TOKEN_TTL_MS, options: McpSessionServiceOptions = {}) {
    this.ttlMs = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_MCP_TOKEN_TTL_MS;
    if (options.audit !== undefined) this.audit = options.audit;
    this.now = options.now ?? Date.now;
  }

  private emit(input: Parameters<AuditRecorder["record"]>[0]): void {
    if (!this.audit) return;
    try {
      void this.audit.record(input).catch((error) => console.warn("audit write failed", error));
    } catch (error) {
      console.warn("audit write failed", error);
    }
  }

  mint(input: MintMcpSessionInput): MintedMcpSession {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + this.ttlMs).toISOString();
    const tokenHash = hashToken(token);
    const advertisedToolIds = cloneAdvertisedToolIds(input.advertisedToolIds);
    const diagnostics = normalizeDiagnostics(input.diagnostics);
    const record: SessionRecord = {
      principal: agentPrincipal(input.agentId),
      agentId: input.agentId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      runId: input.runId,
      ...(input.orchestrationId === undefined ? {} : { orchestrationId: input.orchestrationId }),
      ...(input.traceparent === undefined ? {} : { traceparent: input.traceparent }),
      expiresAt,
      ...(advertisedToolIds === undefined ? {} : { advertisedToolIds }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      tokenHash,
    };
    this.sessions.set(tokenHash, record);
    this.emit({
      type: "mcp_session_issued",
      status: "success",
      summary: "MCP session issued",
      principal: record.principal,
      agentId: record.agentId,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      runId: record.runId,
      ...(record.orchestrationId === undefined ? {} : { orchestrationId: record.orchestrationId }),
      metadata: {
        expiresAt,
        ttlMs: this.ttlMs,
        ...(diagnostics?.configuredCatalogueSize === undefined
          ? {}
          : { configuredCatalogueSize: diagnostics.configuredCatalogueSize }),
        ...(diagnostics?.advertisedToolCount === undefined
          ? {}
          : { advertisedToolCount: diagnostics.advertisedToolCount }),
        ...(diagnostics?.resolutionStatus === undefined
          ? {}
          : { resolutionStatus: diagnostics.resolutionStatus }),
      },
    });
    return { token, context: contextFromRecord(record) };
  }

  resolve(token: string): McpSessionContext | null {
    return this.resolveDetailed(token).context;
  }

  resolveDetailed(token: string): ResolveMcpSessionResult {
    if (!token) return { context: null, reason: "missing" };
    if (token.length > 512) return { context: null, reason: "invalid" };
    const tokenHash = hashToken(token);
    const record = this.sessions.get(tokenHash);
    if (!record || !sameHash(record.tokenHash, tokenHash) || record.revokedAt) {
      return { context: null, reason: "invalid" };
    }
    if (Date.parse(record.expiresAt) <= this.now()) {
      this.reportExpiry(record);
      this.sessions.delete(tokenHash);
      return { context: null, reason: "expired" };
    }
    return { context: contextFromRecord(record) };
  }

  /**
   * Record catalogue facts once for a run. Repeated stateless HTTP requests
   * cannot overwrite the original per-run snapshot or grow diagnostics.
   */
  recordCatalogueObservation(
    runId: string,
    configuredCatalogueSize: number,
    advertisedToolCount: number,
  ): void {
    const configured = nonnegativeSafeInteger(configuredCatalogueSize);
    const advertised = nonnegativeSafeInteger(advertisedToolCount);
    if (!runId || configured === undefined || advertised === undefined) return;
    for (const record of this.sessions.values()) {
      if (record.runId !== runId) continue;
      const current = record.diagnostics ?? {};
      record.diagnostics = {
        ...current,
        ...(current.configuredCatalogueSize === undefined
          ? { configuredCatalogueSize: configured }
          : {}),
        ...(current.advertisedToolCount === undefined
          ? { advertisedToolCount: advertised }
          : {}),
        ...(current.toolsListRequestBound === undefined
          ? { toolsListRequestBound: MCP_TOOLS_LIST_REQUEST_BOUND }
          : {}),
        ...(current.toolsListRequestCountStatus === undefined
          ? { toolsListRequestCountStatus: "not-observed" as const }
          : {}),
      };
    }
  }

  /**
   * Count only JSON-RPC tools/list messages supplied by the authenticated
   * route. The request body is never retained, logged, or mixed with headers.
   */
  observeToolsList(runId: string, requestCount: number): void {
    const count = nonnegativeSafeInteger(requestCount);
    if (!runId || count === undefined || count === 0) return;
    for (const record of this.sessions.values()) {
      if (record.runId !== runId) continue;
      const current = record.diagnostics ?? {};
      if (current.toolsListRequestCountStatus === "unknown") continue;
      const observed = current.toolsListRequestsObserved ?? 0;
      const bounded = Math.min(
        MCP_TOOLS_LIST_REQUEST_BOUND,
        observed + count,
      );
      record.diagnostics = {
        ...current,
        toolsListRequestsObserved: bounded,
        toolsListRequestBound: MCP_TOOLS_LIST_REQUEST_BOUND,
        toolsListRequestCountStatus:
          observed + count > MCP_TOOLS_LIST_REQUEST_BOUND ? "capped" : "observed",
      };
    }
  }

  /** Parse and record one authenticated HTTP body without retaining it. */
  observeToolsListMessage(runId: string, message: unknown): void {
    // GET/DELETE and empty authenticated requests do not represent a
    // discovery attempt; leave the initial not-observed state intact.
    if (message === undefined) return;
    const requestCount = countToolsListMessages(message);
    if (requestCount !== null) {
      this.observeToolsList(runId, requestCount);
      return;
    }
    if (!runId) return;
    for (const record of this.sessions.values()) {
      if (record.runId !== runId) continue;
      const current = record.diagnostics ?? {};
      const { toolsListRequestsObserved: _observed, ...withoutObserved } = current;
      record.diagnostics = {
        ...withoutObserved,
        toolsListRequestBound: MCP_TOOLS_LIST_REQUEST_BOUND,
        toolsListRequestCountStatus: "unknown",
      };
    }
  }

  private reportExpiry(record: SessionRecord): void {
    if (record.expiryReported) return;
    record.expiryReported = true;
    this.emit({
      type: "mcp_session_expired",
      status: "failure",
      summary: "MCP session expired",
      principal: agentPrincipal(record.agentId),
      agentId: record.agentId,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      runId: record.runId,
      ...(record.orchestrationId === undefined ? {} : { orchestrationId: record.orchestrationId }),
      metadata: { reason: "expired", expiresAt: record.expiresAt },
    });
  }

  revoke(token: string): boolean {
    if (!token) return false;
    const tokenHash = hashToken(token);
    const record = this.sessions.get(tokenHash);
    if (!record || !sameHash(record.tokenHash, tokenHash) || record.revokedAt) return false;
    this.sessions.delete(tokenHash);
    this.clearWebToolPermissionDenied(record.runId);
    return true;
  }

  /** Record a trusted web-tool denial for the authenticated Run. */
  markWebToolPermissionDenied(runId: string): void {
    if (!runId) return;
    this.webToolDenials.set(runId, WEB_TOOL_PERMISSION_DENIED);
  }

  /** Read the terminal denial latch without consuming it. */
  hasWebToolPermissionDenied(runId: string): boolean {
    return this.webToolDenials.has(runId);
  }

  /** Release the denial latch once the owning Run has settled. */
  clearWebToolPermissionDenied(runId: string): void {
    if (!runId) return;
    this.webToolDenials.delete(runId);
  }

  /** Revoke all stale records without exposing token material. */
  prune(): void {
    const timestamp = this.now();
    for (const [tokenHash, record] of this.sessions) {
      if (record.revokedAt) {
        this.sessions.delete(tokenHash);
        continue;
      }
      if (Date.parse(record.expiresAt) <= timestamp) {
        this.reportExpiry(record);
        this.sessions.delete(tokenHash);
      }
    }
  }

  size(): number {
    this.prune();
    return this.sessions.size;
  }
}
