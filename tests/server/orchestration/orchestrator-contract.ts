import { describe, expect, it } from "vitest";
import type {
  PlatformAgentInvokerContract,
  PlatformAgentInvokerInput,
} from "../../../apps/server/src/orchestration/platform-agent-invoker.js";
import type {
  OrchestrationExecutionHooks,
  Orchestrator,
} from "../../../apps/server/src/orchestration/orchestrator.js";
import type {
  OrchestrationMode,
  OrchestrationParticipant,
} from "../../../apps/server/src/orchestration/types.js";
import type { SharedConversationTurn } from "../../../apps/server/src/orchestration/handoff.js";

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

function runIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

type Behavior = "success" | "failed" | "timeout" | "empty";

/** Deterministic invoker double shared by every engine contract run. */
class FakeInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  readonly cancellations: string[] = [];
  private readonly behavior: Behavior;
  private readonly output: string;

  constructor(behavior: Behavior = "success", output?: string) {
    this.behavior = behavior;
    this.output = output ?? "result-from-participant";
  }

  async invoke(
    input: PlatformAgentInvokerInput,
  ): Promise<{ runId: string; output: string }> {
    this.calls.push(input);
    const runId = runIdFor(this.calls.length);
    await input.onRunAccepted?.(runId);

    if (this.behavior === "failed") throw new Error("child Agent failed");
    if (this.behavior === "timeout") {
      const error = new Error("child Run timed out");
      error.name = "TimeoutError";
      throw error;
    }
    if (this.behavior === "empty") {
      return { runId, output: "   " };
    }
    return {
      runId,
      output: `${this.output}-${this.calls.length}`,
    };
  }

  async cancel(runId: string): Promise<void> {
    this.cancellations.push(runId);
  }
}

/** Invoker double that keeps a child pending until the supplied signal aborts. */
class AbortAwareInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  readonly cancellations: string[] = [];

  async invoke(
    input: PlatformAgentInvokerInput,
  ): Promise<{ runId: string; output: string }> {
    this.calls.push(input);
    const runId = runIdFor(this.calls.length);
    await input.onRunAccepted?.(runId);
    await new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error("child Run cancelled");
        error.name = "AbortError";
        reject(error);
      };
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    throw new Error("unreachable");
  }

  async cancel(runId: string): Promise<void> {
    this.cancellations.push(runId);
  }
}

interface ExecutionOptions {
  maxSteps?: number;
  mode?: OrchestrationMode;
  perAgentTimeoutMs?: number;
  signal?: AbortSignal;
  hooks?: OrchestrationExecutionHooks;
  contextTurns?: readonly SharedConversationTurn[];
}

export type OrchestratorFactory = () => Orchestrator;

function runOrchestration(
  createOrchestrator: OrchestratorFactory,
  invoker: PlatformAgentInvokerContract,
  participants: OrchestrationParticipant[],
  options: ExecutionOptions = {},
) {
  return createOrchestrator().run(
    {
      sessionId,
      originalPrompt: "Ship the requested change safely.",
      participants,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      maxSteps: options.maxSteps ?? participants.length,
      ...(options.contextTurns === undefined
        ? {}
        : { contextTurns: options.contextTurns }),
    },
    {
      invoker,
      ...(options.perAgentTimeoutMs === undefined
        ? {}
        : { perAgentTimeoutMs: options.perAgentTimeoutMs }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
    },
  );
}

/**
 * Register the observable contract suite for one orchestration engine.
 *
 * Keeping the suite factory in tests makes LangGraph and Mastra prove the
 * same application-owned behavior without importing either framework into
 * the Orchestrator contract itself.
 */
export function describeOrchestratorContract(
  name: string,
  createOrchestrator: OrchestratorFactory,
): void {
  describe(`${name} Orchestrator contract`, () => {
    it("executes arbitrary ordered occurrences and passes only a safe handoff forward", async () => {
      const invoker = new FakeInvoker(
        "success",
        "token=super-secret /Users/darren/private-workspace",
      );
      const result = await runOrchestration(createOrchestrator, invoker, [
        participant("reviewer", agentIds[2]!, 2, "Reviewer"),
        participant("planner", agentIds[0]!, 0, "Planner"),
        participant("builder", agentIds[1]!, 1, "Builder"),
        participant("polisher", agentIds[3]!, 3, "Polisher"),
      ]);

      expect(result.status).toBe("completed");
      expect(result.turns.map((turn) => turn.position)).toEqual([0, 1, 2, 3]);
      expect(invoker.calls.map((call) => call.agentId)).toEqual([
        agentIds[0],
        agentIds[1],
        agentIds[2],
        agentIds[3],
      ]);
      expect(invoker.calls[1]?.prompt).toContain("<untrusted_agent_output");
      expect(invoker.calls[1]?.prompt).not.toContain("super-secret");
      expect(invoker.calls[1]?.prompt).not.toContain("/Users/darren");
      expect(result.turns.every((turn) => turn.outputTruncated === false)).toBe(
        true,
      );
    });

    it("allows one platform Agent to appear in multiple participant occurrences", async () => {
      const invoker = new FakeInvoker();
      const result = await runOrchestration(createOrchestrator, invoker, [
        participant("first-pass", agentIds[0]!, 0, "Planner"),
        participant("second-pass", agentIds[0]!, 1, "Critic"),
      ]);

      expect(result.status).toBe("completed");
      expect(invoker.calls).toHaveLength(2);
      expect(result.turns.map((turn) => turn.participantId)).toEqual([
        "first-pass",
        "second-pass",
      ]);
      expect(invoker.calls.map((call) => call.agentId)).toEqual([
        agentIds[0],
        agentIds[0],
      ]);
    });

    it("shows prior-cycle shared context without counting it as a current turn", async () => {
      const invoker = new FakeInvoker();
      const result = await runOrchestration(
        createOrchestrator,
        invoker,
        [participant("current", agentIds[0]!, 0)],
        {
          contextTurns: [
            {
              participantId: "prior-cycle",
              agentId: "prior-agent",
              position: 0,
              stepIndex: 4,
              output: "Earlier cycle work is already complete.",
              outputTruncated: false,
            },
          ],
        },
      );

      expect(result.status).toBe("completed");
      expect(result.turns).toHaveLength(1);
      expect(invoker.calls[0]?.prompt).toContain(
        "Earlier cycle work is already complete.",
      );
    });

    it("stops dispatching at maxSteps and reports an incomplete roster", async () => {
      const invoker = new FakeInvoker();
      const result = await runOrchestration(
        createOrchestrator,
        invoker,
        [
          participant("one", agentIds[0]!, 0),
          participant("two", agentIds[1]!, 1),
          participant("three", agentIds[2]!, 2),
        ],
        { maxSteps: 2 },
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("MAX_STEPS_EXCEEDED");
      expect(result.completionReason).toBeNull();
      expect(result.turns).toHaveLength(2);
      expect(invoker.calls).toHaveLength(2);
      expect(invoker.calls.map((call) => call.agentId)).not.toContain(
        agentIds[2],
      );
    });

    it("rejects duplicate occurrence IDs before dispatch", async () => {
      const invoker = new FakeInvoker();
      const result = await runOrchestration(createOrchestrator, invoker, [
        participant("duplicate", agentIds[0]!, 0),
        participant("duplicate", agentIds[1]!, 1),
      ]);

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("INVALID_INPUT");
      expect(invoker.calls).toHaveLength(0);
    });

    it.each([
      ["failed", "RUN_FAILED"],
      ["timeout", "RUN_TIMED_OUT"],
      ["empty", "INVALID_OUTPUT"],
    ] as const)(
      "maps a %s child outcome to a stable orchestration error",
      async (behavior, code) => {
        const invoker = new FakeInvoker(behavior);
        const result = await runOrchestration(
          createOrchestrator,
          invoker,
          [
            participant("worker", agentIds[0]!, 0),
            participant("never-dispatched", agentIds[1]!, 1),
          ],
          { perAgentTimeoutMs: 1_500 },
        );

        expect(result.status).toBe("failed");
        expect(result.errorCode).toBe(code);
        expect(invoker.calls).toHaveLength(1);
        expect(invoker.calls[0]?.timeoutMs).toBe(1_500);
      },
    );

    it("does not retry a failed participant or duplicate its dispatch", async () => {
      const invoker = new FakeInvoker("failed");
      const failedHooks: string[] = [];
      const result = await runOrchestration(
        createOrchestrator,
        invoker,
        [
          participant("worker", agentIds[0]!, 0),
          participant("never-dispatched", agentIds[1]!, 1),
        ],
        {
          hooks: {
            onParticipantFailed: ({ participant: failedParticipant, errorCode }) => {
              failedHooks.push(`${failedParticipant.id}:${errorCode}`);
            },
          },
        },
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("RUN_FAILED");
      expect(invoker.calls).toHaveLength(1);
      expect(failedHooks).toEqual(["worker:RUN_FAILED"]);
    });

    it("propagates cancellation to the active platform invocation without dispatching later participants", async () => {
      const controller = new AbortController();
      const invoker = new AbortAwareInvoker();
      const pending = runOrchestration(
        createOrchestrator,
        invoker,
        [
          participant("worker", agentIds[0]!, 0),
          participant("never-dispatched", agentIds[1]!, 1),
        ],
        { maxSteps: 2, signal: controller.signal },
      );

      for (
        let attempt = 0;
        attempt < 100 && invoker.calls.length === 0;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      expect(invoker.calls).toHaveLength(1);
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(invoker.calls).toHaveLength(1);
      expect(invoker.calls[0]?.signal?.aborted).toBe(true);
    });

    it("completes sequential mode after one pass even when maxSteps is larger", async () => {
      const invoker = new FakeInvoker();
      const result = await runOrchestration(
        createOrchestrator,
        invoker,
        [
          participant("a", agentIds[0]!, 0),
          participant("b", agentIds[1]!, 1),
          participant("c", agentIds[2]!, 2),
        ],
        { mode: "sequential", maxSteps: 10 },
      );

      expect(result.status).toBe("completed");
      expect(result.errorCode).toBeNull();
      expect(result.completionReason).toBe("roster_exhausted");
      expect(result.stepIndex).toBe(3);
      expect(invoker.calls.map((call) => call.agentId)).toEqual([
        agentIds[0],
        agentIds[1],
        agentIds[2],
      ]);
    });

    it("cycles round-robin participants through the maxSteps ceiling", async () => {
      const invoker = new FakeInvoker();
      const result = await runOrchestration(
        createOrchestrator,
        invoker,
        [
          participant("a", agentIds[0]!, 0, "A"),
          participant("b", agentIds[1]!, 1, "B"),
          participant("c", agentIds[2]!, 2, "C"),
        ],
        { mode: "round_robin", maxSteps: 10 },
      );

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("MAX_STEPS_EXCEEDED");
      expect(result.mode).toBe("round_robin");
      expect(result.stepIndex).toBe(10);
      expect(result.turns).toHaveLength(10);
      expect(invoker.calls.map((call) => call.agentId)).toEqual([
        agentIds[0],
        agentIds[1],
        agentIds[2],
        agentIds[0],
        agentIds[1],
        agentIds[2],
        agentIds[0],
        agentIds[1],
        agentIds[2],
        agentIds[0],
      ]);
      expect(invoker.calls[3]?.prompt).toContain("result-from-participant-3");
      expect(invoker.calls[3]?.prompt).toContain("<untrusted_agent_output");
    });

    it("runs lifecycle hooks once in dispatch and handoff order", async () => {
      const invoker = new FakeInvoker();
      const hookEvents: string[] = [];
      const hooks: OrchestrationExecutionHooks = {
        onBeforeDispatch: ({ participant: current, stepIndex, prompt }) => {
          hookEvents.push(`before:${current.id}:${stepIndex}`);
          expect(prompt).toContain(current.role);
        },
        onRunAccepted: ({ participant: current, runId, stepIndex }) => {
          hookEvents.push(`accepted:${current.id}:${stepIndex}:${runId}`);
        },
        onHandoffApplied: ({ participant: current, envelope, stepIndex }) => {
          hookEvents.push(
            `handoff:${envelope.sourceParticipantId}->${current.id}:${stepIndex}`,
          );
        },
        onRunCompleted: ({ participant: current, turn, stepIndex }) => {
          hookEvents.push(`completed:${current.id}:${stepIndex}:${turn.runId}`);
        },
      };
      const result = await runOrchestration(
        createOrchestrator,
        invoker,
        [
          participant("a", agentIds[0]!, 0, "Planner"),
          participant("b", agentIds[1]!, 1, "Builder"),
        ],
        { hooks },
      );

      expect(result.status).toBe("completed");
      expect(hookEvents).toEqual([
        `before:a:0`,
        `accepted:a:0:${runIdFor(1)}`,
        `completed:a:0:${runIdFor(1)}`,
        `handoff:a->b:1`,
        `before:b:1`,
        `accepted:b:1:${runIdFor(2)}`,
        `completed:b:1:${runIdFor(2)}`,
      ]);
    });
  });
}
