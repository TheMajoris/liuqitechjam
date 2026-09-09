import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The web Vitest suite intentionally runs without a DOM. A small hook runner
 * keeps this lifecycle test focused on the hook's refs/effects rather than
 * adding a browser test dependency just for approval polling.
 */
type Slot = {
  value?: unknown;
  deps?: readonly unknown[];
};

const slots: Slot[] = [];
let cursor = 0;
let scheduledEffects: Array<() => void | (() => void)> = [];

function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

function nextSlot(): Slot {
  const index = cursor++;
  slots[index] ??= {};
  return slots[index]!;
}

vi.mock("react", () => ({
  useCallback: (callback: unknown, deps: readonly unknown[]) => {
    const slot = nextSlot();
    if (!sameDeps(slot.deps, deps)) {
      slot.deps = deps;
      slot.value = callback;
    }
    return slot.value;
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const slot = nextSlot();
    if (!sameDeps(slot.deps, deps)) {
      slot.deps = deps;
      scheduledEffects.push(effect);
    }
  },
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
    const slot = nextSlot();
    if (!sameDeps(slot.deps, deps)) {
      slot.deps = deps;
      slot.value = factory();
    }
    return slot.value;
  },
  useRef: (initialValue: unknown) => {
    const slot = nextSlot();
    if (!Object.prototype.hasOwnProperty.call(slot, "value")) {
      slot.value = { current: initialValue };
    }
    return slot.value;
  },
  useState: (initialValue: unknown) => {
    const slot = nextSlot();
    if (!Object.prototype.hasOwnProperty.call(slot, "value")) {
      slot.value = typeof initialValue === "function"
        ? (initialValue as () => unknown)()
        : initialValue;
    }
    return [
      slot.value,
      (nextValue: unknown) => {
        slot.value = typeof nextValue === "function"
          ? (nextValue as (current: unknown) => unknown)(slot.value)
          : nextValue;
      },
    ];
  },
}));

import { api } from "../../../../apps/web/src/api";
import type { ToolApproval } from "../../../../apps/web/src/types";
import { useToolApprovals } from "../../../../apps/web/src/components/approvals/use-tool-approvals";

const originalWindow = globalThis.window;

function approval(overrides: Partial<ToolApproval> = {}): ToolApproval {
  return {
    approvalId: "approval-a",
    invocationId: "invocation-a",
    workflowRunId: "workflow-a",
    agentId: "agent-a",
    projectId: "project-a",
    runId: "run-a",
    orchestrationId: null,
    turnId: null,
    sessionId: null,
    toolId: "project.preview.restart",
    policyVersion: "tool-approval-v1",
    safeSummary: "Restart preview",
    deadlineAt: "2099-01-01T00:00:00.000Z",
    status: "waiting",
    version: 1,
    ownerEpoch: 1,
    decision: null,
    decisionActor: null,
    decisionAt: null,
    decisionReason: null,
    traceRefs: {},
    executionStartedAt: null,
    completedAt: null,
    terminalReason: null,
    cancellationRequestedAt: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    decisionEligible: true,
    ...overrides,
  };
}

function renderHook(options: Parameters<typeof useToolApprovals>[0] = {}) {
  cursor = 0;
  scheduledEffects = [];
  const result = useToolApprovals(options);
  return { result, effects: scheduledEffects.slice() };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

async function runEffects(effects: Array<() => void | (() => void)>): Promise<void> {
  for (const effect of effects) effect();
  await flushMicrotasks();
}

afterEach(() => {
  vi.restoreAllMocks();
  slots.splice(0, slots.length);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("useToolApprovals lifecycle", () => {
  it("does not rerun the scope effect when an absent initial projection stays undefined", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { clearInterval: () => undefined, setInterval: () => 0 },
    });
    vi.spyOn(api, "listApprovals").mockResolvedValue({ approvals: [] });

    const first = renderHook({ runId: "run-a" });
    await runEffects(first.effects);
    const second = renderHook({ runId: "run-a" });

    // No scope, refresh or polling effect is rescheduled by the unchanged
    // omitted `initialApprovals` prop.
    expect(second.effects).toHaveLength(0);
  });

  it("fences stale decision completion and finally blocks across a scope switch", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { clearInterval: () => undefined, setInterval: () => 0 },
    });
    vi.spyOn(api, "listApprovals").mockResolvedValue({ approvals: [] });

    const firstApproval = approval();
    const secondApproval = approval({
      approvalId: "approval-b",
      invocationId: "invocation-b",
      workflowRunId: "workflow-b",
      runId: "run-b",
      agentId: "agent-b",
    });
    vi.spyOn(api, "getApproval").mockImplementation(async (approvalId) => ({
      approval: approvalId === firstApproval.approvalId ? firstApproval : secondApproval,
    }));

    let resolveFirst!: (value: { approval: ToolApproval }) => void;
    let resolveSecond!: (value: { approval: ToolApproval }) => void;
    vi.spyOn(api, "decideApproval").mockImplementation((approvalId) =>
      new Promise((resolve) => {
        if (approvalId === firstApproval.approvalId) resolveFirst = resolve;
        else resolveSecond = resolve;
      }),
    );

    const first = renderHook({ runId: "run-a", initialApprovals: [firstApproval] });
    await runEffects(first.effects);
    const firstReady = renderHook({ runId: "run-a", initialApprovals: [firstApproval] });
    const firstDecision = firstReady.result.decide(firstApproval.approvalId, true);

    const second = renderHook({ runId: "run-b", initialApprovals: [secondApproval] });
    await runEffects(second.effects);
    const secondReady = renderHook({ runId: "run-b", initialApprovals: [secondApproval] });
    expect(secondReady.result.pendingDecisionId).toBeNull();

    const secondDecision = secondReady.result.decide(secondApproval.approvalId, true);
    resolveFirst({ approval: approval({ ...firstApproval, status: "approved", decision: "approved" }) });
    await firstDecision;

    // The old request must not clear the new scope's single-flight guard.
    const whileSecondPending = renderHook({ runId: "run-b", initialApprovals: [secondApproval] });
    expect(whileSecondPending.result.pendingDecisionId).toBe(secondApproval.approvalId);

    resolveSecond({ approval: approval({ ...secondApproval, status: "approved", decision: "approved" }) });
    await secondDecision;
    const settled = renderHook({ runId: "run-b", initialApprovals: [secondApproval] });
    expect(settled.result.pendingDecisionId).toBeNull();
  });
});
