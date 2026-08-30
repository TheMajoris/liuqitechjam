import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentPrincipal } from "../access/access-types.js";
import { agentPrincipal } from "../access/access-types.js";
import { DEFAULT_MCP_TOKEN_TTL_MS } from "../config.js";

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
}

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

  constructor(ttlMs = DEFAULT_MCP_TOKEN_TTL_MS) {
    this.ttlMs = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_MCP_TOKEN_TTL_MS;
  }

  mint(input: MintMcpSessionInput): MintedMcpSession {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
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
    return { token, context };
  }

  resolve(token: string): McpSessionContext | null {
    this.prune();
    if (!token || token.length > 512) return null;
    const tokenHash = hashToken(token);
    const record = this.sessions.get(tokenHash);
    if (!record || !sameHash(record.tokenHash, tokenHash) || record.revokedAt) return null;
    if (Date.parse(record.expiresAt) <= Date.now()) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return {
      principal: { ...record.principal },
      agentId: record.agentId,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      runId: record.runId,
      ...(record.orchestrationId === undefined ? {} : { orchestrationId: record.orchestrationId }),
      ...(record.traceparent === undefined ? {} : { traceparent: record.traceparent }),
      expiresAt: record.expiresAt,
    };
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
    const timestamp = Date.now();
    for (const [tokenHash, record] of this.sessions) {
      if (record.revokedAt || Date.parse(record.expiresAt) <= timestamp) {
        this.sessions.delete(tokenHash);
      }
    }
  }

  size(): number {
    this.prune();
    return this.sessions.size;
  }
}
