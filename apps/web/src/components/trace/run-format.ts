/** Shared formatting for the Run and Trace observability views. */
import type {
  RunContextWindow,
  RunConversation,
  RunHistoryEntry,
  RunTokenTotals,
  RunToolUsage,
} from "../../types";
import { formatCount, formatPercent } from "../insights/usage-format";

/** How many tool names fit in a table cell before the rest are counted off. */
const TOOL_NAMES_IN_CELL = 3;


export function formatStarted(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Token count for one table cell.
 *
 * An em dash means the provider reported nothing, which is deliberately
 * distinct from a genuine zero; a trailing "~" marks an incomplete rollup so
 * a partial total is never read as exact.
 */
/**
 * The headline figure: what the model actually processed.
 *
 * Not the billed total. Runs resume a Codex thread and each turn re-sends the
 * conversation so far, so the billed figure grows with a thread's age whether
 * or not the work did. `describeTokens` carries the billed number.
 */
export function formatTokenCell(tokens: RunTokenTotals | undefined): string {
  if (!tokens || tokens.availability === "unavailable") return "—";
  const total = formatCount(tokens.netNewTokens);
  return tokens.availability === "partial" ? total + "~" : total;
}

/**
 * Long-form breakdown for a title/tooltip on the same cell.
 *
 * The billed total is input plus output. Cached input is a slice of the input
 * counter rather than a third addend, so it is reported as a share of input —
 * quoting it against the total would imply the cache added to the bill.
 */
export function describeTokens(tokens: RunTokenTotals | undefined): string {
  if (!tokens || tokens.availability === "unavailable") {
    return "No token usage was reported for this Run.";
  }
  const cachedShare = tokens.inputTokens > 0
    ? ` (${formatPercent(tokens.cachedInputTokens, tokens.inputTokens)} of the input was re-sent and served from cache)`
    : "";
  const caveat = tokens.availability === "partial"
    ? ` — incomplete, ${tokens.runsMissing} of ${
        tokens.runsReporting + tokens.runsMissing
      } Runs reported nothing`
    : "";
  return (
    `${formatCount(tokens.netNewInputTokens)} fresh input · ` +
    `${formatCount(tokens.outputTokens)} output · ` +
    `${formatCount(tokens.netNewTokens)} processed · ` +
    `${formatCount(tokens.totalTokens)} billed${cachedShare}${caveat}`
  );
}

/**
 * Context left in the model after a Run, for a table cell.
 *
 * Quoted in billed tokens because context is space rather than price: a prompt
 * the provider served from cache still occupied the window it was read from.
 */
export function formatContextRemaining(
  context: RunContextWindow | null,
): string {
  if (context === null) return "—";
  return formatCount(context.remainingTokens);
}

/** Long-form headroom for the same cell's tooltip. */
export function describeContext(context: RunContextWindow | null): string {
  if (context === null) {
    return (
      "No context window is configured for this Run's model, so how much of " +
      "it remains cannot be stated. Set MODEL_CONTEXT_WINDOWS to enable this."
    );
  }
  return (
    `${formatCount(context.usedTokens)} of ${formatCount(context.windowTokens)} used ` +
    `(${formatPercent(context.usedTokens, context.windowTokens)}) · ` +
    `${formatCount(context.remainingTokens)} left. Counted in billed tokens: ` +
    "input served from cache still occupies the window."
  );
}

/**
 * The key that groups Runs of one conversation.
 *
 * A Run belonging to no thread is its own group rather than being pooled with
 * every other loose Run: they are unrelated pieces of work and summing them
 * would invent a conversation that never happened. IDs are scoped by kind
 * because private threads and Team sessions are separate collections.
 */
export function conversationKey(run: RunHistoryEntry): string {
  const conversation = run.conversation;
  return conversation === null
    ? "run:" + run.runId
    : conversation.kind + ":" + conversation.id;
}

/** What to call a Run's conversation in a list. */
export function conversationLabel(run: RunHistoryEntry): string {
  return run.conversation === null ? run.title : run.conversation.title;
}

export function conversationKindLabel(conversation: RunConversation): string {
  return conversation.kind === "team" ? "Team" : "Chat";
}

/** Long-form conversation identity for a tooltip. */
export function describeConversation(run: RunHistoryEntry): string {
  const conversation = run.conversation;
  if (conversation === null) {
    return (
      "This Run belongs to no conversation — it was started outside a chat " +
      "thread or a Team session, so it is counted on its own."
    );
  }
  const kind =
    conversation.kind === "team"
      ? "A Team session: several Agents take turns on one task."
      : "A private chat thread with one Agent.";
  const naming = conversation.derived
    ? " The thread itself is unnamed, so this Run's own task names it."
    : "";
  return kind + naming;
}

/** How many acts a Run performed: tool calls plus sandbox commands. */
export function toolTotal(tools: RunToolUsage): number {
  return tools.calls + tools.sandboxCommands;
}

/** Tool count for one table cell; an em dash means the Run called nothing. */
export function formatToolCell(tools: RunToolUsage): string {
  const total = toolTotal(tools);
  return total === 0 ? "\u2014" : String(total);
}

/**
 * The busiest few tool names, for the cell under the count.
 *
 * A count alone says a Run was busy without saying what it did, which is the
 * thing a reader opened the list to find out.
 */
export function toolNamesInCell(tools: RunToolUsage): string {
  const shown = tools.names.slice(0, TOOL_NAMES_IN_CELL).map((tool) => tool.name);
  const rest = tools.names.length - shown.length;
  if (shown.length === 0) return "";
  return shown.join(", ") + (rest > 0 ? " +" + rest : "");
}

/** Long-form tool breakdown for the same cell's tooltip. */
export function describeTools(tools: RunToolUsage): string {
  if (toolTotal(tools) === 0) {
    return "This Run called no tools and ran no sandbox commands.";
  }
  const counts = [
    tools.calls > 0
      ? `${tools.calls} tool ${tools.calls === 1 ? "call" : "calls"}`
      : "",
    tools.sandboxCommands > 0
      ? `${tools.sandboxCommands} sandbox ${
          tools.sandboxCommands === 1 ? "command" : "commands"
        }`
      : "",
  ].filter((part) => part.length > 0);
  const named = tools.names
    .map(
      (tool) =>
        `${tool.name} \u00d7${tool.calls}` + (tool.failed > 0 ? ` (${tool.failed} failed)` : ""),
    )
    .join(", ");
  return counts.join(" \u00b7 ") + " \u2014 " + named;
}

/** One clause naming what a group of Runs called, for a rollup footer. */
export function summarizeTools(tools: RunToolUsage): string {
  const total = toolTotal(tools);
  if (total === 0) return "no tools called";
  const names = toolNamesInCell(tools);
  return `${total} tool ${total === 1 ? "call" : "calls"}` + (names ? " · " + names : "");
}

/** Sums several Runs' tool usage into one record, busiest name first. */
export function addTools(into: RunToolUsage, tools: RunToolUsage): void {
  into.calls += tools.calls;
  into.sandboxCommands += tools.sandboxCommands;
  for (const tool of tools.names) {
    const existing = into.names.find((item) => item.name === tool.name);
    if (existing === undefined) into.names.push({ ...tool });
    else {
      existing.calls += tool.calls;
      existing.failed += tool.failed;
    }
  }
  into.names.sort(
    (left, right) => right.calls - left.calls || left.name.localeCompare(right.name),
  );
}

export function emptyTools(): RunToolUsage {
  return { calls: 0, sandboxCommands: 0, names: [] };
}

/**
 * Everything about a Run a reader might type to find it again.
 *
 * Searching only the title would miss the two things a list of near-identical
 * Team turns is actually distinguished by — which conversation they belong to
 * and which Agent ran them — so identity, thread, Agent, outcome and the tools
 * called all go into the haystack.
 */
function searchHaystack(run: RunHistoryEntry): string {
  return [
    run.title,
    run.runId,
    run.agentName,
    run.status,
    run.conversation?.title ?? "",
    run.conversation?.kind ?? "",
    ...run.tools.names.map((tool) => tool.name),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Whether a Run matches a search box.
 *
 * Terms are matched with AND rather than as one phrase, so "joshua retry"
 * finds that Agent's Runs in that conversation without the reader having to
 * know which order the two words appear in.
 */
export function matchesQuery(run: RunHistoryEntry, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystack = searchHaystack(run);
  return terms.every((term) => haystack.includes(term));
}
