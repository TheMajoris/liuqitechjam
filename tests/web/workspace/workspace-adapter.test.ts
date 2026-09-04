import { describe, expect, it } from "vitest";
import type {
  Agent,
  AgentMetrics,
  ApprovalRecord,
  AuditEventRecord,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationStatus,
  OrchestrationTurn,
  Project,
} from "../../../apps/web/src/types";
import { buildWorkspaceViewModel } from "../../../apps/web/src/workspace/workspace-adapter";

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

function turn(
  overrides: Partial<OrchestrationTurn> & Pick<OrchestrationTurn, "agentId" | "status">,
): OrchestrationTurn {
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
  } = {},
): OrchestrationSessionDetail {
  const session: OrchestrationSession = {
    id: "session-1",
    name: "Build the todo app",
    originalPrompt: "Build a todo app.",
    projectId: "project-1",
    participants: [
      { id: "p-a1", agentId: "a1", role: "builder", position: 0 },
      { id: "p-a2", agentId: "a2", role: "reviewer", position: 1 },
      { id: "p-a3", agentId: "a3", role: "tester", position: 2 },
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
    events: [],
    continuationPrompts: [],
  };
}

function build(
  detail: OrchestrationSessionDetail | null,
  overrides: {
    agents?: Agent[];
    approvals?: ApprovalRecord[] | null;
    project?: Project | null;
    activity?: AuditEventRecord[];
    metrics?: Map<string, AgentMetrics>;
  } = {},
) {
  return buildWorkspaceViewModel({
    agents: overrides.agents ?? [agent("a1", "Alice"), agent("a2", "Bob"), agent("a3", "Cleo")],
    detail,
    project: overrides.project ?? null,
    preview: null,
    approvals: overrides.approvals === undefined ? null : overrides.approvals,
    selectedAgentId: null,
    activity: overrides.activity,
    metrics: overrides.metrics,
  });
}

function agentMetrics(agentId: string, overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    agentId,
    lifecycle: "busy",
    currentRun: { id: "run-1", elapsedMs: 5000, model: "gpt" },
    tokens: {
      lastRun: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 },
      session: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 200 },
      tokensPerSecondLastRun: 5,
      tokensPerSecondAvg: 4,
    },
    tools: { calls: 3, denied: 0, sandboxCommands: 1, filesChanged: 2 },
    container: null,
    lastError: null,
    model: "gpt",
    fallbackUsed: false,
    ...overrides,
  };
}

function activityOf(model: ReturnType<typeof build>, agentId: string) {
  return model.agents.find((item) => item.agentId === agentId)?.activity;
}

function viewOf(model: ReturnType<typeof build>, agentId: string) {
  return model.agents.find((item) => item.agentId === agentId) ?? null;
}

function soloProject(): Project {
  return {
    id: "project-1",
    name: "Todo App",
    description: "",
    teamId: null,
    agentIds: ["a1"],
    memberships: [{ agentId: "a1", role: "owner" }],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function auditEvent(overrides: Partial<AuditEventRecord> & Pick<AuditEventRecord, "type">): AuditEventRecord {
  return {
    id: "evt-" + overrides.type + "-" + (overrides.agentId ?? "none"),
    status: "success",
    summary: "",
    createdAt: NOW,
    ...overrides,
  };
}

describe("workspace adapter", () => {
  it("marks the dispatched current participant as working", () => {
    const model = build(
      detailFor("running", {
        currentParticipantId: "p-a1",
        turns: [turn({ agentId: "a1", status: "dispatched" })],
      }),
    );

    expect(activityOf(model, "a1")).toBe("working");
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

  it("shows a busy Agent's latest sandbox command at the server station", () => {
    const model = build(null, {
      project: soloProject(),
      agents: [agent("a1", "Alice", "busy")],
      activity: [
        auditEvent({
          type: "sandbox_command",
          agentId: "a1",
          metadata: { program: "npm", argCount: 1, exitCode: 0 },
        }),
      ],
    });

    const view = viewOf(model, "a1");
    expect(view?.sandboxActivity).toEqual({ kind: "command", program: "npm", exitCode: 0 });
    expect(view?.station).toBe("server");
    expect(view?.typing).toBe(false);
  });

  it("shows a busy Agent's latest file-change aggregate at the desk, typing", () => {
    const model = build(null, {
      project: soloProject(),
      agents: [agent("a1", "Alice", "busy")],
      activity: [
        auditEvent({
          type: "workspace_file_change",
          agentId: "a1",
          metadata: { fileCount: 3, added: 1, modified: 2, deleted: 0 },
        }),
      ],
    });

    const view = viewOf(model, "a1");
    expect(view?.sandboxActivity).toEqual({ kind: "files", fileCount: 3 });
    expect(view?.station).toBe("desk");
    expect(view?.typing).toBe(true);
  });

  it("prefers a live platform tool over sandbox activity", () => {
    const model = build(null, {
      project: soloProject(),
      agents: [agent("a1", "Alice", "busy")],
      activity: [
        auditEvent({
          type: "sandbox_command",
          agentId: "a1",
          metadata: { program: "npm", argCount: 1, exitCode: 0 },
        }),
        auditEvent({
          type: "tool_started",
          agentId: "a1",
          runId: "run-a1",
          resource: { kind: "tool", id: "web.search" },
        }),
      ],
    });

    const view = viewOf(model, "a1");
    expect(view?.activeTool?.toolId).toBe("web.search");
    expect(view?.station).toBe("library");
    expect(view?.typing).toBe(false);
  });

  it("leaves sandboxActivity null for an Agent that is not busy", () => {
    const model = build(null, {
      project: soloProject(),
      agents: [agent("a1", "Alice", "ready")],
      activity: [
        auditEvent({
          type: "sandbox_command",
          agentId: "a1",
          metadata: { program: "npm", argCount: 1, exitCode: 0 },
        }),
      ],
    });

    const view = viewOf(model, "a1");
    expect(view?.sandboxActivity).toBeNull();
    expect(view?.typing).toBe(false);
  });

  it("attaches metrics to the matching Agent and leaves missing entries null", () => {
    const model = build(null, {
      project: soloProject(),
      agents: [agent("a1", "Alice", "busy")],
      metrics: new Map([["a1", agentMetrics("a1")]]),
    });

    expect(viewOf(model, "a1")?.metrics?.agentId).toBe("a1");

    const modelWithoutEntry = build(null, {
      project: soloProject(),
      agents: [agent("a1", "Alice", "busy")],
      metrics: new Map(),
    });

    expect(viewOf(modelWithoutEntry, "a1")?.metrics).toBeNull();
  });
});
