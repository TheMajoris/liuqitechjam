import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
} from "../../../apps/server/src/access/authorization-service.js";
import {
  PROJECT_PERMISSION_DENIED,
  PROJECT_PERMISSION_DENIED_MESSAGE,
} from "../../../apps/server/src/errors.js";
import { PlatformAgentInvoker } from "../../../apps/server/src/orchestration/platform-agent-invoker.js";

describe("PlatformAgentInvoker Project authorization", () => {
  it("maps a pre-run Project AuthorizationError to a safe orchestration code", async () => {
    const invoker = new PlatformAgentInvoker({
      async sendMessage() {
        throw new AuthorizationError(
          "The assigned Agent role does not include project.write",
          "sensitive project and policy details",
        );
      },
      async waitForRun() {
        throw new Error("waitForRun should not be called");
      },
      async cancelRun() {
        throw new Error("cancelRun should not be called");
      },
    });

    await expect(
      invoker.invoke({
        agentId: "agent-1",
        projectId: "project-1",
        prompt: "write the requested change",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      orchestrationErrorCode: PROJECT_PERMISSION_DENIED,
      message: PROJECT_PERMISSION_DENIED_MESSAGE,
    });
    expect(PROJECT_PERMISSION_DENIED_MESSAGE).toContain("Allow Agent runs (agent.invoke)");
    expect(PROJECT_PERMISSION_DENIED_MESSAGE).toContain(
      "Edit workspace files (project.write)",
    );
  });
});
