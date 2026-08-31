import type { Agent, ModelRef } from "../types";

export type AgentForm = {
  name: string;
  description: string;
  instructions: string;
  modelRef?: ModelRef;
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
  globalRoleId: null,
};

export function formFromAgent(agent: Agent): AgentForm {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skillIds: [...(agent.skillIds ?? [])],
    globalRoleId: agent.globalRoleId ?? null,
    ...(agent.modelRef ? { modelRef: agent.modelRef } : {}),
  };
}

export function formPayload(form: AgentForm): {
  name: string;
  description: string;
  instructions: string;
  modelRef?: ModelRef;
  skillIds: string[];
  globalRoleId?: string | null;
} {
  return {
    name: form.name,
    description: form.description,
    instructions: form.instructions,
    skillIds: form.skillIds,
    ...(form.globalRoleId ? { globalRoleId: form.globalRoleId } : {}),
    ...(form.modelRef ? { modelRef: form.modelRef } : {}),
  };
}
