import type { Agent, AgentSkills, SkillMetadata } from "../../types";
import type { AgentForm } from "../../playground/agent-form";
import type { ModelCatalogController } from "../../playground/use-model-catalog";
import { AgentSkillsPanel } from "../AgentSkillsPanel";
import { CapabilitiesPanel } from "../CapabilitiesPanel";
import { WorkerModelFields } from "../WorkerModelFields";

type ModelFields = Pick<
  ModelCatalogController,
  | "providers"
  | "selectedFormModels"
  | "providersLoading"
  | "selectedFormModelsLoading"
  | "error"
  | "changeProvider"
  | "changeModel"
  | "changeReasoning"
  | "retry"
>;

interface AgentFormFieldsProps {
  form: AgentForm;
  modelCatalog: ModelFields;
  skillCatalog: SkillMetadata[];
  skillLoading: boolean;
  skillError: string | null;
  assignedSkills: AgentSkills | null;
  disabled: boolean;
  skillsDisabled?: boolean;
  agent?: Agent;
  isNew?: boolean;
  onChange: (changes: Partial<AgentForm>) => void;
}

/** Shared form body for create and settings; ownership stays with the parent. */
export function AgentFormFields({
  form,
  modelCatalog,
  skillCatalog,
  skillLoading,
  skillError,
  assignedSkills,
  disabled,
  skillsDisabled = disabled,
  agent,
  isNew = false,
  onChange,
}: AgentFormFieldsProps) {
  return (
    <>
      <div className={isNew ? "agent-form-modal-fields" : "form-grid"}>
        <label>
          Name
          <input
            autoFocus={isNew}
            placeholder={isNew ? "Frontend Builder" : undefined}
            value={form.name}
            onChange={(event) => onChange({ name: event.target.value })}
            required
            maxLength={80}
          />
        </label>
        <label>
          Description
          <input
            placeholder={isNew ? "Builds polished React prototypes" : undefined}
            value={form.description}
            onChange={(event) => onChange({ description: event.target.value })}
            maxLength={500}
          />
        </label>
      </div>
      <label>
        {isNew ? "Instructions" : "System instructions"}
        <textarea
          value={form.instructions}
          onChange={(event) => onChange({ instructions: event.target.value })}
          rows={isNew ? 6 : 5}
          maxLength={10_000}
        />
      </label>
      <WorkerModelFields
        providers={modelCatalog.providers}
        models={modelCatalog.selectedFormModels}
        value={form.modelRef}
        loadingProviders={modelCatalog.providersLoading}
        loadingModels={modelCatalog.selectedFormModelsLoading}
        catalogError={modelCatalog.error}
        disabled={disabled}
        isNew={isNew}
        onProviderChange={modelCatalog.changeProvider}
        onModelChange={modelCatalog.changeModel}
        onReasoningChange={modelCatalog.changeReasoning}
        onRetry={modelCatalog.retry}
      />
      <AgentSkillsPanel
        catalog={skillCatalog}
        selectedIds={form.skillIds}
        assigned={assignedSkills}
        loading={skillLoading}
        error={skillError}
        disabled={skillsDisabled}
        onChange={(skillIds) => onChange({ skillIds })}
      />
      {agent && <CapabilitiesPanel agent={agent} />}
    </>
  );
}
