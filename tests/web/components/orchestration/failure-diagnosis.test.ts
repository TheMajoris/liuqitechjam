import { describe, expect, it } from "vitest";
import type {
  Agent,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationStatus,
  OrchestrationTurn,
} from "../../../../apps/web/src/types";
import { diagnoseFailure } from "../../../../apps/web/src/components/orchestration/failure-diagnosis";

const NOW = "2026-09-08T01:00:00.000Z";

function agent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/agents/" + overrides.id,
    codexThreadId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function turn(
  overrides: Partial<OrchestrationTurn> & Pick<OrchestrationTurn, "agentId" | "status">,
): OrchestrationTurn {
  return {
    id: "turn-" + overrides.agentId + "-" + (overrides.stepIndex ?? 0),
    sessionId: "session-1",
    participantId: "p-" + overrides.agentId,
    runId: "run-" + overrides.agentId,
    stepIndex: 0,
    position: 0,
    safeInputSummary: "",
    safeOutput: null,
    outputTruncated: false,
    errorCode: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function detail(
  status: OrchestrationStatus,
  turns: OrchestrationTurn[],
  session: Partial<OrchestrationSession> = {},
): OrchestrationSessionDetail {
  return {
    session: {
      id: "session-1",
      name: "Count to 10",
      originalPrompt: "Count to 10",
      participants: [],
      status,
      currentParticipantId: null,
      currentRunId: null,
      stepIndex: 0,
      maxSteps: 20,
      perAgentTimeoutMs: 300_000,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      ...session,
    },
    turns,
    events: [],
    continuationPrompts: [],
  };
}

describe("diagnoseFailure", () => {
  it("reports nothing while the conversation has not failed", () => {
    expect(diagnoseFailure(detail("running", []), [])).toBeNull();
    expect(diagnoseFailure(detail("completed", []), [])).toBeNull();
    expect(diagnoseFailure(null, [])).toBeNull();
  });

  it("names the Agent whose turn failed rather than only the code", () => {
    const agents = [agent({ id: "a1", name: "Prime counter" }), agent({ id: "a2", name: "Small counter" })];
    const result = diagnoseFailure(
      detail(
        "failed",
        [
          turn({ agentId: "a1", status: "completed", stepIndex: 0 }),
          turn({ agentId: "a2", status: "failed", stepIndex: 1, errorCode: "RUN_FAILED" }),
        ],
        { errorCode: "RUN_FAILED" },
      ),
      agents,
    );
    expect(result?.agentId).toBe("a2");
    expect(result?.agentName).toBe("Small counter");
    expect(result?.stepIndex).toBe(1);
  });

  it("picks the latest failed turn by execution step, not by array order", () => {
    const result = diagnoseFailure(
      detail(
        "failed",
        [
          turn({ agentId: "a2", status: "timed_out", stepIndex: 5 }),
          turn({ agentId: "a1", status: "failed", stepIndex: 2 }),
        ],
        { errorCode: "RUN_FAILED" },
      ),
      [agent({ id: "a1", name: "One" }), agent({ id: "a2", name: "Two" })],
    );
    expect(result?.agentId).toBe("a2");
    expect(result?.stepIndex).toBe(5);
  });

  it("prefers the turn's own error code over the session roll-up", () => {
    const result = diagnoseFailure(
      detail(
        "failed",
        [turn({ agentId: "a1", status: "failed", errorCode: "RUN_TIMED_OUT" })],
        { errorCode: "RUN_FAILED" },
      ),
      [agent({ id: "a1", name: "One" })],
    );
    expect(result?.errorCode).toBe("RUN_TIMED_OUT");
    expect(result?.fixes.map((fix) => fix.label)).toContain(
      "Raise the per-Agent timeout in the Conversation's Advanced settings",
    );
  });

  it("surfaces the Agent's own recorded error, which is more concrete", () => {
    const result = diagnoseFailure(
      detail("failed", [turn({ agentId: "a1", status: "failed" })], {
        errorCode: "RUN_FAILED",
      }),
      [agent({ id: "a1", name: "One", status: "error", lastError: "EPERM: operation not permitted" })],
    );
    expect(result?.agentError).toBe("EPERM: operation not permitted");
  });

  it("always offers a retry and a way into the Agent", () => {
    const result = diagnoseFailure(
      detail("failed", [turn({ agentId: "a1", status: "failed" })], {
        errorCode: "INTERNAL_ERROR",
      }),
      [agent({ id: "a1", name: "One" })],
    );
    const targets = result?.fixes.map((fix) => fix.target) ?? [];
    expect(targets).toContain("retry");
    expect(targets).toContain("agent");
  });

  it("tells the person to start an Agent that is stopped", () => {
    const result = diagnoseFailure(
      detail("failed", [turn({ agentId: "a1", status: "failed" })], {
        errorCode: "RUN_FAILED",
      }),
      [agent({ id: "a1", name: "Small counter", status: "stopped" })],
    );
    expect(result?.fixes.map((fix) => fix.label)).toContain(
      "Start Small counter — it is currently stopped",
    );
  });

  it("still explains a failure that recorded no turn", () => {
    const result = diagnoseFailure(
      detail("failed", [], {
        errorCode: "SUPERVISOR_UNAVAILABLE",
        errorMessage: null,
      }),
      [],
    );
    expect(result).not.toBeNull();
    expect(result?.agentId).toBeNull();
    expect(result?.summary).toContain("Automatic turn taking");
  });

  it("points a failed checkpoint capture at the last workspace checkpoint", () => {
    const result = diagnoseFailure(
      detail(
        "failed",
        [turn({ agentId: "a1", status: "failed", errorCode: "CHECKPOINT_CAPTURE_FAILED" })],
        { errorCode: "CHECKPOINT_CAPTURE_FAILED" },
      ),
      [agent({ id: "a1", name: "One" })],
    );
    expect(result?.summary).toContain("could not be checkpointed");
    expect(result?.fixes).toContainEqual({
      label: "Restore the last workspace checkpoint from the Activity tab",
      target: "retry",
    });
    // The checkpoint-specific retry replaces the generic one.
    expect(result?.fixes.filter((fix) => fix.target === "retry")).toHaveLength(1);
  });

  it("leads with the stalled recovery when one needs attention", () => {
    const failed = detail("failed", [turn({ agentId: "a1", status: "failed" })], {
      errorCode: "RUN_FAILED",
    });
    failed.recovery = {
      operationId: "op-1",
      projectId: "project-1",
      orchestrationId: "session-1",
      kind: "recovery",
      checkpointId: "cp-1",
      safetyCheckpointId: "cp-2",
      stage: "recovery_required",
      resumeCycleId: null,
      errorCode: "CHECKPOINT_RESTORE_FAILED",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const result = diagnoseFailure(failed, [agent({ id: "a1", name: "One" })]);
    expect(result?.fixes[0]?.label).toContain("pending Workspace recovery");
  });
});
