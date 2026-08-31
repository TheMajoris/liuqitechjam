import { describe, expect, it } from "vitest";
import {
  defaultSupervisorAgentId,
  validateDraft,
} from "../../../../apps/web/src/components/orchestration/orchestration-utils";
import type { Agent } from "../../../../apps/web/src/types";
import type {
  OrchestrationDraft,
  OrchestrationParticipant,
} from "../../../../apps/web/src/components/orchestration/orchestration-utils";

const idleWorkspaceDraft: OrchestrationDraft = {
  name: "",
  originalPrompt: "",
  projectId: "workspace-1",
  participants: [],
  mode: "supervisor",
  supervisorAgentId: "",
  maxSteps: 20,
  perAgentTimeoutMs: 300_000,
};

const selectedParticipants: OrchestrationParticipant[] = [
  { id: "participant-1", agentId: "agent-1", role: "", position: 0 },
  { id: "participant-2", agentId: "agent-2", role: "", position: 1 },
];

describe("orchestration draft validation", () => {
  it("requires a supervisor even when an empty Workspace draft is saved", () => {
    const errors = validateDraft(idleWorkspaceDraft, []);
    expect(errors.supervisorAgentId).toContain("Choose an existing Agent");

    expect(
      validateDraft(
        { ...idleWorkspaceDraft, supervisorAgentId: "agent-1" },
        [{ id: "agent-1" } as Agent],
      ),
    ).toEqual({});
  });

  it("requires a supervisor once a Workspace conversation has a runnable task", () => {
    const errors = validateDraft(
      {
        ...idleWorkspaceDraft,
        originalPrompt: "Review the release plan",
        participants: selectedParticipants,
      },
      [
        { id: "agent-1" } as Agent,
        { id: "agent-2" } as Agent,
      ],
    );

    expect(errors.supervisorAgentId).toContain("Choose an existing Agent");
  });

  it("defaults to the first selected Agent without replacing an explicit override", () => {
    expect(defaultSupervisorAgentId(selectedParticipants)).toBe("agent-1");
    expect(defaultSupervisorAgentId(selectedParticipants, "agent-2")).toBe("agent-2");
    expect(defaultSupervisorAgentId([], undefined, "agent-1")).toBe("agent-1");
  });
});
