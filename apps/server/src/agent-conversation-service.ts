import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { Storage } from "./store.js";
import type {
  Agent,
  AgentConversation,
  Database,
  Message,
  MessageOrigin,
} from "./types.js";

export const DEFAULT_CONVERSATION_TITLE = "New conversation";
const MAX_CONVERSATION_TITLE_LENGTH = 80;

type Clock = () => string;
type IdFactory = () => string;
type AgentAssertion = (agentId: string) => void;

/**
 * Derives a conversation title from the user's first message.
 *
 * This stays deliberately mechanical: naming a conversation is not worth a
 * second model call, and a deterministic title is easier to test.
 */
export function deriveConversationTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n").find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return DEFAULT_CONVERSATION_TITLE;
  if (collapsed.length <= MAX_CONVERSATION_TITLE_LENGTH) return collapsed;
  const clipped = collapsed.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 24 ? clipped.slice(0, lastSpace) : clipped).trimEnd() + "…";
}

function normalizeConversationTitle(title: string | undefined): string | null {
  const trimmed = (title ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

/**
 * Owns private conversation and message-history persistence.
 *
 * The public AgentService remains the facade used by HTTP and orchestration
 * callers. This module is intentionally deep behind that facade: it keeps
 * validation, title normalization, legacy migration, and the related store
 * mutations together instead of making callers coordinate those details.
 */
export class AgentConversationService {
  private readonly clock: Clock;
  private readonly idFactory: IdFactory;

  constructor(
    private readonly store: Storage,
    private readonly assertAgent: AgentAssertion,
    options: { clock?: Clock; idFactory?: IdFactory } = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * Adopts pre-conversation direct history into one default conversation.
   *
   * The old Agent.codexThreadId was the Agent's private session, so it moves
   * to that conversation rather than being copied. Project threads live on
   * the attachment and are never touched here.
   */
  migrateLegacyConversations(database: Database): void {
    const orphans = database.messages.filter(
      (message) =>
        message.conversationId === undefined && (message.origin ?? "direct") === "direct",
    );
    if (orphans.length === 0) return;

    const byAgent = new Map<string, Message[]>();
    for (const message of orphans) {
      const bucket = byAgent.get(message.agentId) ?? [];
      bucket.push(message);
      byAgent.set(message.agentId, bucket);
    }

    for (const [agentId, messages] of byAgent) {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) continue;
      const ordered = [...messages].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      const firstPrompt = ordered.find((message) => message.role === "user")?.content ?? "";
      const timestamp = this.clock();
      const conversation: AgentConversation = {
        id: this.idFactory(),
        agentId,
        title: firstPrompt
          ? deriveConversationTitle(firstPrompt)
          : DEFAULT_CONVERSATION_TITLE,
        codexThreadId: agent.codexThreadId,
        createdAt: ordered[0]?.createdAt ?? timestamp,
        updatedAt: ordered[ordered.length - 1]?.createdAt ?? timestamp,
      };
      database.agentConversations.push(conversation);
      agent.codexThreadId = null;

      const runIds = new Set<string>();
      for (const message of ordered) {
        const stored = database.messages.find((item) => item.id === message.id);
        if (!stored) continue;
        stored.conversationId = conversation.id;
        runIds.add(stored.runId);
      }
      for (const run of database.runs) {
        if (run.agentId === agentId && runIds.has(run.id)) {
          run.conversationId = conversation.id;
        }
      }
    }
  }

  list(agentId: string): AgentConversation[] {
    this.assertAgent(agentId);
    return this.store
      .snapshot()
      .agentConversations.filter((item) => item.agentId === agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(agentId: string, conversationId: string): AgentConversation {
    const conversation = this.store
      .snapshot()
      .agentConversations.find(
        (item) => item.id === conversationId && item.agentId === agentId,
      );
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }
    return conversation;
  }

  async create(agentId: string, title?: string): Promise<AgentConversation> {
    this.assertAgent(agentId);
    const timestamp = this.clock();
    const conversation: AgentConversation = {
      id: this.idFactory(),
      agentId,
      title: normalizeConversationTitle(title) ?? DEFAULT_CONVERSATION_TITLE,
      codexThreadId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.agentConversations.push(conversation);
    });
    return conversation;
  }

  async rename(
    agentId: string,
    conversationId: string,
    title: string,
  ): Promise<AgentConversation> {
    this.get(agentId, conversationId);
    const normalized = normalizeConversationTitle(title);
    if (!normalized) {
      throw new HttpError(422, "A conversation title is required");
    }
    return this.store.mutate((database) => {
      const stored = database.agentConversations.find((item) => item.id === conversationId);
      if (!stored) throw new HttpError(404, "Conversation not found");
      stored.title = normalized;
      stored.updatedAt = this.clock();
      return structuredClone(stored);
    });
  }

  async delete(agentId: string, conversationId: string): Promise<{ deleted: true }> {
    this.get(agentId, conversationId);
    await this.store.mutate((database) => {
      database.agentConversations = database.agentConversations.filter(
        (item) => item.id !== conversationId,
      );
      database.messages = database.messages.filter(
        (item) => item.conversationId !== conversationId,
      );
      database.runs = database.runs.filter(
        (item) => item.conversationId !== conversationId,
      );
    });
    return { deleted: true };
  }

  /** Resolves the conversation a direct turn belongs to, creating one if needed. */
  async resolve(agentId: string, conversationId: string | undefined): Promise<AgentConversation> {
    if (conversationId !== undefined) return this.get(agentId, conversationId);
    const existing = this.list(agentId)[0];
    return existing ?? (await this.create(agentId));
  }

  getMessages(
    agentId: string,
    options: { origin?: MessageOrigin | "all"; conversationId?: string } = {},
  ): Message[] {
    this.assertAgent(agentId);
    const origin = options.origin ?? "direct";
    const conversationId = options.conversationId;
    if (conversationId !== undefined) this.get(agentId, conversationId);
    return this.store
      .snapshot()
      .messages.filter(
        (message) =>
          message.agentId === agentId &&
          (origin === "all" || (message.origin ?? "direct") === origin) &&
          (conversationId === undefined || message.conversationId === conversationId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
