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

  it("cancels an accepted child when acceptance resolves after cancellation", async () => {
    let resolveSend!: (value: any) => void;
    let cancelCalls = 0;
    let waitCalls = 0;
    const invoker = new PlatformAgentInvoker({
      sendMessage: async () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
      async waitForRun() {
        waitCalls += 1;
        throw new Error("waitForRun should not be called");
      },
      async cancelRun() {
        cancelCalls += 1;
        return {} as any;
      },
    });
    const controller = new AbortController();
    const invocation = invoker.invoke({
      agentId: "agent-1",
      prompt: "write the requested change",
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    controller.abort();
    resolveSend({ run: { id: "run-1" }, message: {} });

    await expect(invocation).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelCalls).toBe(1);
    expect(waitCalls).toBe(0);
  });
});
