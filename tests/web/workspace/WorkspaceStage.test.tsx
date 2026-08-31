import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceStage } from "../../../apps/web/src/workspace/WorkspaceStage";
import type {
  WorkspaceAgentViewModel,
  WorkspaceViewModel,
} from "../../../apps/web/src/workspace/workspace-view-model";

function agentModel(
  overrides: Partial<WorkspaceAgentViewModel> & Pick<WorkspaceAgentViewModel, "agentId" | "name" | "activity">,
): WorkspaceAgentViewModel {
  return {
    participantId: null,
    role: null,
    currentRunId: null,
    safeSummary: null,
    isCurrentParticipant: false,
    isSupervisorChoice: false,
    isSelected: false,
    modelLabel: null,
    projectRole: null,
    available: true,
    lifecycle: "ready",
    seatIndex: 0,
    station: "desk",
    ...overrides,
  };
}

const viewModel: WorkspaceViewModel = {
  id: "project-1",
  name: "Todo App",
  kind: "project",
  projectId: "project-1",
  sessionId: "session-1",
  agents: [
    agentModel({
      agentId: "a1",
      name: "Alice",
      activity: "working",
      isCurrentParticipant: true,
      isSelected: true,
    }),
    agentModel({ agentId: "a2", name: "Bob", activity: "blocked", station: "door", seatIndex: 1 }),
    agentModel({ agentId: "a3", name: "Cleo", activity: "stopped", lifecycle: "stopped", seatIndex: 2 }),
  ],
  seatedAgentIds: ["a1", "a2", "a3"],
  orchestrationStatus: "running",
  orchestrationSummary: "Alice is working on its turn.",
  boardTask: "Build a todo app.",
  stepIndex: 1,
  maxSteps: 8,
  previewStatus: "running",
  previewUrl: "http://127.0.0.1:4321",
  activeAgentId: "a1",
  selectedAgentId: "a1",
  latestHandoff: null,
  pendingApprovals: [],
  doorState: "waiting",
};

function render(model: WorkspaceViewModel = viewModel) {
  return renderToStaticMarkup(
    <WorkspaceStage
      viewModel={model}
      replies={4}
      onSelectAgent={() => undefined}
      onOpenConversation={() => undefined}
      onOpenPreview={() => undefined}
      onOpenApprovals={() => undefined}
    />,
  );
}

/**
 * These assertions run without a canvas on purpose: whatever the renderer
 * does, the room's meaning has to survive as text and as focusable controls.
 */
describe("WorkspaceStage without a canvas", () => {
  it("still names every Agent and states what it is doing", () => {
    const markup = render();
    for (const name of ["Alice", "Bob", "Cleo"]) expect(markup).toContain(name);
    expect(markup).toContain("Working");
    expect(markup).toContain("Needs approval");
    expect(markup).toContain("Stopped");
  });

  it("exposes each Agent as a button rather than a canvas hit area", () => {
    const markup = render();
    expect(markup.match(/<button [^>]*class="ws-plate[^"]*"/g) ?? []).toHaveLength(3);
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("carries status with a glyph as well as a colour", () => {
    const markup = render();
    expect(markup).toContain("ws-plate-glyph");
    expect(markup).toContain('data-tone="danger"');
  });

  it("says the room cannot be drawn instead of showing nothing", () => {
    expect(render()).toContain("Room view unavailable");
  });

  it("notes Agents the room cannot seat", () => {
    const crowded: WorkspaceViewModel = {
      ...viewModel,
      agents: Array.from({ length: 10 }, (_, index) =>
        agentModel({
          agentId: "a" + index,
          name: "Agent " + index,
          activity: "idle",
          seatIndex: index,
        }),
      ),
    };
    expect(render(crowded)).toContain("more Agents are on this Project");
  });
});
