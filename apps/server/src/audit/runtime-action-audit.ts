import { createHash } from "node:crypto";
import { agentPrincipal } from "../access/access-types.js";
import { newSpanId } from "./audit-span.js";
import { isSecretLikeFilename, programBasename } from "./audit-redaction.js";
import type {
  AuditEventInput,
  AuditRecorder,
  AuditSpan,
} from "./audit-types.js";

/** Below this many files the per-file detail is worth the audit volume. */
const MAX_PER_FILE_EVENTS = 20;
const WORKSPACE_PREFIX = "/workspace/";

/**
 * A host-side tap over the Codex JSONL event stream.
 *
 * Every method is best effort: a malformed event, a missing field, or a failing
 * audit sink must never disturb the Run that produced it.
 */
export interface RuntimeActionObserver {
  onEvent(event: Record<string, unknown>): void;
}

export interface RuntimeActionObserverOptions {
  audit: AuditRecorder;
  runId: string;
  agentId: string;
  projectId?: string;
  orchestrationId?: string;
  /** The Run span; runtime events parent under it. */
  parentSpan: AuditSpan;
  now?: () => number;
  onError?: (error: unknown) => void;
}

interface PendingItem {
  spanId: string;
  startedAt: number;
}

interface TurnCounters {
  reasoningItems: number;
  messageItems: number;
  otherItems: number;
  commandItems: number;
  fileChangeItems: number;
  mcpToolItems: number;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function emptyCounters(): TurnCounters {
  return {
    reasoningItems: 0,
    messageItems: 0,
    otherItems: 0,
    commandItems: 0,
    fileChangeItems: 0,
    mcpToolItems: 0,
  };
}

export function createRuntimeActionObserver(
  options: RuntimeActionObserverOptions,
): RuntimeActionObserver {
  const now = options.now ?? (() => Date.now());
  const onError =
    options.onError ?? ((error: unknown) => console.warn("runtime audit write failed", error));
  const pending = new Map<string, PendingItem>();
  let counters = emptyCounters();
  let turnStartedAt: number | null = null;

  const correlation = {
    agentId: options.agentId,
    runId: options.runId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.orchestrationId === undefined
      ? {}
      : { orchestrationId: options.orchestrationId }),
    principal: agentPrincipal(options.agentId),
    actorType: "agent",
  } as const;

  function record(
    input: Omit<AuditEventInput, keyof typeof correlation | "span"> & { spanId: string },
  ): void {
    const { spanId, ...rest } = input;
    void options.audit
      .record({
        ...correlation,
        ...rest,
        span: {
          traceId: options.parentSpan.traceId,
          spanId,
          parentSpanId: options.parentSpan.spanId,
        },
      })
      .catch(onError);
  }

  function takePending(itemId: string | undefined): PendingItem | undefined {
    if (itemId === undefined) return undefined;
    const entry = pending.get(itemId);
    if (entry) pending.delete(itemId);
    return entry;
  }

  function rememberStart(itemId: string | undefined): void {
    if (itemId === undefined) return;
    pending.set(itemId, { spanId: newSpanId(), startedAt: now() });
  }

  function onCommandCompleted(item: Record<string, unknown>): void {
    counters.commandItems += 1;
    const started = takePending(asString(item.id));
    const command = typeof item.command === "string" ? item.command : "";
    const program = programBasename(command);
    const exitCode = asNumber(item.exit_code);
    const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0);
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    record({
      spanId: started?.spanId ?? newSpanId(),
      type: "sandbox_command",
      status: exitCode === 0 ? "success" : "failure",
      summary: "Sandbox exec: " + program + " (exit " + (exitCode ?? "unknown") + ")",
      ...(started === undefined ? {} : { durationMs: Math.max(0, now() - started.startedAt) }),
      metadata: {
        program,
        argCount: Math.max(0, tokens.length - 1),
        ...(exitCode === undefined ? {} : { exitCode }),
        stdoutBytes: Buffer.byteLength(output),
        commandHash: shortHash(command),
      },
    });
  }

  function onFileChangeCompleted(item: Record<string, unknown>): void {
    counters.fileChangeItems += 1;
    const changes = Array.isArray(item.changes) ? item.changes : [];
    let added = 0;
    let modified = 0;
    let deleted = 0;
    const files: { kind: string; path: string }[] = [];
    for (const entry of changes) {
      const change = asRecord(entry);
      if (!change) continue;
      const kind = asString(change.kind) ?? "unknown";
      if (kind === "add") added += 1;
      else if (kind === "update" || kind === "modify") modified += 1;
      else if (kind === "delete") deleted += 1;
      files.push({ kind, path: asString(change.path) ?? "" });
    }
    record({
      spanId: newSpanId(),
      type: "workspace_file_change",
      status: "success",
      summary: "Workspace files changed",
      metadata: { fileCount: files.length, added, modified, deleted },
    });
    if (files.length === 0 || files.length > MAX_PER_FILE_EVENTS) return;
    for (const file of files) {
      const relative =
        file.path.startsWith(WORKSPACE_PREFIX) && !isSecretLikeFilename(file.path)
          ? file.path.slice(WORKSPACE_PREFIX.length)
          : undefined;
      record({
        spanId: newSpanId(),
        type: "workspace_file_change",
        status: "success",
        summary: "Workspace files changed",
        metadata: {
          kind: file.kind,
          pathHash: shortHash(file.path),
          ...(relative === undefined ? {} : { workspaceFile: relative }),
        },
      });
    }
  }

  function onMcpToolCompleted(item: Record<string, unknown>): void {
    counters.mcpToolItems += 1;
    const started = takePending(asString(item.id));
    const itemStatus = asString(item.status) ?? "unknown";
    const argumentsValue = item.arguments === undefined ? {} : item.arguments;
    let argHash: string;
    try {
      argHash = shortHash(JSON.stringify(argumentsValue) ?? "{}");
    } catch {
      argHash = shortHash("{}");
    }
    record({
      spanId: started?.spanId ?? newSpanId(),
      type: "mcp_tool_call",
      status: itemStatus === "failed" ? "failure" : "success",
      summary: "MCP tool call",
      ...(started === undefined ? {} : { durationMs: Math.max(0, now() - started.startedAt) }),
      metadata: {
        ...(asString(item.server) === undefined ? {} : { server: asString(item.server) }),
        ...(asString(item.tool) === undefined ? {} : { toolId: asString(item.tool) }),
        argHash,
        itemStatus,
      },
    });
  }

  function onTurnEnded(event: Record<string, unknown>, failed: boolean): void {
    const usage = failed ? undefined : asRecord(event.usage);
    const inputTokens = usage === undefined ? undefined : asNumber(usage.input_tokens);
    const cachedInputTokens =
      usage === undefined ? undefined : asNumber(usage.cached_input_tokens);
    const outputTokens = usage === undefined ? undefined : asNumber(usage.output_tokens);
    record({
      spanId: newSpanId(),
      type: "model_turn",
      status: failed ? "failure" : "success",
      summary: failed ? "Model turn failed" : "Model turn completed",
      ...(turnStartedAt === null
        ? {}
        : { durationMs: Math.max(0, now() - turnStartedAt) }),
      metadata: {
        ...counters,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      },
    });
    turnStartedAt = null;
    counters = emptyCounters();
  }

  return {
    onEvent(event: Record<string, unknown>): void {
      try {
        const parsed = asRecord(event);
        if (!parsed) return;
        const type = asString(parsed.type);
        if (type === "turn.started") {
          turnStartedAt = now();
          counters = emptyCounters();
          return;
        }
        if (type === "turn.completed" || type === "turn.failed") {
          onTurnEnded(parsed, type === "turn.failed");
          return;
        }
        if (type !== "item.started" && type !== "item.completed") return;
        const item = asRecord(parsed.item);
        if (!item) return;
        const itemType = asString(item.type);
        if (type === "item.started") {
          if (itemType === "command_execution" || itemType === "mcp_tool_call") {
            rememberStart(asString(item.id));
          }
          return;
        }
        switch (itemType) {
          case "command_execution":
            onCommandCompleted(item);
            return;
          case "file_change":
            onFileChangeCompleted(item);
            return;
          case "mcp_tool_call":
            onMcpToolCompleted(item);
            return;
          case "reasoning":
            counters.reasoningItems += 1;
            return;
          case "agent_message":
            counters.messageItems += 1;
            return;
          case "web_search":
          case "todo_list":
            counters.otherItems += 1;
            return;
          default:
            return;
        }
      } catch (error) {
        onError(error);
      }
    },
  };
}
