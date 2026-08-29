import { useMemo, useState } from "react";
import type { Agent, CreateOrchestrationInput, OrchestrationParticipant } from "../../types";
import {
  type DraftErrors,
  deriveSessionName,
  isOrderedMode,
  normalizeParticipants,
  validateDraft,
  withDerivedLabels,
  type OrchestrationDraft,
} from "./orchestration-utils";
import { OrchestrationAdvancedSettings } from "./OrchestrationAdvancedSettings";
import { AgentPicker } from "./AgentPicker";

interface OrchestrationComposerProps {
  agents: Agent[];
  disabled?: boolean;
  onCreate: (input: CreateOrchestrationInput) => Promise<unknown>;
  onCancel?: () => void;
}

/**
 * Automatic turn taking is the product default for anything created here.
 * The API default for an omitted mode is deliberately different and is not
 * relied on: the UI always sends its own choice.
 */
const initialDraft: OrchestrationDraft = {
  name: "",
  originalPrompt: "",
  participants: [],
  mode: "supervisor",
  maxSteps: 20,
  perAgentTimeoutMs: 300_000,
};

export function OrchestrationComposer({
  agents,
  disabled = false,
  onCreate,
  onCancel,
}: OrchestrationComposerProps) {
  const [draft, setDraft] = useState<OrchestrationDraft>(initialDraft);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const derivedName = useMemo(
    () => (draft.originalPrompt.trim() ? deriveSessionName(draft.originalPrompt) : ""),
    [draft.originalPrompt],
  );

  const updateParticipants = (participants: OrchestrationParticipant[]) => {
    setDraft((current) => ({
      ...current,
      participants: normalizeParticipants(participants),
    }));
    setErrors((current) => ({ ...current, participants: undefined }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    const nextErrors = validateDraft(draft, agents);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      // Send focus to whatever has to be fixed, in visual order.
      const form = event.currentTarget;
      const target = nextErrors.participants
        ? form.querySelector<HTMLElement>(".orch-add-agent, .orch-agent-chip")
        : form.querySelector<HTMLElement>("[aria-invalid='true']");
      target?.focus();
      return;
    }

    setSubmitting(true);
    try {
      await onCreate(withDerivedLabels(draft, agents));
      setDraft(initialDraft);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const busy = disabled || submitting;

  return (
    <form className="orch-composer" onSubmit={submit}>
      {submitError && (
        <div className="orch-alert orch-alert-danger" role="alert">
          <span>{submitError}</span>
        </div>
      )}

      <AgentPicker
        participants={draft.participants}
        agents={agents}
        disabled={busy}
        error={errors.participants}
        showOrder={isOrderedMode(draft.mode)}
        onChange={updateParticipants}
      />

      <div className="orch-field">
        <label htmlFor="orch-prompt">Task</label>
        <textarea
          id="orch-prompt"
          value={draft.originalPrompt}
          disabled={busy}
          maxLength={50_000}
          rows={4}
          placeholder="Ask these Agents to…"
          aria-invalid={Boolean(errors.originalPrompt)}
          aria-describedby={errors.originalPrompt ? "orch-prompt-error" : "orch-prompt-help"}
          onChange={(event) => {
            setDraft((current) => ({ ...current, originalPrompt: event.target.value }));
            setErrors((current) => ({ ...current, originalPrompt: undefined }));
          }}
        />
        <span className="orch-field-help" id="orch-prompt-help">
          Everyone in the conversation starts from this.
        </span>
        {errors.originalPrompt && (
          <span className="orch-field-error" id="orch-prompt-error">{errors.originalPrompt}</span>
        )}
      </div>

      <OrchestrationAdvancedSettings
        name={draft.name}
        derivedName={derivedName}
        mode={draft.mode}
        maxSteps={draft.maxSteps}
        perAgentTimeoutMs={draft.perAgentTimeoutMs}
        errors={errors}
        disabled={busy}
        onNameChange={(name) => setDraft((current) => ({ ...current, name }))}
        onChange={(field, value) =>
          setDraft((current) => ({ ...current, [field]: value }))
        }
        onClearError={(field) =>
          setErrors((current) => ({ ...current, [field]: undefined }))
        }
        onModeChange={(mode) => setDraft((current) => ({ ...current, mode }))}
      />

      <div className="orch-composer-footer">
        <span className="orch-safety-note">
          <span aria-hidden="true">⌁</span> Each Agent keeps its own workspace. Replies pass
          along as bounded, untrusted text.
        </span>
        <div className="orch-composer-buttons">
          {onCancel && (
            <button
              type="button"
              className="orch-button orch-button-quiet"
              disabled={submitting}
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
          <button className="orch-button orch-button-primary" type="submit" disabled={busy}>
            {submitting ? "Starting…" : "Start conversation"}
            {!submitting && <span aria-hidden="true">→</span>}
          </button>
        </div>
      </div>
    </form>
  );
}
