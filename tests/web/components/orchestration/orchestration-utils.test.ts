import { describe, expect, it } from "vitest";
import {
  checkpointForTurn,
  eventLabel,
  humanizeAgentRunFailure,
  humanizeFailure,
  isRecoveryPending,
  recoveryStageLabel,
  validateDraft,
  validateWorkspaceTask,
} from "../../../../apps/web/src/components/orchestration/orchestration-utils";
import type {
  Agent,
  OrchestrationTurn,
  WorkspaceCheckpointView,
} from "../../../../apps/web/src/types";
import type {
  OrchestrationDraft,
  OrchestrationParticipant,
  WorkspaceDraft,
} from "../../../../apps/web/src/components/orchestration/orchestration-utils";

const idleWorkspaceDraft: OrchestrationDraft = {
  name: "",
  originalPrompt: "",
  projectId: "workspace-1",
  participants: [],
  mode: "supervisor",
  maxSteps: 20,
  perAgentTimeoutMs: 300_000,
};

const selectedParticipants: OrchestrationParticipant[] = [
  { id: "participant-1", agentId: "agent-1", role: "", position: 0 },
  { id: "participant-2", agentId: "agent-2", role: "", position: 1 },
];

describe("orchestration draft validation", () => {
  it("accepts an empty Workspace draft in supervisor mode", () => {
    // Routing is a server-wide model, so supervisor mode asks nothing of the
    // draft and an idle Workspace stays saveable with no Agents at all.
    expect(validateDraft(idleWorkspaceDraft, [])).toEqual({});
  });

  it("accepts a runnable supervisor conversation without designating an Agent", () => {
    expect(
      validateDraft(
        {
          ...idleWorkspaceDraft,
          originalPrompt: "Review the release plan",
          participants: selectedParticipants,
        },
        [{ id: "agent-1" } as Agent, { id: "agent-2" } as Agent],
      ),
    ).toEqual({});
  });

  it("still rejects a roster that names an Agent which no longer exists", () => {
    const errors = validateDraft(
      {
        ...idleWorkspaceDraft,
        originalPrompt: "Review the release plan",
        participants: selectedParticipants,
      },
      [{ id: "agent-1" } as Agent],
    );

    expect(errors.participants).toContain("no longer available");
  });

  it("validates a Workspace task without a supervisor Agent", () => {
    const draft: WorkspaceDraft = {
      name: "WebApp",
      participants: selectedParticipants,
      initialTask: "Ship the change",
      mode: "supervisor",
      maxSteps: 20,
      perAgentTimeoutMs: 300_000,
    };

    expect(
      validateWorkspaceTask(draft, [
        { id: "agent-1" } as Agent,
        { id: "agent-2" } as Agent,
      ]),
    ).toEqual({});
  });
});

describe("runtime failure wording", () => {
  it("shows the actionable provider-limit recovery message in both surfaces", () => {
    const expected =
      "This model is paused because its provider inference limit was reached. Review Safe Experience Mode in the provider's Model Activation settings, or choose another available model, then retry.";

    expect(humanizeFailure("MODEL_INFERENCE_LIMIT_EXCEEDED")).toBe(expected);
    expect(humanizeAgentRunFailure("MODEL_INFERENCE_LIMIT_EXCEEDED", "provider details")).toBe(
      expected,
    );
  });

  it("distinguishes a Project write denial from a web-tool denial", () => {
    expect(humanizeFailure("PROJECT_PERMISSION_DENIED")).toBe(
      "This Agent is not allowed to write to the Workspace. Add Allow Agent runs (agent.invoke) and Edit workspace files (project.write) to the Agent's role, make sure it has editable Workspace membership, then retry.",
    );
    expect(humanizeFailure("PROJECT_PERMISSION_DENIED")).not.toBe(
      humanizeFailure("WEB_TOOL_PERMISSION_DENIED"),
    );
  });

  it("does not expose unknown runtime error text", () => {
    expect(humanizeAgentRunFailure(undefined, "a provider request id")).toBe(
      "The Agent could not complete this run.",
    );
  });

  it("explains a failed checkpoint capture without discarding the reply", () => {
    const expected =
      "The Agent finished, but its Workspace files could not be checkpointed. Its reply is kept; restore an earlier checkpoint or retry once the Workspace is settled.";

    expect(humanizeFailure("CHECKPOINT_CAPTURE_FAILED")).toBe(expected);
    expect(humanizeAgentRunFailure("CHECKPOINT_CAPTURE_FAILED", "git detail")).toBe(expected);
    expect(humanizeFailure("CHECKPOINT_PUBLISH_FAILED")).toContain("reply is kept");
    expect(humanizeFailure("CHECKPOINT_RUNTIME_UNSUPPORTED")).toContain("not available");
  });
});

describe("workspace checkpoint wording", () => {
  it("labels every checkpoint and recovery event in product words", () => {
    expect(eventLabel("workspace_checkpoint_created")).toBe("Workspace checkpoint saved");
    expect(eventLabel("workspace_checkpoint_failed")).toBe("Workspace checkpoint failed");
    expect(eventLabel("workspace_checkpoint_restore_started")).toBe("Workspace restore started");
    expect(eventLabel("workspace_checkpoint_restored")).toBe("Workspace source restored");
    expect(eventLabel("workspace_checkpoint_restore_failed")).toBe("Workspace restore failed");
    expect(eventLabel("workspace_recovery_resumed")).toBe("Resumed from a restored checkpoint");
  });

  it("treats only the in-progress stages as pending", () => {
    for (const stage of ["reserved", "preparing", "backed_up", "restoring", "restored"] as const) {
      expect(isRecoveryPending(stage)).toBe(true);
    }
    for (const stage of ["resume_accepted", "settled", "failed", "recovery_required"] as const) {
      expect(isRecoveryPending(stage)).toBe(false);
    }
    expect(isRecoveryPending(undefined)).toBe(false);
    expect(isRecoveryPending(null)).toBe(false);
  });

  it("names the stage a recovery is at, with its code when it needs attention", () => {
    expect(recoveryStageLabel("preparing")).toBe("Saving safety checkpoint…");
    expect(recoveryStageLabel("restoring")).toBe("Restoring source…");
    expect(recoveryStageLabel("restored")).toBe("Source restored, resuming…");
    expect(recoveryStageLabel("recovery_required", "CHECKPOINT_RESTORE_FAILED")).toBe(
      "Recovery needs attention (CHECKPOINT_RESTORE_FAILED).",
    );
  });
});

describe("checkpointForTurn", () => {
  const checkpoint = (overrides: Partial<WorkspaceCheckpointView>): WorkspaceCheckpointView => ({
    checkpointId: "cp-a",
    projectId: "project-1",
    ordinal: 1,
    kind: "turn_success",
    state: "ready",
    orchestrationId: "session-1",
    turnId: "turn-a",
    runId: "run-a",
    stepIndex: 0,
    createdAt: "2026-09-08T00:00:00.000Z",
    fileCount: 1,
    byteCount: 10,
    excludedFileCount: 0,
    recoverable: true,
    unavailableReason: null,
    ...overrides,
  });
  const turn = (overrides: Partial<OrchestrationTurn>): OrchestrationTurn => ({
    id: "turn-a",
    sessionId: "session-1",
    participantId: "p1",
    agentId: "agent-1",
    runId: "run-a",
    stepIndex: 0,
    position: 0,
    status: "completed",
    safeInputSummary: "",
    safeOutput: null,
    outputTruncated: false,
    errorCode: null,
    createdAt: "2026-09-08T00:00:00.000Z",
    completedAt: "2026-09-08T00:00:01.000Z",
    ...overrides,
  });

  it("joins by the turn's recorded checkpoint ID, never by Agent or position", () => {
    const detail = {
      checkpoints: [
        checkpoint({ checkpointId: "cp-a", ordinal: 1, turnId: "turn-a" }),
        checkpoint({ checkpointId: "cp-b", ordinal: 2, turnId: "turn-b", stepIndex: 1 }),
      ],
    };
    // The same Agent spoke twice; the second turn must resolve to its own snapshot.
    const second = turn({ id: "turn-b", stepIndex: 1, workspaceCheckpointId: "cp-b" });

    expect(checkpointForTurn(detail, second)?.ordinal).toBe(2);
    expect(checkpointForTurn(detail, turn({ workspaceCheckpointId: "cp-a" }))?.ordinal).toBe(1);
  });

  it("returns nothing for a turn without a checkpoint or a detail without any", () => {
    const detail = { checkpoints: [checkpoint({})] };

    expect(checkpointForTurn(detail, turn({}))).toBeUndefined();
    expect(checkpointForTurn(detail, turn({ workspaceCheckpointId: "missing" }))).toBeUndefined();
    expect(checkpointForTurn({}, turn({ workspaceCheckpointId: "cp-a" }))).toBeUndefined();
    expect(checkpointForTurn(null, turn({ workspaceCheckpointId: "cp-a" }))).toBeUndefined();
  });
});
