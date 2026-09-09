import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { Storage } from "../store.js";
import { ORCHESTRATION_LIMITS } from "./schemas.js";
import type {
  OrchestrationExecutionHooks,
} from "./orchestrator.js";
import {
  appendEvent,
  boundedSafeText,
  now,
  safeErrorMessage,
  safeInputSummary,
  statusIsTerminal,
  type OrchestrationEventFields,
} from "./orchestration-journal.js";
import type {
  OrchestrationErrorCode,
  OrchestrationParticipant,
} from "./types.js";
import { buildCheckpointResumeState } from "./checkpoint-resume-state.js";
import type { OrchestrationWorkspaceCycle } from "./orchestration-runtime.js";
import type { OrchestrationWorkspaceRecovery } from "../projects/workspace-recovery-facade.js";
import type { WorkspaceCheckpoint } from "../projects/workspace-checkpoint-types.js";

/** Runtime state shared by the service and its persistence hooks. */
export interface OrchestrationHookContext {
  id: string;
  stepOffset: number;
  controller: AbortController;
  currentRunId: string | null;
  /** Present for a checkpoint-enabled cycle; publication becomes mandatory. */
  workspace?: OrchestrationWorkspaceCycle | undefined;
}

export interface OrchestrationHookDependencies {
  store: Storage;
  validateParticipant(
    participant: OrchestrationParticipant,
    options?: { allowErrored?: boolean },
  ): Promise<void>;
  cancelChildRun(runId: string): Promise<void>;
  /** Required when the context carries a workspace cycle. */
  workspaceRecovery?: Pick<
    OrchestrationWorkspaceRecovery,
    "publishTurnCheckpoint" | "invalidateCandidate" | "auditCheckpointCreated"
  > | undefined;
}

/** Stable error used when an execution callback observes a lifecycle race. */
export class DispatchLifecycleError extends Error {
  readonly orchestrationErrorCode: OrchestrationErrorCode;

  constructor(code: OrchestrationErrorCode, message: string) {
    super(message);
    this.name = "DispatchLifecycleError";
    this.orchestrationErrorCode = code;
  }
}

function orchestrationStopped(): DispatchLifecycleError {
  return new DispatchLifecycleError(
    "ORCHESTRATION_STOPPED",
    "Orchestration stop requested",
  );
}

/**
 * Build the platform-owned execution hooks for one active session. The
 * workflow engine only sees this small hook interface; event/turn persistence
 * and lifecycle checks stay behind this module.
 */
export function createOrchestrationExecutionHooks(
  context: OrchestrationHookContext,
  dependencies: OrchestrationHookDependencies,
): OrchestrationExecutionHooks {
  const { store, validateParticipant, cancelChildRun } = dependencies;

  return {
    onSupervisorDecision: async ({ action, participantId, stepIndex, reason }) => {
      if (context.controller.signal.aborted) throw orchestrationStopped();
      await store.mutate((database) => {
        const session = database.orchestrations.find(
          (item) => item.id === context.id,
        );
        if (!session) throw new HttpError(404, "Orchestration not found");
        if (statusIsTerminal(session.status)) return;
        if (session.status === "stopping" || context.controller.signal.aborted) {
          throw orchestrationStopped();
        }

        const participant = participantId
          ? session.participants.find((item) => item.id === participantId)
          : undefined;
        if (action === "invoke" && !participant) {
          throw new DispatchLifecycleError(
            "SUPERVISOR_INVALID_SELECTION",
            "Supervisor selected an unconfigured participant",
          );
        }
        session.updatedAt = now();
        appendEvent(database, session, "supervisor_decision", {
          ...(participant
            ? { participantId: participant.id, agentId: participant.agentId }
            : {}),
          ...(action === "complete"
            ? { completionReason: "supervisor_completed" }
            : {}),
          safeSummary:
            reason !== undefined && reason.trim().length > 0
              ? reason
              : action === "complete"
                ? "Conversation completed at step " + String(stepIndex)
                : (participant?.role ?? "Configured participant") +
                  " selected as next participant",
        });
      });
    },

    onBeforeDispatch: async ({ participant, prompt }) => {
      if (context.controller.signal.aborted) throw orchestrationStopped();
      await validateParticipant(participant);
      await store.mutate((database) => {
        const session = database.orchestrations.find(
          (item) => item.id === context.id,
        );
        if (!session) throw new HttpError(404, "Orchestration not found");
        if (session.status === "stopping" || context.controller.signal.aborted) {
          throw orchestrationStopped();
        }
        session.currentParticipantId = participant.id;
        session.updatedAt = now();
      });
      void prompt;
    },

    onHandoffApplied: async ({ participant, envelope }) => {
      await store.mutate((database) => {
        const session = database.orchestrations.find(
          (item) => item.id === context.id,
        );
        if (!session || statusIsTerminal(session.status)) return;
        session.updatedAt = now();
        appendEvent(database, session, "handoff_applied", {
          participantId: participant.id,
          agentId: participant.agentId,
          safeSummary:
            "Applied the previous participant result to " + participant.role,
        });
        void envelope;
      });
    },

    onRunAccepted: async ({ participant, prompt, runId, stepIndex }) => {
      // Set this before awaiting persistence so stopSession can cancel a Run
      // accepted in the same turn, even if its event write is still queued.
      context.currentRunId = runId;
      await store.mutate((database) => {
        const session = database.orchestrations.find(
          (item) => item.id === context.id,
        );
        if (!session) throw new HttpError(404, "Orchestration not found");
        if (statusIsTerminal(session.status)) return;
        const createdAt = now();
        session.currentParticipantId = participant.id;
        session.currentRunId = runId;
        session.updatedAt = createdAt;
        if (!database.orchestrationTurns.some((turn) => turn.runId === runId)) {
          database.orchestrationTurns.push({
            id: randomUUID(),
            sessionId: context.id,
            participantId: participant.id,
            agentId: participant.agentId,
            runId,
            position: participant.position,
            stepIndex: context.stepOffset + stepIndex,
            ...(context.workspace === undefined
              ? {}
              : { executionCycleId: context.workspace.cycleId }),
            status: "dispatched",
            safeInputSummary: safeInputSummary(prompt),
            safeOutput: null,
            outputTruncated: false,
            errorCode: null,
            createdAt,
            completedAt: null,
          });
        }
        appendEvent(database, session, "participant_dispatched", {
          participantId: participant.id,
          agentId: participant.agentId,
          runId,
          safeSummary: "Participant dispatched at step " + String(stepIndex + 1),
        });
      });
      if (context.controller.signal.aborted) {
        await cancelChildRun(runId);
        throw orchestrationStopped();
      }
    },

    onRunCompleted: async ({ participant, runId, envelope, stepIndex, nextState, workspaceCheckpointId }) => {
      const workspace = context.workspace;
      const recovery = dependencies.workspaceRecovery;
      if (workspace !== undefined && (recovery === undefined || workspaceCheckpointId === undefined || nextState === undefined)) {
        // A checkpoint-enabled turn without a candidate or a next state is
        // not a recoverable success. Stop here; never dispatch the next Agent.
        if (workspaceCheckpointId !== undefined) {
          await recovery?.invalidateCandidate(workspaceCheckpointId, "CHECKPOINT_NOT_READY").catch(() => undefined);
        }
        throw new DispatchLifecycleError(
          "CHECKPOINT_PUBLISH_FAILED",
          "The turn completed without a publishable source checkpoint",
        );
      }
      context.currentRunId = null;
      let published: WorkspaceCheckpoint | null = null;
      try {
        published = await store.mutate((database) => {
          const session = database.orchestrations.find(
            (item) => item.id === context.id,
          );
          if (!session || statusIsTerminal(session.status)) return null;
          const completedAt = now();
          const turn = database.orchestrationTurns.find(
            (candidate) =>
              candidate.runId === runId && candidate.sessionId === context.id,
          );
          if (turn && turn.status === "dispatched") {
            turn.status = "completed";
            turn.safeOutput = boundedSafeText(
              envelope.content,
              ORCHESTRATION_LIMITS.maxSafeOutputLength,
              "[OUTPUT TRUNCATED]",
            );
            turn.outputTruncated = envelope.truncated;
            turn.completedAt = completedAt;
          }
          session.currentParticipantId = null;
          session.currentRunId = null;
          session.stepIndex = Math.max(
            session.stepIndex,
            context.stepOffset + stepIndex + 1,
          );
          session.updatedAt = completedAt;
          const fields: OrchestrationEventFields = {
            participantId: participant.id,
            agentId: participant.agentId,
            runId,
            safeSummary: "Participant completed",
          };
          if (turn?.createdAt) {
            fields.durationMs = Math.max(
              0,
              Date.parse(completedAt) - Date.parse(turn.createdAt),
            );
          }
          appendEvent(database, session, "run_completed", fields);

          if (workspace === undefined || recovery === undefined || workspaceCheckpointId === undefined || nextState === undefined) {
            return null;
          }
          // Checkpoint-enabled: link the turn, save the exact continuation,
          // promote the candidate, and advance the accepted branch head, all
          // in this same transaction.
          const cycle = database.workspaceExecutionCycles.find(
            (item) => item.id === workspace.cycleId,
          );
          if (!turn || !cycle) {
            throw new DispatchLifecycleError(
              "CHECKPOINT_PUBLISH_FAILED",
              "The accepted turn or its execution cycle is missing",
            );
          }
          const parent = database.workspaceCheckpoints
            .filter(
              (item) =>
                item.executionCycleId === cycle.id && item.state === "ready" && item.kind !== "safety",
            )
            .sort((left, right) => right.ordinal - left.ordinal)[0];
          const resume = buildCheckpointResumeState(cycle.initialState, {
            nextEngineStepIndex: nextState.nextStepIndex,
            lastRunId: nextState.lastRunId,
            lastOutput: nextState.lastOutput,
            turns: nextState.turns,
            parentCheckpointId: parent?.id ?? null,
          });
          const checkpoint = recovery.publishTurnCheckpoint(database, {
            checkpointId: workspaceCheckpointId,
            runId,
            executionCycleId: cycle.id,
            turnId: turn.id,
            participantId: participant.id,
            stepIndex: context.stepOffset + stepIndex,
            resume,
          });
          turn.workspaceCheckpointId = checkpoint.id;
          turn.executionCycleId = cycle.id;
          if (!cycle.acceptedTurnIds.includes(turn.id)) cycle.acceptedTurnIds.push(turn.id);
          cycle.status = "running";
          session.acceptedContextCheckpointId = checkpoint.id;
          appendEvent(database, session, "workspace_checkpoint_created", {
            participantId: participant.id,
            agentId: participant.agentId,
            runId,
            checkpointId: checkpoint.id,
            safeSummary:
              "Workspace checkpoint #" + String(checkpoint.ordinal) + " saved after " + participant.role,
          });
          return structuredClone(checkpoint);
        });
      } catch (error) {
        if (workspace !== undefined && workspaceCheckpointId !== undefined) {
          await recovery?.invalidateCandidate(workspaceCheckpointId, "CHECKPOINT_NOT_READY").catch(() => undefined);
        }
        if (error instanceof DispatchLifecycleError) throw error;
        throw new DispatchLifecycleError(
          "CHECKPOINT_PUBLISH_FAILED",
          "The turn's source checkpoint could not be published",
        );
      }
      if (published !== null) {
        await recovery?.auditCheckpointCreated(published).catch(() => undefined);
      }
    },

    onParticipantFailed: async ({ participant, runId, error, errorCode }) => {
      if (runId === null || context.currentRunId === runId) {
        context.currentRunId = null;
      }
      await store.mutate((database) => {
        const session = database.orchestrations.find(
          (item) => item.id === context.id,
        );
        if (!session || statusIsTerminal(session.status)) return;
        const failedAt = now();
        const turn = runId
          ? database.orchestrationTurns.find(
              (candidate) =>
                candidate.runId === runId && candidate.sessionId === context.id,
            )
          : undefined;
        if (turn && turn.status === "dispatched") {
          turn.status =
            errorCode === "RUN_TIMED_OUT"
              ? "timed_out"
              : errorCode === "ORCHESTRATION_STOPPED" ||
                  errorCode === "RUN_CANCELLED"
                ? "cancelled"
                : "failed";
          turn.errorCode = errorCode;
          turn.completedAt = failedAt;
          // Read the model off the child Run rather than the Agent: the Agent's
          // assignment can be changed (often in response to this very failure)
          // before anyone reads the transcript, and the reply must name the
          // model that actually failed.
          const modelId = database.runs
            .find((candidate) => candidate.id === runId)
            ?.modelSnapshot?.modelRef.modelId?.trim();
          if (modelId) turn.modelId = modelId.slice(0, ORCHESTRATION_LIMITS.maxModelIdLength);
        }
        session.currentParticipantId = null;
        session.currentRunId = null;
        session.errorCode = errorCode;
        session.errorMessage = safeErrorMessage(error);
        session.updatedAt = failedAt;
        if (
          runId !== null &&
          (errorCode === "ORCHESTRATION_STOPPED" || errorCode === "RUN_CANCELLED")
        ) {
          appendEvent(database, session, "child_run_cancelled", {
            participantId: participant.id,
            agentId: participant.agentId,
            runId,
            safeSummary: "Accepted child Run was cancelled",
            errorCode,
          });
        }
        appendEvent(database, session, "participant_failed", {
          participantId: participant.id,
          agentId: participant.agentId,
          ...(runId === null ? {} : { runId }),
          safeSummary: safeErrorMessage(error),
          errorCode,
        });
      });
    },
  };
}
