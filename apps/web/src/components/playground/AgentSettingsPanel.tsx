import type { Agent, AgentSkills, SkillMetadata } from "../../types";
import type { AgentForm } from "../../playground/agent-form";
import type { ModelCatalogController } from "../../playground/use-model-catalog";
import { AgentFormFields } from "./AgentFormFields";
import { Spinner } from "./Spinner";

interface AgentSettingsPanelProps {
  agent: Agent;
  form: AgentForm;
  modelCatalog: ModelCatalogController;
  skillCatalog: SkillMetadata[];
  skillLoading: boolean;
  skillError: string | null;
  assignedSkills: AgentSkills | null;
  disabled: boolean;
  skillsDisabled: boolean;
  invalidModel: boolean;
  onChange: (changes: Partial<AgentForm>) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
}

export function AgentSettingsPanel({
  agent,
  form,
  modelCatalog,
  skillCatalog,
  skillLoading,
  skillError,
  assignedSkills,
  disabled,
  skillsDisabled,
  invalidModel,
  onChange,
  onSubmit,
  onClose,
}: AgentSettingsPanelProps) {
  return (
    <form className="settings-panel" onSubmit={onSubmit}>
      <div className="settings-title">
        <div>
          <span className="eyebrow">Agent configuration</span>
          <h2>Instructions and identity</h2>
        </div>
        <button type="button" onClick={onClose}>×</button>
      </div>
      <AgentFormFields
        form={form}
        modelCatalog={modelCatalog}
        skillCatalog={skillCatalog}
        skillLoading={skillLoading}
        skillError={skillError}
        assignedSkills={assignedSkills}
        disabled={disabled}
        skillsDisabled={skillsDisabled}
        agent={agent}
        onChange={onChange}
      />
      <div className="panel-footer">
        <code>{agent.workspacePath}</code>
        <button className="button button-primary" disabled={disabled || invalidModel}>
          {disabled ? <Spinner /> : "Save changes"}
        </button>
      </div>
    </form>
  );
}
