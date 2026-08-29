import { useCallback } from "react";
import type {
  Agent,
  CreateOrchestrationInput,
  ModelProviderDescriptor,
} from "../../types";
import { NewConversationDialog } from "./NewConversationDialog";
import { OrchestrationRunView } from "./OrchestrationRunView";
import { OrchestrationRunTabs } from "./OrchestrationRunTabs";
import type { UseOrchestrationResult } from "./use-orchestration";

interface OrchestrationWorkspaceProps {
  agents: Agent[];
  /** Owned by the app shell so the sidebar can list the same conversations. */
  orchestration: UseOrchestrationResult;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
  modelProviders?: ModelProviderDescriptor[];
}

export function OrchestrationWorkspace({
  agents,
  orchestration,
  composerOpen,
  onComposerOpenChange,
  modelProviders = [],
}: OrchestrationWorkspaceProps) {
  const { detail, detailLoading, sessions, loading, error } = orchestration;
  const replyCount = detail?.turns.length ?? 0;

  const handleStart = useCallback(
    (sessionId: string) => {
      void orchestration.startSession(sessionId).catch(() => undefined);
    },
    [orchestration],
  );

  const handleStop = useCallback(
    (sessionId: string) => {
      void orchestration.stopSession(sessionId).catch(() => undefined);
    },
    [orchestration],
  );

  const handleDelete = useCallback(
    (sessionId: string) => {
      void orchestration.deleteSession(sessionId).catch(() => undefined);
    },
    [orchestration],
  );

  const handleContinue = useCallback(
    (prompt: string, sessionId: string) => {
      void orchestration.continueSession(prompt, sessionId).catch(() => undefined);
    },
    [orchestration],
  );

  /**
   * "Start conversation" is one product action over the two existing lifecycle
   * calls. If the start half fails the session stays a draft and the
   * conversation header still offers Start, so nothing is lost.
   */
  const handleCreate = useCallback(
    async (input: CreateOrchestrationInput) => {
      const session = await orchestration.createSession(input);
      onComposerOpenChange(false);
      await orchestration.startSession(session.id).catch(() => undefined);
      return session;
    },
    [onComposerOpenChange, orchestration],
  );

  const openComposer = useCallback(() => {
    orchestration.clearError();
    onComposerOpenChange(true);
  }, [onComposerOpenChange, orchestration]);

  return (
    <section className="orch-workspace" aria-label="Multi-Agent conversation">
      {error && (
        <div className="orch-alert orch-alert-danger orch-workspace-alert" role="alert">
          <span>{error}</span>
          <button type="button" onClick={orchestration.clearError} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      <div className="orch-conversation-surface">
        {detailLoading && !detail ? (
          <div className="orch-run-loading" aria-busy="true" aria-label="Loading conversation">
            <div className="orch-skeleton orch-skeleton-title" />
            <div className="orch-skeleton orch-skeleton-line" />
            <div className="orch-skeleton orch-skeleton-line orch-skeleton-short" />
          </div>
        ) : detail ? (
          <>
            <OrchestrationRunView
              detail={detail}
              agents={agents}
              replyCount={replyCount}
              action={orchestration.action}
              onStart={handleStart}
              onStop={handleStop}
              onDelete={handleDelete}
              modelProviders={modelProviders}
            />
            <OrchestrationRunTabs
              detail={detail}
              agents={agents}
              action={orchestration.action}
              onContinue={handleContinue}
            />
          </>
        ) : (
          <div className="orch-intro" role="status">
            <span className="orch-empty-glyph" aria-hidden="true">◎</span>
            <h2>Put your Agents in one conversation.</h2>
            <p>
              Choose who joins and describe the task. They reply one at a time, each picking up
              from the reply before it, while you follow along.
            </p>
            <button type="button" className="button button-primary" onClick={openComposer}>
              <span aria-hidden="true">＋</span> New conversation
            </button>
            <span className="orch-intro-note">
              {agents.length === 0
                ? "No Agents available yet — create one in the Playground first."
                : sessions.length > 0
                  ? "Or open one from the sidebar."
                  : `${agents.length} ${agents.length === 1 ? "Agent" : "Agents"} ready to join.`}
              {loading && " Loading your conversations…"}
            </span>
          </div>
        )}
      </div>

      <NewConversationDialog
        open={composerOpen}
        agents={agents}
        disabled={orchestration.action !== null}
        onCreate={handleCreate}
        onClose={() => onComposerOpenChange(false)}
        modelProviders={modelProviders}
      />
    </section>
  );
}
