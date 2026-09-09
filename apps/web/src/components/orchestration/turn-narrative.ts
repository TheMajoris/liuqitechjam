/**
 * Turns one recorded Agent turn back into something a person can read.
 *
 * The server stores what it actually sent: a rendered handoff prompt full of
 * XML delimiters, participant/Agent/Run identifiers, and a fixed safety
 * contract. That text is the truthful record and stays available verbatim, but
 * it answers "what bytes went to the model", not "what was this Agent asked to
 * do". These pure functions recover the second answer — the task, the role, the
 * result handed over, and the conversation so far — so the graph can show the
 * workflow rather than the wire format.
 *
 * Everything here is lenient by design. A summary is capped at 4,000
 * characters while a prompt may be 20,000, so the text usually arrives cut off
 * mid-tag; a parser that required well-formed input would show nothing exactly
 * when there is most to explain.
 */

/**
 * Bounded-text markers the server appends when it shortens a record.
 * Matched by shape rather than by name, because every layer that bounds text
 * mints its own — `[INPUT TRUNCATED]`, `[ROLE TRUNCATED]`, `[TURN OUTPUT
 * TRUNCATED]` — and a missed one shows up as wire format in the panel.
 */
const TRUNCATION_MARKER_SOURCE = "\\s*\\[[A-Z][A-Z ]*TRUNCATED\\]\\s*";
const TRUNCATION_MARKER = new RegExp(TRUNCATION_MARKER_SOURCE, "g");

/** A fresh matcher each time: a shared global regex carries `lastIndex`. */
function isTruncated(text: string): boolean {
  return new RegExp(TRUNCATION_MARKER_SOURCE).test(text);
}

/** One quoted stretch of another Agent's output, ready to render. */
export interface NarrativeExcerpt {
  participantId: string;
  agentId: string;
  /** One-based, matching the step numbering the graph and Activity log use. */
  stepNumber: number | undefined;
  text: string;
  truncated: boolean;
}

/** What one Agent turn was actually asked to do, in plain terms. */
export interface TurnBriefing {
  /** The person's task for the whole conversation. */
  task: string;
  /** The responsibility this Agent held on the roster. */
  role: string;
  /** The immediately preceding result this turn was handed. */
  handoff: NarrativeExcerpt | null;
  /** Earlier shared turns the Agent could see, oldest first. */
  context: NarrativeExcerpt[];
  /** The prompt matched the rendered handoff shape, so the parts are real. */
  recognized: boolean;
  /** The record was shortened, so the reader is not seeing all of it. */
  truncated: boolean;
}

const EMPTY_BRIEFING: TurnBriefing = {
  task: "",
  role: "",
  handoff: null,
  context: [],
  recognized: false,
  truncated: false,
};

/** Reverse the prompt renderer's escaping. `&amp;` last, or it double-decodes. */
function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * Stop plain-text content at the next element.
 *
 * Identifiers only ever live in the wire format's own attributes, so keeping
 * an unclosed element from swallowing the elements after it is what keeps them
 * off the panel. Deleting ID-shaped tokens from the text instead would delete
 * the commit SHA or ticket number a person actually wrote into the task.
 */
function untilNextElement(value: string): string {
  const next = /^<[a-z_]+(?:[\s>]|$)/m.exec(value);
  return next ? value.slice(0, next.index) : value;
}

/** Prompt fragment to display text: unescaped and free of wire markers. */
function readable(value: string): string {
  return unescapeXml(value).replace(TRUNCATION_MARKER, "\n").trim();
}

/**
 * Body of one element, tolerating a missing close tag.
 *
 * A truncated record ends mid-element, and the text before the cut is still
 * the most informative thing available, so an unclosed element yields
 * everything that remains rather than nothing. Callers reading plain text
 * rather than nested elements pass it through `untilNextElement`.
 */
function elementBody(text: string, tag: string): string | null {
  const open = new RegExp("<" + tag + "(?:\\s[^>]*)?>", "");
  const match = open.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const close = text.indexOf("</" + tag + ">", start);
  return close === -1 ? text.slice(start) : text.slice(start, close);
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp(name + '="([^"]*)"').exec(attributes);
  return match?.[1] ? unescapeXml(match[1]).trim() : "";
}

/** `step_index` is zero-based on the wire; readers count turns from one. */
function stepNumberFrom(attributes: string): number | undefined {
  const raw = attribute(attributes, "step_index");
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed + 1 : undefined;
}

const OUTPUT_ELEMENT =
  /<untrusted_agent_output\b([^>]*)>([\s\S]*?)(?:<\/untrusted_agent_output>|$)/;
const TURN_ELEMENT = /<turn\b([^>]*)>([\s\S]*?)(?:<\/turn>|$)/g;

function sharedTurns(section: string | null): NarrativeExcerpt[] {
  if (!section) return [];
  const excerpts: NarrativeExcerpt[] = [];
  for (const match of section.matchAll(TURN_ELEMENT)) {
    const attributes = match[1] ?? "";
    const output = OUTPUT_ELEMENT.exec(match[2] ?? "");
    const text = readable(untilNextElement(output?.[2] ?? match[2] ?? ""));
    if (!text) continue;
    excerpts.push({
      participantId: attribute(attributes, "participant_id"),
      agentId: attribute(attributes, "agent_id"),
      stepNumber: stepNumberFrom(attributes),
      text,
      truncated: attribute(attributes, "truncated") === "true",
    });
  }
  return excerpts;
}

function previousHandoff(section: string | null): NarrativeExcerpt | null {
  if (!section) return null;
  const match = OUTPUT_ELEMENT.exec(section);
  if (!match) return null;
  const text = readable(untilNextElement(match[2] ?? ""));
  if (!text) return null;
  const attributes = match[1] ?? "";
  return {
    participantId: attribute(attributes, "source_participant_id"),
    agentId: attribute(attributes, "source_agent_id"),
    stepNumber: undefined,
    text,
    truncated: /previous output was truncated/i.test(section),
  };
}

/**
 * Read one recorded prompt as a briefing.
 *
 * A prompt that does not match the rendered shape — a legacy record, or a
 * direct task — is reported as the task itself rather than discarded: showing
 * unparsed text beats showing an empty panel over a turn that really ran.
 */
export function buildTurnBriefing(raw: string | null | undefined): TurnBriefing {
  const text = raw ?? "";
  if (!text.trim()) return EMPTY_BRIEFING;

  const taskSection = elementBody(text, "orchestration_task");
  const recognized =
    taskSection !== null ||
    text.startsWith("You are participating in a shared multi-Agent conversation.");
  if (!recognized) {
    return {
      ...EMPTY_BRIEFING,
      task: readable(text),
      truncated: isTruncated(text),
    };
  }

  const role = /\bin role ([\s\S]*?), at position \d+\./.exec(text);
  const handoff = previousHandoff(elementBody(text, "previous_agent_handoff"));
  return {
    task: taskSection === null ? "" : readable(untilNextElement(taskSection)),
    role: role?.[1] ? readable(role[1]) : "",
    handoff,
    context: withoutHandoff(sharedTurns(elementBody(text, "shared_conversation")), handoff),
    recognized: true,
    truncated: isTruncated(text),
  };
}

/**
 * The handed-over result is normally excluded from the shared conversation by
 * the server, which matches turns on their execution identity. A record
 * written before Run IDs were carried on shared turns fails that match, so the
 * newest turn arrives twice; showing the same words in two places invites the
 * reader to think two Agents said them.
 */
function withoutHandoff(
  context: NarrativeExcerpt[],
  handoff: NarrativeExcerpt | null,
): NarrativeExcerpt[] {
  const newest = context.at(-1);
  if (!handoff || !newest) return context;
  return newest.text === handoff.text && newest.participantId === handoff.participantId
    ? context.slice(0, -1)
    : context;
}

/** The one-line version, for a collapsed row that has no space for more. */
export function briefLine(raw: string | null | undefined): string {
  const briefing = buildTurnBriefing(raw);
  const line = briefing.task || briefing.handoff?.text || "";
  return line.replace(/\s+/g, " ").trim();
}

/** What an Agent replied, reduced to something skimmable. */
export interface ReplyDigest {
  /** The reply's opening claim, stripped of markdown. */
  headline: string;
  /** Its headings and list items, in the order they were written. */
  keyPoints: string[];
  /** Fenced blocks left out of the summary but present in the full reply. */
  codeBlocks: number;
  /** The turn recorded no reply text at all, so there is nothing to show. */
  empty: boolean;
}

const EMPTY_DIGEST: ReplyDigest = {
  headline: "",
  keyPoints: [],
  codeBlocks: 0,
  empty: true,
};

const MAX_HEADLINE = 200;
const MAX_KEY_POINT = 140;
const MAX_KEY_POINTS = 6;

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

/** Drop inline markdown so a summary line reads as ordinary prose. */
function stripInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1$2")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shorten on a word boundary, so a clipped line never ends mid-word. */
function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  const window = value.slice(0, max);
  const boundary = window.lastIndexOf(" ");
  return (boundary > max / 2 ? window.slice(0, boundary) : window).trimEnd() + "…";
}

function firstSentence(value: string): string {
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(value);
  return (match?.[0] ?? value).trim();
}

function clean(value: string): string {
  return stripInline(value).replace(/\s+/g, " ").trim();
}

/**
 * Summarise one Agent reply without paraphrasing it.
 *
 * Every line shown is the Agent's own wording — its opening sentence and the
 * structure it chose to write. Nothing is generated, so the summary can never
 * claim something the reply did not say; the full text stays one click away.
 */
export function digestReply(raw: string | null | undefined): ReplyDigest {
  const text = (raw ?? "").replace(TRUNCATION_MARKER, "\n");
  if (!text.trim()) return EMPTY_DIGEST;

  let codeBlocks = 0;
  let inFence = false;
  let headline = "";
  let structureSeen = false;
  const keyPoints: string[] = [];

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) {
      if (!inFence) codeBlocks += 1;
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.trim()) continue;

    const structured = HEADING.exec(line) ?? BULLET.exec(line) ?? ORDERED.exec(line);
    if (structured) {
      structureSeen = true;
      if (keyPoints.length >= MAX_KEY_POINTS) continue;
      const point = shorten(clean(structured[1] ?? ""), MAX_KEY_POINT);
      if (point && !keyPoints.includes(point)) keyPoints.push(point);
      continue;
    }
    // A lead has to lead: prose found after the first list is a sign-off or an
    // aside, and promoting it above the points would misread the reply.
    // Table rules and block quotes carry no lead of their own either.
    if (!headline && !structureSeen && !/^\s*(?:>|\||-{3,}|={3,})/.test(line)) {
      headline = shorten(firstSentence(clean(line)), MAX_HEADLINE);
    }
  }

  return {
    headline,
    keyPoints: keyPoints.filter((point) => point !== headline),
    codeBlocks,
    empty: false,
  };
}
