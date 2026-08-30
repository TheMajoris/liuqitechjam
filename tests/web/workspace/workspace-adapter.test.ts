import { describe, expect, it } from "vitest";
import type {
  Agent,
  ApprovalRecord,
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationStatus,
  OrchestrationTurn,
  Project,
} from "../../../apps/web/src/types";
import {
  buildWorkspaceViewModel,
  resolveDoorState,
  resolveHandoff,
  resolveStation,
} from "../../../apps/web/src/workspace/workspace-adapter";

const NOW = "2026-08-30T10:00:00.000Z";

function agent(id: string, name: string, status: Agent["status"] = "ready"): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status,
    workspacePath: "/agents/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function turn(overrides: Partial<OrchestrationTurn> & Pick<OrchestrationTurn, "agentId" | "status">): OrchestrationTurn {
  return {
    id: "turn-" + overrides.agentId + "-" + overrides.status,
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

function detailFor(
  status: OrchestrationStatus,
  options: {
    currentParticipantId?: string | null;
    turns?: OrchestrationTurn[];
    events?: OrchestrationEvent[];
    roles?: Record<string, string>;
  } = {},
): OrchestrationSessionDetail {
  const roles = options.roles ?? {};
  const session: OrchestrationSession = {
    id: "session-1",
    name: "Build the todo app",
    originalPrompt: "Build a todo app.",
    projectId: "project-1",
    participants: [
      { id: "p-a1", agentId: "a1", role: roles.a1 ?? "builder", position: 0 },
      { id: "p-a2", agentId: "a2", role: roles.a2 ?? "reviewer", position: 1 },
      { id: "p-a3", agentId: "a3", role: roles.a3 ?? "tester", position: 2 },
    ],
    mode: "supervisor",
    status,
    currentParticipantId: options.currentParticipantId ?? null,
    currentRunId: null,
    stepIndex: 0,
    maxSteps: 8,
    perAgentTimeoutMs: 300_000,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: null,
  };
  return {
    session,
    turns: options.turns ?? [],
    events: options.events ?? [],
    continuationPrompts: [],
  };
}

function build(
  detail: OrchestrationSessionDetail | null,
  overrides: {
    agents?: Agent[];
    approvals?: ApprovalRecord[] | null;
    project?: Project | null;
    selectedAgentId?: string | null;
  } = {},
) {
  return buildWorkspaceViewModel({
    agents: overrides.agents ?? [agent("a1", "Alice"), agent("a2", "Bob"), agent("a3", "Cleo")],
    detail,
    project: overrides.project ?? null,
    preview: null,
    approvals: overrides.approvals === undefined ? null : overrides.approvals,
    selectedAgentId: overrides.selectedAgentId ?? null,
  });
}

function activityOf(model: ReturnType<typeof build>, agentId: string) {
  return model.agents.find((item) => item.agentId === agentId)?.activity;
}

describe("activity mapping", () => {
  it("marks the dispatched current participant as working", () => {
    const model = build(
      detailFor("running", {
        currentParticipantId: "p-a1",
        turns: [turn({ agentId: "a1", status: "dispatched" })],
      }),
    );
    expect(activityOf(model, "a1")).toBe("working");
  });

  it("marks the selected-but-not-yet-dispatched participant as thinking", () => {
    const model = build(detailFor("running", { currentParticipantId: "p-a1" }));
    expect(activityOf(model, "a1")).toBe("thinking");
  });

  it("refines a busy turn using the roster's own responsibility label", () => {
    const reviewing = build(
      detailFor("running", {
        currentParticipantId: "p-a2",
        turns: [turn({ agentId: "a2", status: "dispatched" })],
      }),
    );
    expect(activityOf(reviewing, "a2")).toBe("reviewing");

    const testing = build(
      detailFor("running", {
        currentParticipantId: "p-a3",
        turns: [turn({ agentId: "a3", status: "dispatched" })],
      }),
    );
    expect(activityOf(testing, "a3")).toBe("testing");
  });

  it("separates Agents that have spoken from those still queued", () => {
    const model = build(
      detailFor("running", {
        currentParticipantId: "p-a1",
        turns: [
          turn({ agentId: "a1", status: "dispatched" }),
          turn({ agentId: "a2", status: "completed" }),
        ],
      }),
    );
    expect(activityOf(model, "a2")).toBe("waiting");
    expect(activityOf(model, "a3")).toBe("queued");
  });

  it("reports the outcome of the last turn once the Team stops running", () => {
    const model = build(
      detailFor("completed", {
        turns: [
          turn({ agentId: "a1", status: "completed" }),
          turn({ agentId: "a2", status: "failed", errorCode: "RUN_FAILED" }),
          turn({ agentId: "a3", status: "cancelled" }),
        ],
      }),
    );
    expect(activityOf(model, "a1")).toBe("success");
    expect(activityOf(model, "a2")).toBe("failed");
    expect(activityOf(model, "a3")).toBe("stopped");
  });

  it("uses the newest turn when an Agent took more than one", () => {
    const model = build(
      detailFor("completed", {
        turns: [
          turn({ agentId: "a1", status: "failed", stepIndex: 0, errorCode: "RUN_FAILED" }),
          turn({ agentId: "a1", status: "completed", stepIndex: 2 }),
        ],
      }),
    );
    expect(activityOf(model, "a1")).toBe("success");
  });

  it("lets Agent lifecycle status show through when no Team is running", () => {
    const model = build(detailFor("draft"), {
      agents: [agent("a1", "Alice", "stopped"), agent("a2", "Bob", "error"), agent("a3", "Cleo")],
    });
    expect(activityOf(model, "a1")).toBe("stopped");
    expect(activityOf(model, "a2")).toBe("failed");
    expect(activityOf(model, "a3")).toBe("idle");
  });

  it("shows a roster entry whose Agent no longer exists as stopped and unavailable", () => {
    const model = build(detailFor("completed"), { agents: [agent("a1", "Alice")] });
    const missing = model.agents.find((item) => item.agentId === "a2");
    expect(missing?.available).toBe(false);
    expect(missing?.activity).toBe("stopped");
  });

  it("puts a pending approval ahead of every other state", () => {
    const approvals: ApprovalRecord[] = [
      {
        id: "ap-1",
        kind: "operation_approval",
        scope: "once",
        agentId: "a1",
        projectId: "project-1",
        runId: null,
        toolId: "web.search",
        safeSummary: "Fetch the public docs.",
        status: "pending",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const model = build(
      detailFor("running", {
        currentParticipantId: "p-a1",
        turns: [turn({ agentId: "a1", status: "dispatched" })],
      }),
      { approvals },
    );
    expect(activityOf(model, "a1")).toBe("blocked");
    expect(model.pendingApprovals).toHaveLength(1);
    expect(model.pendingApprovals[0]!.agentName).toBe("Alice");
  });
});

describe("stations", () => {
  it("sends a blocked Agent to the door and a thinking one to the board", () => {
    expect(resolveStation("blocked")).toBe("door");
    expect(resolveStation("thinking")).toBe("board");
    expect(resolveStation("working")).toBe("desk");
    expect(resolveStation("idle")).toBe("desk");
  });
});

describe("orchestration signals", () => {
  it("marks the Agent the supervisor just chose, while the Team runs", () => {
    const events: OrchestrationEvent[] = [
      {
        id: "e1",
        sessionId: "session-1",
        sequence: 1,
        type: "supervisor_decision",
        agentId: "a2",
        status: "ok",
        createdAt: NOW,
      },
    ];
    const running = build(detailFor("running", { currentParticipantId: "p-a2", events }));
    expect(running.agents.find((item) => item.agentId === "a2")?.isSupervisorChoice).toBe(true);

    const finished = build(detailFor("completed", { events }));
    expect(finished.agents.every((item) => !item.isSupervisorChoice)).toBe(true);
  });

  it("reads a handoff, and who it came from, out of the real event stream", () => {
    const events: OrchestrationEvent[] = [
      { id: "e1", sessionId: "s", sequence: 1, type: "run_completed", agentId: "a1", status: "ok", createdAt: NOW },
      { id: "e2", sessionId: "s", sequence: 2, type: "handoff_applied", agentId: "a2", status: "ok", createdAt: NOW },
    ];
    expect(resolveHandoff(events)).toEqual({
      id: "e2",
      sequence: 2,
      fromAgentId: "a1",
      toAgentId: "a2",
    });
  });

  it("has no handoff to animate when none was applied", () => {
    expect(resolveHandoff([])).toBeNull();
  });
});

describe("permission door", () => {
  it("stays dormant when approvals are not configured", () => {
    expect(resolveDoorState(null)).toBe("dormant");
  });

  it("mirrors the decision Permit already recorded", () => {
    const base = {
      kind: "operation_approval" as const,
      scope: "once" as const,
      agentId: "a1",
      projectId: "project-1",
      runId: null,
      toolId: "web.search",
      safeSummary: "",
      createdAt: NOW,
    };
    expect(resolveDoorState([])).toBe("locked");
    expect(
      resolveDoorState([{ ...base, id: "1", status: "pending", updatedAt: NOW }]),
    ).toBe("waiting");
    expect(
      resolveDoorState([{ ...base, id: "1", status: "approved", updatedAt: NOW }]),
    ).toBe("open");
    expect(
      resolveDoorState([{ ...base, id: "1", status: "denied", updatedAt: NOW }]),
    ).toBe("denied");
    // A used-up approval is not standing permission.
    expect(
      resolveDoorState([{ ...base, id: "1", status: "consumed", updatedAt: NOW }]),
    ).toBe("locked");
  });

  it("prefers a pending request over an older decision", () => {
    const base = {
      kind: "operation_approval" as const,
      scope: "once" as const,
      agentId: "a1",
      projectId: "project-1",
      runId: null,
      toolId: "web.search",
      safeSummary: "",
      createdAt: NOW,
    };
    expect(
      resolveDoorState([
        { ...base, id: "1", status: "denied", updatedAt: "2026-08-30T09:00:00.000Z" },
        { ...base, id: "2", status: "pending", updatedAt: "2026-08-30T08:00:00.000Z" },
      ]),
    ).toBe("waiting");
  });
});

describe("workspace view model", () => {
  it("seats each Agent once even when the roster repeats it", () => {
    const detail = detailFor("running");
    detail.session.participants.push({ id: "p-a1-again", agentId: "a1", role: "builder", position: 3 });
    const model = build(detail);
    expect(model.agents.filter((item) => item.agentId === "a1")).toHaveLength(1);
  });

  it("keeps seat order stable so a refresh rebuilds the same room", () => {
    const detail = detailFor("running");
    expect(build(detail).seatedAgentIds).toEqual(build(detail).seatedAgentIds);
    expect(build(detail).seatedAgentIds).toEqual(["a1", "a2", "a3"]);
  });

  it("adds Project members who are not in the Team roster", () => {
    const project: Project = {
      id: "project-1",
      name: "Todo App",
      description: "",
      teamId: "session-1",
      agentIds: ["a1", "a4"],
      memberships: [
        { agentId: "a1", role: "owner" },
        { agentId: "a4", role: "viewer" },
      ],
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const model = build(detailFor("running"), { project });
    expect(model.agents.map((item) => item.agentId)).toContain("a4");
    expect(model.agents.find((item) => item.agentId === "a1")?.projectRole).toBe("owner");
    expect(model.kind).toBe("project");
    expect(model.name).toBe("Todo App");
  });

  it("carries the selection without letting it invent an Agent", () => {
    const model = build(detailFor("running"), { selectedAgentId: "a2" });
    expect(model.agents.find((item) => item.agentId === "a2")?.isSelected).toBe(true);
    expect(model.agents.filter((item) => item.isSelected)).toHaveLength(1);
  });

  it("describes an empty workspace without a Team", () => {
    const model = build(null);
    expect(model.agents).toEqual([]);
    expect(model.kind).toBe("empty");
    expect(model.orchestrationStatus).toBeNull();
    expect(model.previewStatus).toBe("unavailable");
  });
});
