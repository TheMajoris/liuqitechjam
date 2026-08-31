import type { Agent, ModelRef } from "../types";

export type AgentForm = {
  name: string;
  description: string;
  instructions: string;
  modelRef?: ModelRef;
  /** Ordered fallback models attempted after the primary model. */
  fallbackModelRefs: ModelRef[];
  skillIds: string[];
  /** Optional Agent-wide role; null explicitly means no role. */
  globalRoleId?: string | null;
};

export const emptyAgentForm: AgentForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
  skillIds: [],
  fallbackModelRefs: [],
  globalRoleId: null,
};

export function formFromAgent(agent: Agent): AgentForm {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skillIds: [...(agent.skillIds ?? [])],
    fallbackModelRefs: (agent.fallbackModelRefs ?? []).map((modelRef) => ({
      ...modelRef,
      ...(modelRef.reasoning ? { reasoning: { ...modelRef.reasoning } } : {}),
    })),
    globalRoleId: agent.globalRoleId ?? null,
    ...(agent.modelRef ? { modelRef: agent.modelRef } : {}),
  };
}

export function formPayload(form: AgentForm): {
  name: string;
  description: string;
  instructions: string;
  modelRef?: ModelRef;
  fallbackModelRefs: ModelRef[];
  skillIds: string[];
  globalRoleId?: string | null;
} {
  return {
    name: form.name,
    description: form.description,
    instructions: form.instructions,
    skillIds: form.skillIds,
    fallbackModelRefs: form.fallbackModelRefs,
    ...(form.globalRoleId ? { globalRoleId: form.globalRoleId } : {}),
    ...(form.modelRef ? { modelRef: form.modelRef } : {}),
  };
}
