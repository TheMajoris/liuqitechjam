import type { Agent } from "../apps/server/src/types.js";
import type { Project } from "../apps/server/src/projects/project-types.js";
import type { OrchestrationParticipant } from "../apps/server/src/orchestration/types.js";

/**
 * Fixed, local-only inputs for the token context report.
 *
 * These values intentionally contain no credentials, private paths, or live
 * endpoints. The report records only sizes derived from them, never the text.
 */
export const REPORT_PROMPTS = {
  fresh: "Add a small typed status panel and focused tests.",
  assignedSkill: "Review the current implementation and propose the smallest safe fix.",
  project: "Update the shared project artifact while preserving the other Agent's work.",
  handoff: "Continue the requested implementation from the previous participant.",
  completedConversation: "Finish the requested change using the completed conversation context.",
  supervisor: "Route this bounded task to the configured participant who should act next.",
} as const;

export const REPORT_AGENT: Agent = {
  id: "agent-token-report",
  name: "Token Report Agent",
  description: "A deterministic synthetic Agent used by the offline report.",
  instructions: "Keep changes focused, preserve existing work, and explain material results.",
  skillIds: [],
  status: "ready",
  workspacePath: "<synthetic-workspace>",
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export const REPORT_AGENT_WITH_SKILL: Agent = {
  ...REPORT_AGENT,
  id: "agent-token-report-skilled",
  name: "Token Report Skilled Agent",
  skillIds: ["code-review"],
};

export const REPORT_PROJECT: Project = {
  id: "project-token-report",
  name: "Token Report Project",
  description: "A deterministic synthetic shared project.",
  workspacePath: "<synthetic-project-workspace>",
  teamId: null,
  ownerPrincipalId: "synthetic-owner",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export const REPORT_PARTICIPANTS: readonly OrchestrationParticipant[] = [
  {
    id: "participant-planner",
    agentId: "agent-token-planner",
    role: "Planner",
    position: 0,
  },
  {
    id: "participant-builder",
    agentId: "agent-token-builder",
    role: "Builder",
    position: 1,
  },
];

export const REPORT_HTML = [
  "<!doctype html>",
  "<html><head><title>Synthetic result</title></head>",
  "<body><main><h1>Result</h1><p>Bounded offline fixture.</p></main></body></html>",
].join("");

/** A fetch result shape returned by WebFetchAdapter's offline seam. */
export const REPORT_FETCH_URL = "https://fixture.invalid/token-context-report";

/**
 * A model-facing result with both MCP representations used by the server:
 * structured data and compatibility text containing JSON.
 */
export const REPORT_MCP_OUTPUT = {
  url: REPORT_FETCH_URL,
  finalUrl: REPORT_FETCH_URL,
  status: 200,
  contentType: "text/html",
  content: REPORT_HTML,
} as const;

/**
 * Synthetic usage events cover one request counter, repeated cumulative
 * session snapshots, and a separately scoped app-run snapshot. The repeated
 * session state is intentional: report tests must reject summing it twice.
 */
export const REPORT_USAGE_EVENTS = [
  {
    type: "turn.completed",
    scope: "last-request",
    request_id: "request-1",
    usage: {
      input_tokens: 120,
      cached_input_tokens: 30,
      output_tokens: 18,
    },
  },
  {
    scope: "cumulative-session",
    session_id: "session-1",
    usage: {
      input_tokens: 500,
      cached_input_tokens: 200,
      output_tokens: 80,
    },
  },
  {
    scope: "cumulative-session",
    session_id: "session-1",
    usage: {
      input_tokens: 500,
      cached_input_tokens: 200,
      output_tokens: 80,
    },
  },
  {
    scope: "cumulative-session",
    session_id: "session-1",
    usage: {
      input_tokens: 640,
      cached_input_tokens: 260,
      output_tokens: 104,
    },
  },
  {
    scope: "app-run",
    run_id: "run-1",
    usage: {
      input_tokens: 720,
      cached_input_tokens: 280,
      output_tokens: 120,
    },
  },
  {
    // No scope is supplied: this must stay explicitly unknown rather than
    // being guessed as one of the supported counter scopes.
    usage: {
      input_tokens: 999,
      output_tokens: 1,
    },
  },
] as const;
