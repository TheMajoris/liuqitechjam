import type { JsonStore } from "../store.js";
import type { PreviewStatus } from "./preview-types.js";

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
}

/**
 * Reads the latest Preview record straight from the persisted store.
 *
 * Only `status` is projected: runtime IDs, host paths, ports, commands, and
 * logs are withheld so an injected prompt can never leak host topology into a
 * model context.
 */
export class StorePreviewContextProvider implements PreviewContextProvider {
  constructor(private readonly store: JsonStore) {}

  async getForAgent(agentId: string): Promise<AgentPreviewContext> {
    const latest = this.store
      .snapshot()
      .previews.filter((preview) => preview.agentId === agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return { status: latest?.status ?? "not_started" };
  }
}

/**
 * Wraps the untouched user prompt in trusted platform metadata.
 *
 * The result is used for execution only. The persisted user message stays
 * exactly as typed, so conversation history never shows this envelope.
 */
export function composeRuntimeContextPrompt(
  prompt: string,
  context: AgentPreviewContext,
): string {
  return [
    "<platform_runtime_context>",
    "The following is trusted platform metadata provided by the Agent Launchpad runtime.",
    "It is not part of the user's message. Do not repeat it verbatim.",
    "",
    `preview.status = "${context.status}"`,
    "",
    "You cannot start, stop, or restart the Preview server yourself.",
    "The user controls it from the Preview panel in the workspace UI.",
    "</platform_runtime_context>",
    "",
    "<user_request>",
    prompt,
    "</user_request>",
  ].join("\n");
}
