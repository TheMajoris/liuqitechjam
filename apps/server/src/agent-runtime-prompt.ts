import type {
  AgentPreviewContext,
  PreviewContextProvider,
  RuntimeContextSections,
} from "./preview/preview-context-provider.js";
import { composeRuntimeContextPrompt } from "./preview/preview-context-provider.js";
import {
  projectRuntimeContextLines,
  type ProjectRunBinding,
} from "./projects/project-execution.js";
import type { Agent } from "./types.js";
import type {
  SkillRuntimeContext,
  SkillRuntimeProjection,
} from "./skills/skill-types.js";

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

/** Prompt plus the once-resolved facts needed by discovery and audit wiring. */
export interface AgentRuntimePromptResult {
  prompt: string;
  previewContext: AgentPreviewContext;
  skillProjection: SkillRuntimeProjection | undefined;
}

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
    const result = await this.composeWithContext(
      agent,
      prompt,
      binding,
      projectId,
      runId,
      orchestrationId,
    );
    return result.prompt;
  }

  /**
   * Compose the worker prompt and return the exact skill projection used to
   * render it. Consumers such as MCP discovery must reuse this projection for
   * the same run instead of resolving capabilities again.
   */
  async composeWithContext(
    agent: Agent,
    prompt: string,
    binding: ProjectRunBinding | null,
    projectId?: string,
    runId?: string,
    orchestrationId?: string,
  ): Promise<AgentRuntimePromptResult> {
    const projectLines = binding ? projectRuntimeContextLines(binding) : [];
    const skillContext = await this.skillContext(agent, projectId, runId, orchestrationId);
    const sections: RuntimeContextSections = {
      identityLines: agentIdentityLines(agent),
      stableSkillLines: skillContext?.stableLines ?? [],
      currentStateLines: [
        ...projectLines,
        ...(skillContext?.capabilityLines.length
          ? [
              "<platform_skill_capabilities>",
              ...skillContext.capabilityLines,
              "</platform_skill_capabilities>",
            ]
          : []),
      ],
    };
    const composeForPreview = (
      previewContext: AgentPreviewContext,
    ): AgentRuntimePromptResult => ({
      prompt: composeRuntimeContextPrompt(prompt, previewContext, [], sections),
      previewContext,
      skillProjection: skillContext,
    });

    // A Project turn is already bound to the Project-owned preview status.
    // Never ask the private Agent provider here: doing so could leak private
    // preview state into a shared Project prompt.
    if (binding !== null) {
      const previewContext = { status: binding.previewStatus } satisfies AgentPreviewContext;
      return composeForPreview(previewContext);
    }

    const provider = this.previewProvider();
    if (!provider) {
      const previewContext = { status: "not_started" } satisfies AgentPreviewContext;
      return composeForPreview(previewContext);
    }
    try {
      const previewContext = await provider.getForAgent(agent.id);
      return composeForPreview(previewContext);
    } catch {
      const previewContext = { status: "not_started" } satisfies AgentPreviewContext;
      return composeForPreview(previewContext);
    }
  }
}
