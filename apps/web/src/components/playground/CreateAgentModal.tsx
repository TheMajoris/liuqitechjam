import type { SkillMetadata } from "../../types";
import type { AgentForm } from "../../playground/agent-form";
import type { ModelCatalogController } from "../../playground/use-model-catalog";
import { AgentFormFields } from "./AgentFormFields";
import { Spinner } from "./Spinner";

interface CreateAgentModalProps {
  form: AgentForm;
  modelCatalog: ModelCatalogController;
  skillCatalog: SkillMetadata[];
  skillLoading: boolean;
  skillError: string | null;
  disabled: boolean;
  invalidModel: boolean;
  onChange: (changes: Partial<AgentForm>) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
}

export function CreateAgentModal({
  form,
  modelCatalog,
  skillCatalog,
  skillLoading,
  skillError,
  disabled,
  invalidModel,
  onChange,
  onSubmit,
  onClose,
}: CreateAgentModalProps) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">New workspace</span>
            <h2>Create an Agent</h2>
            <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <AgentFormFields
            form={form}
            modelCatalog={modelCatalog}
            skillCatalog={skillCatalog}
            skillLoading={skillLoading}
            skillError={skillError}
            assignedSkills={null}
            disabled={disabled}
            isNew
            onChange={onChange}
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={disabled || invalidModel}>
            {disabled ? <Spinner /> : "Create Agent"}
          </button>
        </div>
      </form>
    </div>
  );
}
