import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentPrincipal } from "../access/access-types.js";
import { agentPrincipal } from "../access/access-types.js";
import { DEFAULT_MCP_TOKEN_TTL_MS } from "../config.js";
import type { AuditRecorder } from "../audit/audit-types.js";

export const MCP_BEARER_TOKEN_ENV = "LAUNCHPAD_MCP_BEARER_TOKEN";

export interface McpSessionContext {
  principal: AgentPrincipal;
  agentId: string;
  projectId?: string;
  runId: string;
  orchestrationId?: string;
  traceparent?: string;
  expiresAt: string;
}

interface SessionRecord extends McpSessionContext {
  tokenHash: string;
  revokedAt?: string;
  /** Set once an expiry event has been emitted so prune/resolve never double-report. */
  expiryReported?: boolean;
}

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
}

export interface MintedMcpSession {
  token: string;
  context: McpSessionContext;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** In-memory opaque bearer sessions scoped to one Agent run. */
export class McpSessionService {
  private readonly sessions = new Map<string, SessionRecord>();
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
    const context: McpSessionContext = {
      principal: agentPrincipal(input.agentId),
      agentId: input.agentId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      runId: input.runId,
      ...(input.orchestrationId === undefined ? {} : { orchestrationId: input.orchestrationId }),
      ...(input.traceparent === undefined ? {} : { traceparent: input.traceparent }),
      expiresAt,
    };
    this.sessions.set(tokenHash, {
      ...context,
      tokenHash,
    });
    this.emit({
      type: "mcp_session_issued",
      status: "success",
      summary: "MCP session issued",
      principal: context.principal,
      agentId: context.agentId,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      runId: context.runId,
      ...(context.orchestrationId === undefined ? {} : { orchestrationId: context.orchestrationId }),
      metadata: { expiresAt, ttlMs: this.ttlMs },
    });
    return { token, context };
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
    return {
      context: {
        principal: { ...record.principal },
        agentId: record.agentId,
        ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
        runId: record.runId,
        ...(record.orchestrationId === undefined ? {} : { orchestrationId: record.orchestrationId }),
        ...(record.traceparent === undefined ? {} : { traceparent: record.traceparent }),
        expiresAt: record.expiresAt,
      },
    };
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
    return true;
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
