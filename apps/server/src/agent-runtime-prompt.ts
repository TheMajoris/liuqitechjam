import type { AgentPreviewContext, PreviewContextProvider } from "./preview/preview-context-provider.js";
import { composeRuntimeContextPrompt } from "./preview/preview-context-provider.js";
import {
  projectRuntimeContextLines,
  type ProjectRunBinding,
} from "./projects/project-execution.js";
import type { Agent } from "./types.js";
import type { SkillRuntimeContext } from "./skills/skill-types.js";

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
    const extraLines = [...projectLines, ...(skillContext?.lines ?? [])];

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
    return extraLines.length === 0
      ? prompt
      : composeRuntimeContextPrompt(
          prompt,
          { status: "not_started" } satisfies AgentPreviewContext,
          extraLines,
        );
  }
}
