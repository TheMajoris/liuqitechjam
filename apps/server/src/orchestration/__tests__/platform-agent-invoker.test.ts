import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../../agent-service.js";
import type { AgentRun, Message } from "../../types.js";
import { PlatformAgentInvoker } from "../platform-agent-invoker.js";

function terminalRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "completed",
    prompt: "build it",
    output: "done",
    error: null,
    usage: null,
    startedAt: null,
    completedAt: "2026-08-28T00:00:01.000Z",
    createdAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("PlatformAgentInvoker", () => {
  it("dispatches through AgentService and waits for the terminal Run", async () => {
    const run = terminalRun();
    const message: Message = {
      id: "message-1",
      agentId: run.agentId,
      runId: run.id,
      role: "user",
      content: run.prompt,
      createdAt: run.createdAt,
    };
    const sendMessage = vi.fn<AgentService["sendMessage"]>(async () => ({ run, message }));
    const waitForRun = vi.fn<AgentService["waitForRun"]>(async () => run);
    const service = { sendMessage, waitForRun } as unknown as AgentService;
    const invoker = new PlatformAgentInvoker(service);
    const controller = new AbortController();

    await expect(
      invoker.invoke({
        agentId: run.agentId,
        prompt: run.prompt,
        timeoutMs: 1_500,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ runId: run.id, output: "done" });
    // Team turns are tagged so the Agent Playground never shows them as if
    // the user had typed them.
    expect(sendMessage).toHaveBeenCalledWith(run.agentId, run.prompt, {
      origin: "orchestration",
    });
    expect(waitForRun).toHaveBeenCalledWith(run.id, {
      timeoutMs: 1_500,
      signal: controller.signal,
    });
  });

  it("rejects terminal Runs without usable output", async () => {
    const run = terminalRun({ output: null });
    const message: Message = {
      id: "message-1",
      agentId: run.agentId,
      runId: run.id,
      role: "user",
      content: run.prompt,
      createdAt: run.createdAt,
    };
    const service = {
      sendMessage: async () => ({ run, message }),
      waitForRun: async () => run,
    } as unknown as AgentService;
    const invoker = new PlatformAgentInvoker(service);

    await expect(
      invoker.invoke({ agentId: run.agentId, prompt: run.prompt, timeoutMs: 1_000 }),
    ).rejects.toThrow("completed without output");
  });

  it("cancels an accepted Run when waiting times out or is aborted", async () => {
    const run = terminalRun({ status: "running", output: null });
    const message: Message = {
      id: "message-1",
      agentId: run.agentId,
      runId: run.id,
      role: "user",
      content: run.prompt,
      createdAt: run.createdAt,
    };
    const waitError = new Error("wait timed out");
    const cancelRun = vi.fn<AgentService["cancelRun"]>(async () => terminalRun({ status: "cancelled" }));
    const waitForRun = vi.fn<AgentService["waitForRun"]>(async () => {
      throw waitError;
    });
    const service = {
      sendMessage: async () => ({ run, message }),
      waitForRun,
      cancelRun,
    } as unknown as AgentService;
    const invoker = new PlatformAgentInvoker(service);

    await expect(
      invoker.invoke({ agentId: run.agentId, prompt: run.prompt, timeoutMs: 10 }),
    ).rejects.toBe(waitError);
    expect(cancelRun).toHaveBeenCalledWith(run.id);
  });

  it("surfaces failed and cancelled terminal statuses", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const run = terminalRun({ status, output: null, error: "not available" });
      const message: Message = {
        id: "message-1",
        agentId: run.agentId,
        runId: run.id,
        role: "user",
        content: run.prompt,
        createdAt: run.createdAt,
      };
      const service = {
        sendMessage: async () => ({ run, message }),
        waitForRun: async () => run,
      } as unknown as AgentService;
      const invoker = new PlatformAgentInvoker(service);

      await expect(
        invoker.invoke({ agentId: run.agentId, prompt: run.prompt, timeoutMs: 1_000 }),
      ).rejects.toThrow(status);
    }
  });

  it("cancels by Run ID through AgentService without exposing AgentRunner", async () => {
    const cancelRun = vi.fn<AgentService["cancelRun"]>(async () => terminalRun({ status: "cancelled" }));
    const service = { cancelRun } as unknown as AgentService;
    const invoker = new PlatformAgentInvoker(service);

    await expect(invoker.cancel("run-1")).resolves.toBeUndefined();
    expect(cancelRun).toHaveBeenCalledWith("run-1");
  });
});
