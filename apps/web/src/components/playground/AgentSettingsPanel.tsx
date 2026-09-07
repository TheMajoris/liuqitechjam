import type {
  Agent,
  AgentRole,
  AgentSkills,
  ModelResourceSnapshot,
  SkillMetadata,
} from "../../types";
import type { AgentForm } from "../../playground/agent-form";
import type { ModelCatalogController } from "../../playground/use-model-catalog";
import { AgentFormFields } from "./AgentFormFields";
import { Spinner } from "./Spinner";

interface AgentSettingsPanelProps {
  agent: Agent;
  form: AgentForm;
  modelCatalog: ModelCatalogController;
  modelResources?: Map<string, ModelResourceSnapshot>;
  skillCatalog: SkillMetadata[];
  skillLoading: boolean;
  skillError: string | null;
  assignedSkills: AgentSkills | null;
  disabled: boolean;
  skillsDisabled: boolean;
  invalidModel: boolean;
  roles?: AgentRole[];
  onChange: (changes: Partial<AgentForm>) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
}

export function AgentSettingsPanel({
  agent,
  form,
  modelCatalog,
  modelResources,
  skillCatalog,
  skillLoading,
  skillError,
  assignedSkills,
  disabled,
  skillsDisabled,
  invalidModel,
  roles = [],
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
      <div className="settings-panel-body">
        <AgentFormFields
          form={form}
          modelCatalog={modelCatalog}
          {...(modelResources === undefined ? {} : { modelResources })}
          skillCatalog={skillCatalog}
          skillLoading={skillLoading}
          skillError={skillError}
          assignedSkills={assignedSkills}
          disabled={disabled}
          skillsDisabled={skillsDisabled}
          roles={roles}
          onChange={onChange}
        />
      </div>
      <div className="panel-footer">
        <code>{agent.workspacePath}</code>
        <button className="button button-primary" disabled={disabled || invalidModel}>
          {disabled ? <Spinner /> : "Save changes"}
        </button>
      </div>
    </form>
  );
}
