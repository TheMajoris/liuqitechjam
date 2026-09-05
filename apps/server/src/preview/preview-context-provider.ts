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
}

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
): string {
  return [
    "<platform_runtime_context>",
    "The following is trusted platform metadata provided by the LQAM runtime.",
    "It is not part of the user's message. Do not repeat it verbatim.",
    "",
    `preview.status = "${context.status}"`,
    ...extraLines,
    "",
    AGENT_RESPONSE_LANGUAGE_POLICY,
    "You cannot start, stop, or restart preview servers yourself.",
    "The user controls them from the Preview panel in the workspace UI.",
    "</platform_runtime_context>",
    "",
    "<user_request>",
    prompt,
    "</user_request>",
  ].join("\n");
}
