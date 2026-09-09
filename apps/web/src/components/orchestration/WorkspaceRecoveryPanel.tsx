import type { WorkspaceRecoveryView } from "../../types";
import { isRecoveryPending, recoveryStageLabel } from "./orchestration-utils";

interface WorkspaceRecoveryPanelProps {
  recovery: WorkspaceRecoveryView;
  /** True while a recovery request from this client is still in flight. */
  busy?: boolean;
  /** Carry on a recovery that stalled after its restore step. */
  onResume?: ((operationId: string) => void) | undefined;
  /** Put the files back to the safety checkpoint the recovery saved first. */
  onRestoreSafety?: ((operationId: string) => void) | undefined;
}

/**
 * Where a restore-and-resume stands, from the durable operation record.
 *
 * The panel says only what the server has recorded: an accepted request is
 * shown as "saving", not "done", and it goes quiet once the stage is settled.
 * A stalled recovery keeps its two ways out in view until one of them lands.
 */
export function WorkspaceRecoveryPanel({
  recovery,
  busy = false,
  onResume,
  onRestoreSafety,
}: WorkspaceRecoveryPanelProps) {
  const pending = isRecoveryPending(recovery.stage);
  const needsAttention = recovery.stage === "recovery_required";
  const failed = recovery.stage === "failed";
  const tone = needsAttention || failed ? "is-attention" : "is-pending";

  return (
    <section
      className={"orch-recovery-panel " + tone}
      role={needsAttention || failed ? "alert" : "status"}
      aria-live="polite"
      aria-busy={pending || busy}
    >
      <div className="orch-recovery-copy">
        <span className="orch-eyebrow">Workspace recovery</span>
        <strong>{recoveryStageLabel(recovery.stage, recovery.errorCode)}</strong>
        {needsAttention && (
          <span className="orch-recovery-note">
            The source files may be part-way between checkpoints. Resume to finish the
            restore and continue the conversation, or put the files back to the safety
            checkpoint saved before it began.
          </span>
        )}
        {failed && (
          <span className="orch-recovery-note">
            The restore did not go through and no files were changed. Try again from
            the turn you chose, or continue with the current files.
          </span>
        )}
      </div>
      {needsAttention && (
        <div className="orch-recovery-actions">
          {onResume && (
            <button
              type="button"
              className="orch-button orch-button-primary"
              disabled={busy}
              onClick={() => onResume(recovery.operationId)}
            >
              {busy ? "Working…" : "Resume recovery"}
            </button>
          )}
          {onRestoreSafety && (
            <button
              type="button"
              className="orch-button"
              disabled={busy || !recovery.safetyCheckpointId}
              title={
                recovery.safetyCheckpointId
                  ? undefined
                  : "No safety checkpoint was saved for this recovery."
              }
              onClick={() => onRestoreSafety(recovery.operationId)}
            >
              Restore safety checkpoint
            </button>
          )}
        </div>
      )}
    </section>
  );
}
