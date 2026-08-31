import { useEffect, useMemo, useState } from "react";
import type {
  Agent,
  ModelProviderDescriptor,
  OrchestrationParticipant,
  Project,
} from "../../types";
import {
  type DraftErrors,
  defaultSupervisorAgentId,
  deriveSessionName,
  isOrderedMode,
  normalizeParticipants,
  validateDraft,
  validateWorkspaceTask,
  withDerivedLabels,
  type OrchestrationDraft,
  type WorkspaceDraft,
} from "./orchestration-utils";
import {
  OrchestrationAdvancedSettings,
  SupervisorAgentSelector,
} from "./OrchestrationAdvancedSettings";
import { AgentPicker } from "./AgentPicker";

interface OrchestrationComposerProps {
  agents: Agent[];
  disabled?: boolean;
  /** Conversation callback; omitted for the Workspace creation variant. */
  onCreate?: (input: OrchestrationDraft) => Promise<unknown>;
  /** Workspace callback; creates the persistent container before any run. */
  onCreateWorkspace?: (input: WorkspaceDraft) => Promise<unknown>;
  onCancel?: () => void;
  modelProviders?: ModelProviderDescriptor[];
  mode?: "workspace" | "conversation";
  workspace?: Project | null;
  initialParticipants?: OrchestrationParticipant[];
}

/** Automatic turn taking is the product default for new Conversations. */
const initialDraft: OrchestrationDraft = {
  name: "",
  originalPrompt: "",
  participants: [],
  mode: "supervisor",
  supervisorAgentId: "",
  maxSteps: 20,
  perAgentTimeoutMs: 300_000,
};

const initialWorkspaceDraft: WorkspaceDraft = {
  name: "",
  description: "",
  participants: [],
  initialTask: "",
  mode: "supervisor",
  supervisorAgentId: "",
  maxSteps: 20,
  perAgentTimeoutMs: 300_000,
};

export function OrchestrationComposer({
  agents,
  disabled = false,
  onCreate,
  onCreateWorkspace,
  onCancel,
  modelProviders = [],
  mode = "conversation",
  workspace = null,
  initialParticipants = [],
}: OrchestrationComposerProps) {
  const initialConversationParticipants = normalizeParticipants(initialParticipants);
  const [draft, setDraft] = useState<OrchestrationDraft>(() => ({
    ...initialDraft,
    participants: initialConversationParticipants,
    supervisorAgentId: defaultSupervisorAgentId(
      initialConversationParticipants,
      undefined,
      agents[0]?.id,
    ),
  }));
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft>(() => ({
    ...initialWorkspaceDraft,
    participants: initialConversationParticipants,
    supervisorAgentId: defaultSupervisorAgentId(
      initialConversationParticipants,
      undefined,
      agents[0]?.id,
    ),
  }));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Agent loading can finish after the composer mounts. Fill an unset
  // supervisor once, while preserving any explicit Advanced override.
  useEffect(() => {
    const fallbackAgentId = agents[0]?.id;
    if (!fallbackAgentId) return;
    if (mode === "workspace") {
      setWorkspaceDraft((current) =>
        current.supervisorAgentId?.trim()
          ? current
          : {
              ...current,
              supervisorAgentId: defaultSupervisorAgentId(
                current.participants,
                undefined,
                fallbackAgentId,
              ),
            },
      );
      return;
    }
    setDraft((current) =>
      current.supervisorAgentId?.trim()
        ? current
        : {
            ...current,
            supervisorAgentId: defaultSupervisorAgentId(
              current.participants,
              undefined,
              fallbackAgentId,
            ),
          },
    );
  }, [agents, mode]);

  const derivedName = useMemo(
    () => (draft.originalPrompt.trim() ? deriveSessionName(draft.originalPrompt) : ""),
    [draft.originalPrompt],
  );

  const updateParticipants = (participants: OrchestrationParticipant[]) => {
    const normalizedParticipants = normalizeParticipants(participants);
    setDraft((current) => ({
      ...current,
      participants: normalizedParticipants,
      supervisorAgentId: defaultSupervisorAgentId(
        normalizedParticipants,
        current.supervisorAgentId,
        agents[0]?.id,
      ),
    }));
    setErrors((current) => ({ ...current, participants: undefined }));
  };

  const updateWorkspaceParticipants = (participants: OrchestrationParticipant[]) => {
    const normalizedParticipants = normalizeParticipants(participants);
    setWorkspaceDraft((current) => ({
      ...current,
      participants: normalizedParticipants,
      supervisorAgentId: defaultSupervisorAgentId(
        normalizedParticipants,
        current.supervisorAgentId,
        agents[0]?.id,
      ),
    }));
    setErrors((current) => ({ ...current, participants: undefined }));
  };

  const focusFirstError = (
    event: React.FormEvent<HTMLFormElement>,
    nextErrors: DraftErrors,
  ) => {
    const form = event.currentTarget;
    const target = nextErrors.name
      ? form.querySelector<HTMLElement>("[aria-invalid='true']")
      : nextErrors.supervisorAgentId
        ? form.querySelector<HTMLElement>("#orch-supervisor-agent")
      : nextErrors.participants
        ? form.querySelector<HTMLElement>(".orch-add-agent, .orch-agent-chip")
        : form.querySelector<HTMLElement>("[aria-invalid='true']");
    target?.focus();
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);

    if (mode === "workspace") {
      const nextErrors = validateWorkspaceTask(workspaceDraft, agents);
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) {
        focusFirstError(event, nextErrors);
        return;
      }
      if (!onCreateWorkspace) return;
      setSubmitting(true);
      try {
        await onCreateWorkspace({
          ...workspaceDraft,
          name: workspaceDraft.name.trim(),
          description: workspaceDraft.description?.trim() || undefined,
          initialTask: workspaceDraft.initialTask.trim(),
          ...(workspaceDraft.supervisorAgentId?.trim()
            ? { supervisorAgentId: workspaceDraft.supervisorAgentId.trim() }
            : {}),
          participants: normalizeParticipants(workspaceDraft.participants).map((participant) => ({
            ...participant,
            role:
              participant.role.trim() ||
              agents.find((agent) => agent.id === participant.agentId)?.name ||
              "Agent",
          })),
        });
        setWorkspaceDraft(initialWorkspaceDraft);
      } catch (reason) {
        setSubmitError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // A conversation composer is always scoped to the selected Workspace.
    // Keep that scope on the request even when the user leaves both task and
    // participants blank so the server can persist an idle draft without
    // weakening the text-only orchestration contract.
    const conversationDraft = workspace?.id
      ? { ...draft, projectId: workspace.id }
      : draft;
    const nextErrors = validateDraft(conversationDraft, agents);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstError(event, nextErrors);
      return;
    }
    if (!onCreate) return;

    setSubmitting(true);
    try {
      await onCreate(withDerivedLabels(conversationDraft, agents));
      setDraft(initialDraft);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const busy = disabled || submitting;

  if (mode === "workspace") {
    return (
      <form className="orch-composer workspace-composer" onSubmit={submit}>
        {submitError && (
          <div className="orch-alert orch-alert-danger" role="alert">
            <span>{submitError}</span>
          </div>
        )}

        <div className="orch-field">
          <label htmlFor="workspace-name">Workspace name</label>
          <input
            id="workspace-name"
            value={workspaceDraft.name}
            disabled={busy}
            maxLength={80}
            placeholder="Product launch"
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? "workspace-name-error" : "workspace-name-help"}
            onChange={(event) => {
              setWorkspaceDraft((current) => ({ ...current, name: event.target.value }));
              setErrors((current) => ({ ...current, name: undefined }));
            }}
          />
          <span className="orch-field-help" id="workspace-name-help">
            A shared home for files, Agents, and many Conversations.
          </span>
          {errors.name && (
            <span className="orch-field-error" id="workspace-name-error">{errors.name}</span>
          )}
        </div>

        <div className="orch-field">
          <label htmlFor="workspace-description">
            Description <span className="orch-optional">Optional</span>
          </label>
          <textarea
            id="workspace-description"
            value={workspaceDraft.description ?? ""}
            disabled={busy}
            maxLength={500}
            rows={2}
            placeholder="What belongs in this Workspace?"
            onChange={(event) =>
              setWorkspaceDraft((current) => ({ ...current, description: event.target.value }))
            }
          />
        </div>

        <section className="orch-composer-section" aria-labelledby="workspace-agents-heading">
          <div className="orch-composer-section-heading">
            <div>
              <span className="orch-eyebrow">Workspace members</span>
              <h3 id="workspace-agents-heading">
                Invite Agents <span className="orch-optional">Optional</span>
              </h3>
            </div>
            <span className="orch-field-help">You can add more later.</span>
          </div>
          <AgentPicker
            participants={workspaceDraft.participants}
            agents={agents}
            modelProviders={modelProviders}
            disabled={busy}
            error={errors.participants}
            showOrder={false}
            onChange={updateWorkspaceParticipants}
          />
        </section>

        <div className="orch-field workspace-task-field">
          <label htmlFor="workspace-task">
            Initial task <span className="orch-optional">Optional</span>
          </label>
          <textarea
            id="workspace-task"
            value={workspaceDraft.initialTask}
            disabled={busy}
            maxLength={50_000}
            rows={4}
            placeholder="Leave blank to open an idle Workspace, or tell the Agents what to do first…"
            onChange={(event) => {
              setWorkspaceDraft((current) => ({ ...current, initialTask: event.target.value }));
              setErrors((current) => ({
                ...current,
                originalPrompt: undefined,
                participants: undefined,
              }));
            }}
          />
          <span className="orch-field-help">
            Adding a task starts the first Conversation. No task means nothing runs yet.
          </span>
        </div>

        <SupervisorAgentSelector
          agents={agents}
          modelProviders={modelProviders}
          supervisorAgentId={workspaceDraft.supervisorAgentId}
          error={errors.supervisorAgentId}
          disabled={busy}
          onChange={(supervisorAgentId) => {
            setWorkspaceDraft((current) => ({ ...current, supervisorAgentId }));
            setErrors((current) => ({ ...current, supervisorAgentId: undefined }));
          }}
        />

        <div className="orch-composer-footer">
          <span className="orch-safety-note">
            <span aria-hidden="true">⌁</span> Workspaces keep shared files together;
            Conversations are independent tasks inside them.
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
            <button
              className="orch-button orch-button-primary"
              type="submit"
              disabled={busy || !workspaceDraft.name.trim()}
            >
              {submitting
                ? "Creating…"
                : workspaceDraft.initialTask.trim()
                  ? "Create & start conversation"
                  : "Create workspace"}
              {!submitting && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </div>
      </form>
    );
  }

  const canStartImmediately =
    Boolean(draft.originalPrompt.trim()) &&
    draft.participants.length > 0 &&
    draft.participants.every((participant) => participant.agentId.trim()) &&
    (draft.mode !== "supervisor" || Boolean(draft.supervisorAgentId?.trim()));

  return (
    <form className="orch-composer" onSubmit={submit}>
      {submitError && (
        <div className="orch-alert orch-alert-danger" role="alert">
          <span>{submitError}</span>
        </div>
      )}

      <div className="orch-workspace-context" role="status">
        <span className="orch-eyebrow">Workspace</span>
        <strong>{workspace?.name ?? "Selected workspace"}</strong>
        <span className="orch-field-help">
          This Conversation will reuse its shared files and members.
        </span>
      </div>

      <AgentPicker
        participants={draft.participants}
        agents={agents}
        modelProviders={modelProviders}
        disabled={busy}
        error={errors.participants}
        showOrder={isOrderedMode(draft.mode)}
        onChange={updateParticipants}
      />

      <div className="orch-field">
        <label htmlFor="orch-prompt">
          Task <span className="orch-optional">Optional</span>
        </label>
        <textarea
          id="orch-prompt"
          value={draft.originalPrompt}
          disabled={busy}
          maxLength={50_000}
          rows={4}
          placeholder="Describe the first task, or leave blank to create a draft…"
          aria-invalid={Boolean(errors.originalPrompt)}
          aria-describedby={errors.originalPrompt ? "orch-prompt-error" : "orch-prompt-help"}
          onChange={(event) => {
            setDraft((current) => ({ ...current, originalPrompt: event.target.value }));
            setErrors((current) => ({
              ...current,
              originalPrompt: undefined,
              ...(event.target.value.trim() ? {} : { supervisorAgentId: undefined }),
            }));
          }}
        />
        <span className="orch-field-help" id="orch-prompt-help">
          Everyone in this Conversation starts from this.
        </span>
        {errors.originalPrompt && (
          <span className="orch-field-error" id="orch-prompt-error">{errors.originalPrompt}</span>
        )}
      </div>

      <OrchestrationAdvancedSettings
        name={draft.name}
        derivedName={derivedName}
        mode={draft.mode}
        agents={agents}
        supervisorAgentId={draft.supervisorAgentId}
        modelProviders={modelProviders}
        maxSteps={draft.maxSteps}
        perAgentTimeoutMs={draft.perAgentTimeoutMs}
        errors={errors}
        disabled={busy}
        onNameChange={(name) => setDraft((current) => ({ ...current, name }))}
        onChange={(field, value) => setDraft((current) => ({ ...current, [field]: value }))}
        onClearError={(field) => setErrors((current) => ({ ...current, [field]: undefined }))}
        onModeChange={(nextMode) => {
          setDraft((current) => ({
            ...current,
            mode: nextMode,
            supervisorAgentId:
              nextMode === "supervisor"
                ? defaultSupervisorAgentId(
                    current.participants,
                    current.supervisorAgentId,
                    agents[0]?.id,
                  )
                : current.supervisorAgentId,
          }));
          setErrors((current) => ({ ...current, supervisorAgentId: undefined }));
        }}
        onSupervisorAgentChange={(supervisorAgentId) => {
          setDraft((current) => ({ ...current, supervisorAgentId }));
          setErrors((current) => ({ ...current, supervisorAgentId: undefined }));
        }}
      />

      <div className="orch-composer-footer">
        {errors.supervisorAgentId && (
          <span className="orch-field-error" role="alert">
            {errors.supervisorAgentId} Open Advanced settings to choose a Supervisor Agent.
          </span>
        )}
        <span className="orch-safety-note">
          <span aria-hidden="true">⌁</span> Each Conversation keeps its own history. Replies
          pass along as bounded, untrusted text.
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
            {submitting
              ? "Creating…"
              : canStartImmediately
                ? "Start conversation"
                : "Create conversation"}
            {!submitting && <span aria-hidden="true">→</span>}
          </button>
        </div>
      </div>
    </form>
  );
}
