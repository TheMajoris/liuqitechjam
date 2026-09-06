import type { AgentRole, AgentSkills, SkillMetadata } from "../../types";
import type { AgentForm } from "../../playground/agent-form";
import type { ModelCatalogController } from "../../playground/use-model-catalog";
import { AgentSkillsPanel } from "../AgentSkillsPanel";
import { WorkerModelFields } from "../WorkerModelFields";

type ModelFields = Pick<
  ModelCatalogController,
  | "providers"
  | "modelsByProvider"
  | "loadingByProvider"
  | "selectedFormModels"
  | "providersLoading"
  | "catalogRefreshing"
  | "providerErrors"
  | "providerStale"
  | "selectedFormModelsLoading"
  | "error"
  | "changeProvider"
  | "changeModel"
  | "changeReasoning"
  | "addFallbackModel"
  | "removeFallbackModel"
  | "changeFallbackProvider"
  | "changeFallbackModel"
  | "refresh"
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
  isNew?: boolean;
  roles?: AgentRole[];
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
  isNew = false,
  roles = [],
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
        {/* The role is editable for the life of the Agent, not only at
            creation: it is the Agent's own source of truth for skills and
            tools, so changing it must not require recreating the Agent. */}
        <label className="agent-form-role-field">
          <span>Agent role <em>Optional</em></span>
          <select
            aria-label="Global Agent role"
            value={form.globalRoleId ?? ""}
            onChange={(event) => onChange({ globalRoleId: event.target.value || null })}
            disabled={disabled}
          >
            <option value="">No role</option>
            {roles.map((role) => (
              <option value={role.id} key={role.id}>{role.name}</option>
            ))}
          </select>
          <small>Supplies this Agent&apos;s skills and permissions in every Workspace.</small>
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
        modelsByProvider={modelCatalog.modelsByProvider}
        loadingByProvider={modelCatalog.loadingByProvider}
        value={form.modelRef}
        fallbackValues={form.fallbackModelRefs}
        loadingProviders={modelCatalog.providersLoading}
        catalogRefreshing={modelCatalog.catalogRefreshing}
        loadingModels={modelCatalog.selectedFormModelsLoading}
        providerErrors={modelCatalog.providerErrors}
        providerStale={modelCatalog.providerStale}
        catalogError={modelCatalog.error}
        disabled={disabled}
        isNew={isNew}
        onProviderChange={modelCatalog.changeProvider}
        onModelChange={modelCatalog.changeModel}
        onReasoningChange={modelCatalog.changeReasoning}
        onAddFallback={modelCatalog.addFallbackModel}
        onRemoveFallback={modelCatalog.removeFallbackModel}
        onFallbackProviderChange={modelCatalog.changeFallbackProvider}
        onFallbackModelChange={modelCatalog.changeFallbackModel}
        onRefresh={modelCatalog.refresh}
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
    </>
  );
}
