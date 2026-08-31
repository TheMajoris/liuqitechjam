import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentInspector } from "../../../apps/web/src/workspace/AgentInspector";
import type { ApprovalRecord } from "../../../apps/web/src/types";
import type { WorkspaceAgentViewModel } from "../../../apps/web/src/workspace/workspace-view-model";

const NOW = "2026-08-30T10:00:00.000Z";

function agentModel(
  overrides: Partial<WorkspaceAgentViewModel> = {},
): WorkspaceAgentViewModel {
  return {
    agentId: "a1",
    participantId: "p1",
    name: "Alice",
    role: "frontend builder",
    activity: "working",
    currentRunId: "run-1",
    safeSummary: "Implementing the application shell.",
    isCurrentParticipant: true,
    isSupervisorChoice: false,
    isSelected: true,
    modelLabel: "Ark / ep-demo",
    projectRole: "owner",
    available: true,
    lifecycle: "busy",
    seatIndex: 0,
    station: "desk",
    ...overrides,
  };
}

function render(
  agent: WorkspaceAgentViewModel | null,
  approvals: ApprovalRecord[] = [],
  projectName: string | null = "Todo App",
) {
  return renderToStaticMarkup(
    <AgentInspector
      agent={agent}
      projectName={projectName}
      pending={null}
      approvals={approvals}
      approvalBusyId={null}
      onLifecycle={() => undefined}
      onOpenConversation={() => undefined}
      onOpenAgent={() => undefined}
      onApprove={() => undefined}
      onDeny={() => undefined}
    />,
  );
}

describe("AgentInspector", () => {
  it("invites a selection when nothing is picked", () => {
    expect(render(null)).toContain("Select an Agent");
  });

  it("describes the Agent in words, not only in colour", () => {
    const markup = render(agentModel());
    expect(markup).toContain("Alice");
    expect(markup).toContain("frontend builder");
    expect(markup).toContain("Working");
    expect(markup).toContain("Running its turn in the workspace.");
    expect(markup).toContain("Ark / ep-demo");
    expect(markup).toContain("run-1");
  });

  it("offers Stop for a running Agent and Start for a stopped one", () => {
    expect(render(agentModel())).toContain("Stop Agent");
    expect(render(agentModel({ activity: "stopped", lifecycle: "stopped" }))).toContain(
      "Start Agent",
    );
  });

  it("does not offer lifecycle control for an Agent that no longer exists", () => {
    expect(render(agentModel({ available: false }))).toContain("disabled");
  });

  it("shows a pending approval with its safe summary and both decisions", () => {
    const approvals: ApprovalRecord[] = [
      {
        id: "ap-1",
        kind: "operation_approval",
        scope: "once",
        agentId: "a1",
        projectId: "project-1",
        runId: null,
        toolId: "web.search",
        safeSummary: "Fetch the public docs for the todo API spec.",
        status: "pending",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const markup = render(agentModel({ activity: "blocked" }), approvals);
    expect(markup).toContain("Waiting at the boundary");
    expect(markup).toContain("Fetch the public docs for the todo API spec.");
    expect(markup).toContain("web.search");
    expect(markup).toContain("Approve once");
    expect(markup).toContain("Approve for Project");
    expect(markup).toContain("Deny");
  });

  it("hides another Agent's approval", () => {
    const approvals: ApprovalRecord[] = [
      {
        id: "ap-2",
        kind: "operation_approval",
        scope: "once",
        agentId: "someone-else",
        projectId: "project-1",
        runId: null,
        toolId: "web.search",
        safeSummary: "Not Alice's request.",
        status: "pending",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    expect(render(agentModel(), approvals)).not.toContain("Not Alice's request.");
  });

  it("omits the Project role when there is no shared Project", () => {
    expect(render(agentModel(), [], null)).not.toContain("Project role");
  });
});
