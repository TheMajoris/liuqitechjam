import { useEffect, useRef } from "react";
import type {
  Agent,
  ModelProviderDescriptor,
  OrchestrationParticipant,
  Project,
} from "../../types";
import type { OrchestrationDraft, WorkspaceDraft } from "./orchestration-utils";
import { OrchestrationComposer } from "./OrchestrationComposer";

interface NewConversationDialogProps {
  open: boolean;
  agents: Agent[];
  disabled?: boolean;
  mode?: "workspace" | "conversation";
  workspace?: Project | null;
  initialParticipants?: OrchestrationParticipant[];
  onCreate?: (input: OrchestrationDraft) => Promise<unknown>;
  onCreateWorkspace?: (input: WorkspaceDraft) => Promise<unknown>;
  onClose: () => void;
  modelProviders?: ModelProviderDescriptor[];
}

/**
 * Setup lives in a modal so the workspace itself stays a conversation. A
 * native dialog is used for the focus containment, backdrop, and Escape
 * handling browsers already provide.
 */
export function NewConversationDialog({
  open,
  agents,
  disabled = false,
  onCreate,
  onCreateWorkspace,
  onClose,
  modelProviders = [],
  mode = "conversation",
  workspace = null,
  initialParticipants = [],
}: NewConversationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className="orch-dialog"
      ref={dialogRef}
      aria-labelledby="orch-dialog-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The backdrop is the dialog element itself; its content sits in a
        // child, so a click landing on the dialog is a click outside.
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className="orch-dialog-body">
        <div className="orch-dialog-heading">
          <div>
            <span className="orch-eyebrow">
              {mode === "workspace" ? "New Workspace" : "New conversation"}
            </span>
            <h2 id="orch-dialog-heading">
              {mode === "workspace"
                ? "Create a shared home for your work."
                : `What should ${workspace?.name ?? "this Workspace"} work on?`}
            </h2>
          </div>
          <button
            type="button"
            className="orch-icon-button"
            aria-label="Close new conversation"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {open && (
          <OrchestrationComposer
            agents={agents}
            modelProviders={modelProviders}
            disabled={disabled}
            onCreate={onCreate}
            onCreateWorkspace={onCreateWorkspace}
            onCancel={onClose}
            mode={mode}
            workspace={workspace}
            initialParticipants={initialParticipants}
          />
        )}
      </div>
    </dialog>
  );
}
