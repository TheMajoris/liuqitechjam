import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  ORCHESTRATION_MAX_NAME_LENGTH,
  ORCHESTRATION_MAX_STEPS,
  ORCHESTRATION_MAX_TIMEOUT_MS,
  ORCHESTRATION_MIN_TIMEOUT_MS,
  type DraftErrors,
} from "./orchestration-utils";
import type { OrchestrationMode } from "../../types";

type NumericField = "maxSteps" | "perAgentTimeoutMs";
type ClearableField = NumericField;

interface OrchestrationAdvancedSettingsProps {
  name: string;
  derivedName: string;
  mode: OrchestrationMode;
  maxSteps: number;
  perAgentTimeoutMs: number;
  errors: DraftErrors;
  disabled?: boolean;
  onNameChange: (name: string) => void;
  onChange: (field: NumericField, value: number) => void;
  onClearError: (field: ClearableField) => void;
  onModeChange: (mode: OrchestrationMode) => void;
}

/**
 * Read-only statement of what routes the conversation.
 *
 * Routing is a server-wide model, not an Agent: no one in the roster
 * supervises, and no Agent is consumed by supervising. There is nothing to
 * choose here, so this reports the configured endpoint instead of offering a
 * selection that would not be honored.
 */
export function SupervisorModelNotice() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .supervisorModel()
      .then((current) => {
        if (!cancelled) setConfigured(current.modelRef !== null);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="orch-field">
      <span className="orch-field-label">Routing</span>
      {/*
        Whether routing is configured is what someone setting up a Conversation
        needs; which endpoint serves it is infrastructure. The raw endpoint ID
        used to be printed here, on a screen anyone with app access can reach
        and screenshot — it names a live billable endpoint in the operator's
        provider account, so it belongs on the operator's own page, next to the
        control that changes it, and nowhere else.
      */}
      <span className="orch-field-help" role="status">
        {configured === null
          ? "Checking the configured supervisor model…"
          : configured
            ? "A supervisor model picks who speaks next. It is a server-wide setting, changed in Insights › Supervisor model."
            : "No supervisor model is configured. Set one in Insights › Supervisor model before starting a supervised Conversation."}
      </span>
    </div>
  );
}

/**
 * Everything a normal user should not have to decide. The deterministic
 * strategy and the turn ceiling stay fully supported here; they are only
 * moved out of the primary setup flow.
 */
export function OrchestrationAdvancedSettings({
  name,
  derivedName,
  mode,
  maxSteps,
  perAgentTimeoutMs,
  errors,
  disabled = false,
  onNameChange,
  onChange,
  onClearError,
  onModeChange,
}: OrchestrationAdvancedSettingsProps) {
  const advancedRef = useRef<HTMLDetailsElement>(null);

  return (
    <details className="orch-advanced-settings" ref={advancedRef}>
      <summary>
        <span>Advanced</span>
        <span className="orch-advanced-hint">Naming, turn taking, safety limits</span>
      </summary>
      <div className="orch-advanced-content">
        <div className="orch-field">
          <label htmlFor="orch-name">Conversation name</label>
          <input
            id="orch-name"
            value={name}
            disabled={disabled}
            maxLength={ORCHESTRATION_MAX_NAME_LENGTH}
            placeholder={derivedName || "Taken from the task"}
            aria-describedby="orch-name-help"
            onChange={(event) => onNameChange(event.target.value)}
          />
          <span className="orch-field-help" id="orch-name-help">
            Leave blank to name it after the task.
          </span>
        </div>

        <div className="orch-field">
          <label htmlFor="orch-mode">Routing behavior</label>
          <select
            id="orch-mode"
            value={mode}
            disabled={disabled}
            aria-describedby="orch-mode-help"
            onChange={(event) => onModeChange(event.target.value as OrchestrationMode)}
          >
            <option value="supervisor">Supervisor model</option>
            <option value="sequential">Follow Agent order once</option>
            <option value="round_robin">Keep cycling through Agent order</option>
          </select>
          <span className="orch-field-help" id="orch-mode-help">
            The supervisor model picks whoever should speak next and can end the
            conversation early. The other two follow the Agent order you set: once through,
            or on repeat until the turn limit below stops it.
          </span>
        </div>

        {mode === "supervisor" && <SupervisorModelNotice />}

        <div className="orch-field">
          <label htmlFor="orch-max-steps">Turn limit</label>
          <input
            id="orch-max-steps"
            type="number"
            min={1}
            max={ORCHESTRATION_MAX_STEPS}
            step={1}
            value={maxSteps}
            disabled={disabled}
            aria-invalid={Boolean(errors.maxSteps)}
            aria-describedby={errors.maxSteps ? "orch-max-steps-error" : "orch-max-steps-help"}
            onChange={(event) => {
              onChange("maxSteps", Number(event.target.value));
              onClearError("maxSteps");
            }}
          />
          <span className="orch-field-help" id="orch-max-steps-help">
            Maximum number of Agent replies before the conversation is stopped for safety.
            1–1,000.
          </span>
          {errors.maxSteps && (
            <span className="orch-field-error" id="orch-max-steps-error">
              {errors.maxSteps}
            </span>
          )}
        </div>

        <div className="orch-field">
          <label htmlFor="orch-timeout">Per-Agent timeout (seconds)</label>
          <input
            id="orch-timeout"
            type="number"
            min={ORCHESTRATION_MIN_TIMEOUT_MS / 1_000}
            max={ORCHESTRATION_MAX_TIMEOUT_MS / 1_000}
            step={1}
            value={Math.round(perAgentTimeoutMs / 1_000)}
            disabled={disabled}
            aria-invalid={Boolean(errors.perAgentTimeoutMs)}
            aria-describedby={errors.perAgentTimeoutMs ? "orch-timeout-error" : "orch-timeout-help"}
            onChange={(event) => {
              onChange("perAgentTimeoutMs", Number(event.target.value) * 1_000);
              onClearError("perAgentTimeoutMs");
            }}
          />
          <span className="orch-field-help" id="orch-timeout-help">
            How long one Agent may take before its turn is abandoned. 1–3,600 seconds.
          </span>
          {errors.perAgentTimeoutMs && (
            <span className="orch-field-error" id="orch-timeout-error">
              {errors.perAgentTimeoutMs}
            </span>
          )}
        </div>
      </div>
    </details>
  );
}
