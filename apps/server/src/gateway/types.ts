import type { RunUsage } from "../types.js";

/**
 * Gateway-local contract types. This file is the only place the gateway
 * references baseline types, and it imports nothing but `RunUsage` from
 * `../types.js` (a pure type module). It never imports app/store/module code.
 */

export type ProviderProtocol = "mock" | "responses-http";

export type ProviderHealth = "ok" | "degraded" | "unknown";

/**
 * Responses `input`: either a plain string or an array of message-like items.
 * The array shape is intentionally loose (`unknown[]`) because it is only ever
 * inspected defensively, never trusted structurally.
 */
export type ResponsesInput = string | unknown[];

/** Normalized Responses-compatible request handed to a provider adapter. */
export interface ResponsesRequest {
  model: string;
  input: ResponsesInput;
  instructions?: string;
}

/** Normalized reply returned to the data-plane caller. Never a raw envelope. */
export interface ResponsesReply {
  output: string;
  usage: RunUsage;
  model: string;
}

export interface ResponsesProvider {
  respond(request: ResponsesRequest, signal: AbortSignal): Promise<ResponsesReply>;
}

/** Safe, browser/Runtime-shareable provider descriptor. Carries no credential. */
export interface ProviderSummary {
  id: string;
  protocol: ProviderProtocol;
  models: string[];
  credentialMode: "gateway-managed";
  health: ProviderHealth;
}

interface ResponsesRequestShape {
  model: string;
  input: ResponsesInput;
  instructions?: string | undefined;
}

/** Build the normalized request object, dropping absent optional fields. */
export function normalizeResponsesRequest(body: ResponsesRequestShape): ResponsesRequest {
  const request: ResponsesRequest = { model: body.model, input: body.input };
  if (typeof body.instructions === "string") {
    request.instructions = body.instructions;
  }
  return request;
}

/** Deterministically flatten a Responses `input` value to a single string. */
export function normalizeInputText(input: ResponsesInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (!Array.isArray(input)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const chunk of content) {
        if (typeof chunk === "string") {
          parts.push(chunk);
        } else if (
          chunk &&
          typeof chunk === "object" &&
          typeof (chunk as { text?: unknown }).text === "string"
        ) {
          parts.push((chunk as { text: string }).text);
        }
      }
    } else if (content !== undefined) {
      parts.push(JSON.stringify(content));
    }
  }
  return parts.join("\n");
}
