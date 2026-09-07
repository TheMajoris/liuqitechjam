import type { AgentPreviewContext, PreviewContextProvider } from "./preview/preview-context-provider.js";
import { composeRuntimeContextPrompt } from "./preview/preview-context-provider.js";
import {
  projectRuntimeContextLines,
  type ProjectRunBinding,
} from "./projects/project-execution.js";
import type { Agent } from "./types.js";
import type { SkillRuntimeContext } from "./skills/skill-types.js";

/**
 * Bounds the configured instruction text delivered per turn. Long instructions
 * stay useful without letting one Agent's configuration crowd out the task.
 */
export const RUNTIME_INSTRUCTIONS_MAX_CHARS = 4_000;

/** Kept short deliberately: this text is re-sent on every single turn. */
const RUNTIME_INSTRUCTIONS_SCOPE_NOTE =
  "Standing guidance describing this Agent, not an assigned task. Act only on the user request below.";

const DEFAULT_AGENT_INSTRUCTIONS =
  "Help the user complete coding tasks in this workspace. Explain material results concisely.";

/**
 * Projects the acting Agent's identity for one turn.
 *
 * This is the canonical delivery path for identity and standing guidance in
 * both workspace kinds. A shared Project workspace cannot carry per-Agent
 * identity on disk at all, and a private workspace's AGENTS.md only reaches
 * the model when Codex opens the session — so a resumed thread would other-
 * wise keep obeying whatever was configured when it started.
 */
export function agentIdentityLines(agent: Agent): readonly string[] {
  const configured = agent.instructions?.trim() || DEFAULT_AGENT_INSTRUCTIONS;
  const instructions =
    configured.length > RUNTIME_INSTRUCTIONS_MAX_CHARS
      ? configured.slice(0, RUNTIME_INSTRUCTIONS_MAX_CHARS).trimEnd() +
        "\n[INSTRUCTIONS TRUNCATED]"
      : configured;
  return [
    `agent.name = ${JSON.stringify(agent.name)}`,
    ...(agent.description ? [`agent.description = ${JSON.stringify(agent.description)}`] : []),
    "<agent_instructions>",
    RUNTIME_INSTRUCTIONS_SCOPE_NOTE,
    instructions,
    "</agent_instructions>",
  ];
}

type PreviewProviderReader = () => PreviewContextProvider | undefined;
type SkillContextReader = (
  agent: Agent,
  projectId?: string,
  runId?: string,
  orchestrationId?: string,
) => Promise<SkillRuntimeContext | undefined>;

/**
 * Builds the trusted prompt envelope at the runtime seam.
 *
 * The caller supplies only provider readers. This keeps Preview and Skill
 * lifecycle ownership in their modules while making the ordering and
 * fallback rules for runtime context explicit in one place.
 */
export class AgentRuntimePromptComposer {
  constructor(
    private readonly previewProvider: PreviewProviderReader,
    private readonly skillContext: SkillContextReader,
  ) {}

  async compose(
    agent: Agent,
    prompt: string,
    binding: ProjectRunBinding | null,
    projectId?: string,
    runId?: string,
    orchestrationId?: string,
  ): Promise<string> {
    const projectLines = binding ? projectRuntimeContextLines(binding) : [];
    const skillContext = await this.skillContext(agent, projectId, runId, orchestrationId);
    // Identity first, then scope, then capabilities: who is acting, where the
    // turn runs, and what it may use.
    const extraLines = [
      ...agentIdentityLines(agent),
      ...projectLines,
      ...(skillContext?.lines ?? []),
    ];

    // A Project turn is already bound to the Project-owned preview status.
    // Never ask the private Agent provider here: doing so could leak private
    // preview state into a shared Project prompt.
    if (binding !== null) {
      return composeRuntimeContextPrompt(
        prompt,
        { status: binding.previewStatus },
        extraLines,
      );
    }

    const provider = this.previewProvider();
    if (!provider) {
      return this.composeWithoutPreview(prompt, extraLines);
    }
    try {
      const context = await provider.getForAgent(agent.id);
      return composeRuntimeContextPrompt(prompt, context, extraLines);
    } catch {
      return this.composeWithoutPreview(prompt, extraLines);
    }
  }

  private composeWithoutPreview(prompt: string, extraLines: readonly string[]): string {
    // Keep a runtime envelope even when the optional Preview provider is not
    // configured. The envelope carries the response-language policy and the
    // user/platform boundary that used to be repeated in AGENTS.md.
    return composeRuntimeContextPrompt(
      prompt,
      { status: "not_started" } satisfies AgentPreviewContext,
      extraLines,
    );
  }
}
