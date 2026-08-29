import { describe, expect, it } from "vitest";
import type {
  PlatformAgentInvokerContract,
  PlatformAgentInvokerInput,
} from "../platform-agent-invoker.js";
import {
  createOrchestrationGraph,
  runOrchestrationGraph,
  type OrchestrationGraphInput,
} from "../graph.js";
import type {
  OrchestrationGraphTurn,
  OrchestrationParticipant,
} from "../types.js";

const agentIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function participant(
  id: string,
  agentId: string,
  position: number,
  role = id,
): OrchestrationParticipant {
  return { id, agentId, position, role };
}

function input(
  participants: OrchestrationParticipant[],
  maxSteps = participants.length,
): OrchestrationGraphInput {
  return {
    sessionId,
    originalPrompt: "Ship the requested change safely.",
    participants,
    maxSteps,
  };
}

function runIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

class FakeInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  private readonly behavior: "success" | "failed" | "cancelled" | "timeout" | "empty";

  constructor(
    behavior: "success" | "failed" | "cancelled" | "timeout" | "empty" = "success",
  ) {
    this.behavior = behavior;
  }

  async invoke(input: PlatformAgentInvokerInput): Promise<{ runId: string; output: string }> {
    this.calls.push(input);
    if (this.behavior === "failed") throw new Error("child Agent failed");
    if (this.behavior === "cancelled") throw new Error("child Run cancelled");
    if (this.behavior === "timeout") {
      const error = new Error("child Run timed out");
      error.name = "TimeoutError";
      throw error;
    }
    if (this.behavior === "empty") {
      return { runId: runIdFor(this.calls.length), output: "   " };
    }
    return {
      runId: runIdFor(this.calls.length),
      output: `result-from-${input.agentId}-${this.calls.length}`,
    };
  }

  async cancel(): Promise<void> {}
}

class AbortAwareInvoker implements PlatformAgentInvokerContract {
  async invoke(input: PlatformAgentInvokerInput): Promise<{ runId: string; output: string }> {
    await new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new Error("child Run cancelled"));
      if (input.signal?.aborted) {
        cancel();
        return;
      }
      input.signal?.addEventListener("abort", cancel, { once: true });
    });
    throw new Error("unreachable");
  }

  async cancel(): Promise<void> {}
}

describe("orchestration graph", () => {
  it("executes an arbitrary roster in position order and hands output to the next Agent", async () => {
    const invoker = new FakeInvoker();
    const result = await runOrchestrationGraph(
      input([
        participant("reviewer", agentIds[2]!, 2, "Reviewer"),
        participant("planner", agentIds[0]!, 0, "Planner"),
        participant("builder", agentIds[1]!, 1, "Builder"),
        participant("polisher", agentIds[3]!, 3, "Polisher"),
      ]),
      { invoker },
    );

    expect(result.status).toBe("completed");
    expect(result.turns.map((turn) => turn.position)).toEqual([0, 1, 2, 3]);
    expect(invoker.calls.map((call) => call.agentId)).toEqual([
      agentIds[0],
      agentIds[1],
      agentIds[2],
      agentIds[3],
    ]);
    expect(invoker.calls[1]?.prompt).toContain("result-from-");
    expect(invoker.calls[1]?.prompt).toContain("<untrusted_agent_output");
    expect(result.turns.every((turn) => turn.outputTruncated === false)).toBe(true);
  });

  it("allows the same platform Agent in multiple declared occurrences", async () => {
    const invoker = new FakeInvoker();
    const repeatedAgent = agentIds[0]!;
    const result = await runOrchestrationGraph(
      input([
        participant("first-pass", repeatedAgent, 0, "Planner"),
        participant("second-pass", repeatedAgent, 1, "Critic"),
      ]),
      { invoker },
    );

    expect(result.status).toBe("completed");
    expect(invoker.calls).toHaveLength(2);
    expect(result.turns.map((turn) => turn.participantId)).toEqual([
      "first-pass",
      "second-pass",
    ]);
  });

  it("includes prior-cycle context without consuming the current cycle budget", async () => {
    const invoker = new FakeInvoker();
    const seeded = input([participant("current", agentIds[0]!, 0)], 1);
    seeded.contextTurns = [
      {
        participantId: "prior-cycle",
        agentId: "prior-agent",
        position: 0,
        stepIndex: 4,
        output: "The earlier cycle completed the first checklist item.",
        outputTruncated: false,
      },
    ];

    const result = await runOrchestrationGraph(seeded, { invoker });

    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(1);
    expect(invoker.calls[0]?.prompt).toContain(
      "The earlier cycle completed the first checklist item.",
    );
  });

  it("fails visibly when maxSteps prevents the declared roster from completing", async () => {
    const invoker = new FakeInvoker();
    const result = await runOrchestrationGraph(
      input(
        [
          participant("one", agentIds[0]!, 0),
          participant("two", agentIds[1]!, 1),
          participant("three", agentIds[2]!, 2),
        ],
        2,
      ),
      { invoker },
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("MAX_STEPS_EXCEEDED");
    expect(result.turns).toHaveLength(2);
    expect(invoker.calls).toHaveLength(2);
  });

  it("rejects preloaded turns beyond the graph's absolute state bound", async () => {
    const invoker = new FakeInvoker();
    const turn: OrchestrationGraphTurn = {
      participantId: "worker",
      agentId: agentIds[0]!,
      runId: runIdFor(1),
      position: 0,
      output: "already recorded",
      outputTruncated: false,
    };
    const seeded = input([participant("worker", agentIds[0]!, 0)], 1);
    seeded.turns = Array.from({ length: 1_001 }, () => turn);

    await expect(runOrchestrationGraph(seeded, { invoker })).rejects.toThrow();
    expect(invoker.calls).toHaveLength(0);
  });

  it("fails before dispatch when preloaded turns exceed maxSteps", async () => {
    const invoker = new FakeInvoker();
    const turn: OrchestrationGraphTurn = {
      participantId: "worker",
      agentId: agentIds[0]!,
      runId: runIdFor(1),
      position: 0,
      output: "already recorded",
      outputTruncated: false,
    };
    const seeded = input([participant("worker", agentIds[0]!, 0)], 1);
    seeded.turns = [turn, { ...turn, runId: runIdFor(2), position: 1 }];

    const result = await runOrchestrationGraph(seeded, { invoker });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(invoker.calls).toHaveLength(0);
  });

  it.each([
    ["failed", "RUN_FAILED"],
    ["cancelled", "RUN_CANCELLED"],
    ["timeout", "RUN_TIMED_OUT"],
    ["empty", "INVALID_OUTPUT"],
  ] as const)("maps a %s child result to a terminal graph error", async (behavior, code) => {
    const invoker = new FakeInvoker(behavior);
    const result = await runOrchestrationGraph(
      input([participant("worker", agentIds[0]!, 0)]),
      { invoker },
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe(code);
    expect(invoker.calls).toHaveLength(1);
  });

  it("uses an explicit recursion limit for a longer roster", async () => {
    const invoker = new FakeInvoker();
    const participants = Array.from({ length: 16 }, (_, index) =>
      participant(
        `participant-${index}`,
        agentIds[index % agentIds.length]!,
        index,
      ),
    );
    const graph = createOrchestrationGraph({ invoker });
    const result = await graph.invoke(input(participants), {
      recursionLimit: 40,
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(16);
  });

  it("propagates an external graph abort for the lifecycle owner to mark stopped", async () => {
    const controller = new AbortController();
    const pending = runOrchestrationGraph(
      input([participant("worker", agentIds[0]!, 0)]),
      { invoker: new AbortAwareInvoker(), signal: controller.signal },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
