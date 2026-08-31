import { useEffect, useRef } from "react";
import {
  ORCHESTRATION_MAX_NAME_LENGTH,
  ORCHESTRATION_MAX_STEPS,
  ORCHESTRATION_MAX_TIMEOUT_MS,
  ORCHESTRATION_MIN_TIMEOUT_MS,
  type DraftErrors,
} from "./orchestration-utils";
import type { Agent, ModelProviderDescriptor, OrchestrationMode } from "../../types";
import { formatAgentWorkerModel } from "../WorkerModelFields";

type NumericField = "maxSteps" | "perAgentTimeoutMs";
type ClearableField = NumericField | "supervisorAgentId";

interface OrchestrationAdvancedSettingsProps {
  name: string;
  derivedName: string;
  mode: OrchestrationMode;
  agents: Agent[];
  supervisorAgentId?: string;
  modelProviders?: ModelProviderDescriptor[];
  maxSteps: number;
  perAgentTimeoutMs: number;
  errors: DraftErrors;
  disabled?: boolean;
  onNameChange: (name: string) => void;
  onChange: (field: NumericField, value: number) => void;
  onClearError: (field: ClearableField) => void;
  onModeChange: (mode: OrchestrationMode) => void;
  onSupervisorAgentChange: (agentId: string) => void;
}

export interface SupervisorAgentSelectorProps {
  agents: Agent[];
  supervisorAgentId?: string;
  modelProviders?: ModelProviderDescriptor[];
  error?: string;
  disabled?: boolean;
  onChange: (agentId: string) => void;
  onClearError?: () => void;
}

/**
 * Supervisor identity is deliberately separate from the participant picker.
 * The selected Agent's own worker assignment is the runtime model used to
 * make routing decisions, so show it as read-only context in each option.
 */
export function SupervisorAgentSelector({
  agents,
  supervisorAgentId = "",
  modelProviders = [],
  error,
  disabled = false,
  onChange,
  onClearError,
}: SupervisorAgentSelectorProps) {
  const selectedAgent = agents.find((agent) => agent.id === supervisorAgentId);

  return (
    <div className="orch-field">
      <label htmlFor="orch-supervisor-agent">Supervisor Agent</label>
      <select
        id="orch-supervisor-agent"
        value={supervisorAgentId}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "orch-supervisor-agent-error" : "orch-supervisor-agent-help"}
        onChange={(event) => {
          onChange(event.target.value);
          onClearError?.();
        }}
      >
        <option value="">Select an existing Agent</option>
        {agents.map((agent) => (
          <option value={agent.id} key={agent.id}>
            {agent.name} · {formatAgentWorkerModel(agent, modelProviders)}
          </option>
        ))}
      </select>
      <span className="orch-field-help" id="orch-supervisor-agent-help">
        This Agent routes the conversation. It stays separate from the participant roster;
        its assigned worker model is shown beside its name.
      </span>
      {selectedAgent && (
        <span className="orch-field-help" role="status">
          Assigned model: {formatAgentWorkerModel(selectedAgent, modelProviders)}
        </span>
      )}
      {error && (
        <span className="orch-field-error" id="orch-supervisor-agent-error">
          {error}
        </span>
      )}
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
  agents,
  supervisorAgentId = "",
  modelProviders = [],
  maxSteps,
  perAgentTimeoutMs,
  errors,
  disabled = false,
  onNameChange,
  onChange,
  onClearError,
  onModeChange,
  onSupervisorAgentChange,
}: OrchestrationAdvancedSettingsProps) {
  const advancedRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (errors.supervisorAgentId && advancedRef.current) {
      advancedRef.current.open = true;
    }
  }, [errors]);

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
            <option value="supervisor">Supervisor Agent</option>
            <option value="sequential">Follow Agent order once</option>
            <option value="round_robin">Keep cycling through Agent order</option>
          </select>
          <span className="orch-field-help" id="orch-mode-help">
            The selected Supervisor Agent picks whoever should speak next and can end the
            conversation early. The other two follow the Agent order you set: once through,
            or on repeat until the turn limit below stops it.
          </span>
        </div>

        {mode === "supervisor" && (
          <SupervisorAgentSelector
            agents={agents}
            supervisorAgentId={supervisorAgentId}
            modelProviders={modelProviders}
            error={errors.supervisorAgentId}
            disabled={disabled}
            onChange={onSupervisorAgentChange}
            onClearError={() => onClearError("supervisorAgentId")}
          />
        )}

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
