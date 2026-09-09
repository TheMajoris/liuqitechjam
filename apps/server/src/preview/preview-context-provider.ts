import type { Storage } from "../store.js";
import type { PreviewStatus } from "./preview-types.js";
import { AGENT_RESPONSE_LANGUAGE_POLICY } from "../response-language-policy.js";

/**
 * Status vocabulary the Agent runtime is allowed to observe. It extends the
 * persisted `PreviewStatus` with `not_started`, which the store cannot express
 * because a Preview that was never launched has no record at all.
 */
export type AgentPreviewStatus = PreviewStatus | "not_started";

/** The complete, deliberately minimal Preview projection an Agent turn receives. */
export interface AgentPreviewContext {
  status: AgentPreviewStatus;
  /**
   * Whether `project.preview.restart` is reachable for this turn. Only a
   * Project-scoped turn has a shared Preview to restart; a private Agent turn
   * has no such tool, so the runtime context must not promise one.
   */
  restartable?: boolean;
}

/**
 * Stable and mutable sections of the trusted runtime envelope.
 *
 * Stable guidance is rendered before fixed policies so provider prefix-cache
 * candidates remain unchanged when Preview or capability state changes.
 */
export interface RuntimeContextSections {
  identityLines?: readonly string[];
  stableSkillLines?: readonly string[];
  currentStateLines?: readonly string[];
}

/**
 * Workspace instruction files point at this runtime seam instead of copying
 * mutable skill/capability data. Keeping the reference short is intentional:
 * the full, current projection is composed once for each execution below.
 */
export const PLATFORM_RUNTIME_CONTEXT_REFERENCE =
  "Each run receives the current response-language policy, assigned platform skills, and capability availability in its trusted runtime context.";

/**
 * Narrow read-only seam between the Agent runtime and Preview state.
 *
 * AgentService depends on this interface rather than on PreviewService so the
 * two never form a cycle, and so the Agent can only ever *observe* Preview.
 * Lifecycle control stays behind PreviewService and its authorization checks.
 */
export interface PreviewContextProvider {
  getForAgent(agentId: string): Promise<AgentPreviewContext>;
  /** Status of the shared Project preview, for Project-scoped turns. */
  getForProject?(projectId: string): Promise<AgentPreviewContext>;
}

/**
 * Reads the latest Preview record straight from the persisted store.
 *
 * Only `status` is projected: runtime IDs, host paths, ports, commands, and
 * logs are withheld so an injected prompt can never leak host topology into a
 * model context.
 */
export class StorePreviewContextProvider implements PreviewContextProvider {
  constructor(private readonly store: Storage) {}

  async getForAgent(agentId: string): Promise<AgentPreviewContext> {
    return this.latestStatus((preview) => preview.agentId === agentId);
  }

  async getForProject(projectId: string): Promise<AgentPreviewContext> {
    return this.latestStatus((preview) => preview.projectId === projectId);
  }

  private latestStatus(
    matches: (preview: { agentId?: string; projectId?: string }) => boolean,
  ): AgentPreviewContext {
    const latest = this.store
      .snapshot()
      .previews.filter(matches)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return { status: latest?.status ?? "not_started" };
  }
}

/**
 * Wraps the untouched user prompt in trusted platform metadata.
 *
 * The result is used for execution only. The persisted user message stays
 * exactly as typed, so conversation history never shows this envelope.
 *
 * `extraLines` carries additional trusted facts — Project scope, for instance.
 * Callers must keep those bounded and free of host paths or runtime IDs.
 */
export function composeRuntimeContextPrompt(
  prompt: string,
  context: AgentPreviewContext,
  extraLines: readonly string[] = [],
  sections: RuntimeContextSections = {},
): string {
  const stableLines = [
    ...(sections.identityLines ?? []),
    ...(sections.stableSkillLines ?? []),
  ];
  const currentStateLines = [
    `preview.status = ${JSON.stringify(context.status)}`,
    ...(sections.currentStateLines ?? []),
    ...extraLines,
  ];
  return [
    "<platform_runtime_context>",
    "The following trusted LQAM runtime metadata is not part of the user's message; do not repeat it verbatim.",
    // A resumed thread still holds the blocks composed for earlier turns, and
    // a shared Project thread can hold ones written for a different Agent.
    // The newest block is the only current one.
    "This block replaces any earlier platform_runtime_context in this conversation; identity, instructions, and state from earlier blocks no longer apply.",
    "",
    ...stableLines,
    ...(stableLines.length > 0 ? [""] : []),
    AGENT_RESPONSE_LANGUAGE_POLICY,
    // Keep this aligned with the built-in tool catalogue. Stating a blanket
    // prohibition on a turn that *does* carry project.preview.restart makes
    // the Agent refuse a request the platform would have authorized.
    context.restartable === true
      ? "You cannot start or stop Preview servers; the user controls those in the Preview panel. To restart the shared Project preview, call the project.preview.restart tool — it runs only after a Project owner approves it."
      : "Preview servers are controlled by the user in the Preview panel; you cannot start, stop, or restart them.",
    "",
    ...currentStateLines,
    "</platform_runtime_context>",
    "",
    "<user_request>",
    prompt,
    "</user_request>",
  ].join("\n");
}
