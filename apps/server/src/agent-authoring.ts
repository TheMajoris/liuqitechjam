import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { redactSensitiveText } from "./orchestration/handoff.js";

/**
 * Drafting help for people who have never written an Agent prompt.
 *
 * This turns a sentence of intent into the two fields the create form asks
 * for: a one-line description and a system instruction block. It is a writing
 * aid and nothing more — the text comes back to the form as an editable
 * suggestion, is never applied without the person pressing Use, and grants no
 * capability. Skills, roles, tools, and the worker model stay exactly where
 * they are decided.
 */

export const AGENT_DRAFT_MAX_INTENT = 2_000;
export const AGENT_DRAFT_MAX_DESCRIPTION = 500;
export const AGENT_DRAFT_MAX_INSTRUCTIONS = 10_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const ERROR_BODY_LIMIT_BYTES = 4 * 1024;

export const AgentDraftRequestSchema = z.object({
  /** What the person wants the Agent to be. The only required input. */
  intent: z.string().trim().min(3).max(AGENT_DRAFT_MAX_INTENT),
  name: z.string().trim().max(80).optional(),
  description: z.string().trim().max(AGENT_DRAFT_MAX_DESCRIPTION).optional(),
  instructions: z.string().trim().max(AGENT_DRAFT_MAX_INSTRUCTIONS).optional(),
  /** Which fields to (re)write. Defaults to both. */
  fields: z.array(z.enum(["name", "description", "instructions"])).min(1).max(3).optional(),
});

export type AgentDraftRequest = z.infer<typeof AgentDraftRequestSchema>;

export interface AgentDraft {
  name: string | null;
  description: string | null;
  instructions: string | null;
}

export interface AgentAuthoringOptions {
  apiKey: string;
  baseUrl: string;
  /** Resolved per call so an operator can change the endpoint without a restart. */
  model: () => string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SYSTEM_GUIDANCE = [
  "You help someone configure one autonomous coding Agent on a multi-Agent platform.",
  "Write for a person with no prompt-engineering background.",
  "",
  "Return ONLY a JSON object with these string keys, no prose, no code fence:",
  '  { "name": string, "description": string, "instructions": string }',
  "",
  "name: 2-4 words naming the Agent's job. Title Case. No quotes.",
  "description: ONE sentence, under 140 characters, saying what this Agent does.",
  "instructions: the Agent's system prompt. 80-250 words of plain imperative",
  "  sentences addressed to the Agent. Cover, in this order: the single job it",
  "  owns; what it must do on each turn; what it must NOT do or touch; and how it",
  "  should hand off or report when it is finished. Use short paragraphs or '-'",
  "  bullets. Do not invent tool names, file paths, model names, credentials, or",
  "  teammates that were not described. Do not grant permissions or claim",
  "  authority; the platform decides what the Agent may do.",
].join("\n");

function bounded(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).trimEnd() + "…";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Ark Responses envelopes put the text either inline or in an output array. */
function extractOutputText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text;
  }
  if (!Array.isArray(record.output)) return null;
  const texts: string[] = [];
  for (const item of record.output) {
    const message = asRecord(item);
    if (!message || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      const block = asRecord(content);
      if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim()) {
        texts.push(block.text);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Pull the JSON object out of whatever the model wrapped it in.
 *
 * Small models fence their JSON or add a sentence before it often enough that
 * failing the whole request over it would make the feature feel broken.
 */
function parseDraftObject(outputText: string): Record<string, unknown> {
  const direct = asRecord(safeJson(outputText));
  if (direct) return direct;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(outputText);
  if (fenced?.[1]) {
    const parsed = asRecord(safeJson(fenced[1]));
    if (parsed) return parsed;
  }
  const start = outputText.indexOf("{");
  const end = outputText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = asRecord(safeJson(outputText.slice(start, end + 1)));
    if (parsed) return parsed;
  }
  throw new HttpError(502, "The drafting model did not return a usable suggestion.");
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const slice = next.value.byteLength > maxBytes - total
        ? next.value.slice(0, maxBytes - total)
        : next.value;
      chunks.push(slice);
      total += slice.byteLength;
    }
  } finally {
    // Cancel first: a released reader is detached from its stream, so
    // cancelling after releaseLock throws instead of draining the socket.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function requestedFields(request: AgentDraftRequest): Set<string> {
  return new Set(request.fields ?? ["description", "instructions"]);
}

/** Build the single user turn. All of it is the person's own text. */
function buildPrompt(request: AgentDraftRequest): string {
  const fields = Array.from(requestedFields(request));
  const lines = [
    "What this Agent should be:",
    request.intent,
    "",
    `Rewrite these fields: ${fields.join(", ")}.`,
  ];
  if (request.name) lines.push(`Current name: ${request.name}`);
  if (request.description) lines.push(`Current description: ${request.description}`);
  if (request.instructions) {
    lines.push("Current instructions:", bounded(request.instructions, 2_000));
  }
  lines.push(
    "",
    "Keep anything above that already works; improve clarity, scope, and limits.",
    "Return the JSON object only.",
  );
  return lines.join("\n");
}

/**
 * Ark Responses adapter for one-shot drafting.
 *
 * Deliberately separate from the supervisor provider: routing decisions are a
 * control-plane concern with their own error vocabulary, while this is an
 * optional convenience whose failure must never look like a routing failure.
 */
export class AgentAuthoringService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: () => string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentAuthoringOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** True when the server has everything it needs to answer a draft request. */
  available(): boolean {
    return (
      this.apiKey.length > 0 &&
      !this.apiKey.startsWith("replace-") &&
      this.baseUrl.length > 0 &&
      typeof this.fetchImpl === "function" &&
      this.resolvedModel().length > 0
    );
  }

  private resolvedModel(): string {
    const model = this.model().trim();
    return model.includes("replace-") ? "" : model;
  }

  async draft(request: AgentDraftRequest): Promise<AgentDraft> {
    const model = this.resolvedModel();
    if (!this.available()) {
      throw new HttpError(
        503,
        "Drafting help is unavailable: no ModelArk endpoint is configured on this server.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + "/responses", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: SYSTEM_GUIDANCE,
          input: buildPrompt(request),
          store: false,
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new HttpError(
        controller.signal.aborted ? 504 : 502,
        controller.signal.aborted
          ? "The drafting model did not answer in time. Try again, or write the fields yourself."
          : "Could not reach the drafting model: " +
            redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 300),
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await readBounded(response, ERROR_BODY_LIMIT_BYTES).catch(() => "");
      throw new HttpError(
        502,
        `The drafting model refused the request (HTTP ${response.status})` +
          (body.trim() ? ": " + redactSensitiveText(body).slice(0, 300) : "."),
      );
    }

    const outputText = extractOutputText(safeJson(await readBounded(response, RESPONSE_LIMIT_BYTES)));
    if (!outputText) {
      throw new HttpError(502, "The drafting model returned an empty suggestion.");
    }

    const draft = parseDraftObject(outputText);
    const fields = requestedFields(request);
    // Only the fields that were asked for come back. Anything else stays the
    // person's own text so a rewrite never quietly replaces a field they were
    // happy with.
    return {
      name: fields.has("name") ? clip(stringField(draft, "name"), 80) : null,
      description: fields.has("description")
        ? clip(stringField(draft, "description"), AGENT_DRAFT_MAX_DESCRIPTION)
        : null,
      instructions: fields.has("instructions")
        ? clip(stringField(draft, "instructions"), AGENT_DRAFT_MAX_INSTRUCTIONS)
        : null,
    };
  }
}

function clip(value: string | null, limit: number): string | null {
  if (value === null) return null;
  // Model output is text the form will show, so it is redacted on the way out
  // exactly like any other provider text this server relays.
  const safe = redactSensitiveText(value).trim();
  return safe ? bounded(safe, limit) : null;
}

/** Build the service from the resolved environment plus the live endpoint. */
export function createAgentAuthoringService(
  config: Pick<AppConfig, "arkApiKey" | "arkBaseUrl" | "supervisorModel">,
  model: () => string,
): AgentAuthoringService {
  return new AgentAuthoringService({
    apiKey: config.arkApiKey,
    baseUrl: config.arkBaseUrl,
    model,
  });
}
