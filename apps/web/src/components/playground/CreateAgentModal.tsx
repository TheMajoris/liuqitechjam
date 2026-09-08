import { motion } from "motion/react";
import type { AgentRole, ModelResourceSnapshot, SkillMetadata } from "../../types";
import { transitions, variants } from "../../motion/motion-tokens";
import type { AgentForm } from "../../playground/agent-form";
import type { ModelCatalogController } from "../../playground/use-model-catalog";
import { AgentFormFields } from "./AgentFormFields";
import { Spinner } from "./Spinner";

interface CreateAgentModalProps {
  form: AgentForm;
  modelCatalog: ModelCatalogController;
  modelResources?: Map<string, ModelResourceSnapshot>;
  skillCatalog: SkillMetadata[];
  skillLoading: boolean;
  skillError: string | null;
  disabled: boolean;
  invalidModel: boolean;
  roles?: AgentRole[];
  onChange: (changes: Partial<AgentForm>) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
}

export function CreateAgentModal({
  form,
  modelCatalog,
  modelResources,
  skillCatalog,
  skillLoading,
  skillError,
  disabled,
  invalidModel,
  roles = [],
  onChange,
  onSubmit,
  onClose,
}: CreateAgentModalProps) {
  return (
    <motion.div
      className="modal-backdrop"
      onMouseDown={onClose}
      variants={variants.fade}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={transitions.fast}
    >
      <motion.form
        className="modal"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
        variants={variants.modal}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={transitions.base}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">New Agent</span>
            <h2>Create an Agent</h2>
            <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <AgentFormFields
            form={form}
            modelCatalog={modelCatalog}
            {...(modelResources === undefined ? {} : { modelResources })}
            skillCatalog={skillCatalog}
            skillLoading={skillLoading}
            skillError={skillError}
            assignedSkills={null}
            disabled={disabled}
            isNew
            roles={roles}
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
      </motion.form>
    </motion.div>
  );
}
