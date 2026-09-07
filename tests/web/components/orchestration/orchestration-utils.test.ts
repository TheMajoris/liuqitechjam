import { describe, expect, it } from "vitest";
import {
  validateDraft,
  validateWorkspaceTask,
} from "../../../../apps/web/src/components/orchestration/orchestration-utils";
import type { Agent } from "../../../../apps/web/src/types";
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
