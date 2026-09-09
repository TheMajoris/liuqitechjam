import { describe, expect, it } from "vitest";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

type Counter = { calls: number };

const inputSchema = z.object({ value: z.string() });
const outputSchema = z.object({
  status: z.enum(["denied", "executed"]),
  value: z.string(),
  calls: z.number(),
});
const suspendSchema = z.object({ summary: z.string() });
const resumeSchema = z.object({ approved: z.boolean() });

function createApprovalFixture(counter: Counter) {
  const approvalStep = createStep({
    id: "approval",
    inputSchema,
    outputSchema,
    suspendSchema,
    resumeSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      // A resumed step starts again. Only an absent decision suspends; an
      // explicit false decision is terminal and must not suspend again.
      if (resumeData === undefined) {
        return await suspend({ summary: "Approval is required" });
      }

      if (!resumeData.approved) {
        return { status: "denied" as const, value: inputData.value, calls: counter.calls };
      }

      counter.calls += 1;
      return { status: "executed" as const, value: inputData.value, calls: counter.calls };
    },
  });

  const workflow = createWorkflow({
    id: "approval-contract",
    description: "Focused Mastra workflow approval contract fixture",
    inputSchema,
    outputSchema,
    retryConfig: { attempts: 0, delay: 0 },
  })
    .then(approvalStep)
    .commit();

  const storage = new InMemoryStore({ id: "approval-contract-store" });
  new Mastra({
    logger: false,
    storage,
    workflows: { [workflow.id]: workflow },
  });

  return { workflow, counter };
}

describe("Mastra workflow approval contract", () => {
  it("starts suspended and does not execute before a decision", async () => {
    const fixture = createApprovalFixture({ calls: 0 });
    const run = await fixture.workflow.createRun({ runId: "start-suspended" });

    const result = await run.start({ inputData: { value: "restart" } });

    expect(result.status).toBe("suspended");
    expect(fixture.counter.calls).toBe(0);
  });

  it("resumes an approved invocation and executes exactly once", async () => {
    const fixture = createApprovalFixture({ calls: 0 });
    const run = await fixture.workflow.createRun({ runId: "approve-success" });

    await expect(run.start({ inputData: { value: "restart" } })).resolves.toMatchObject({
      status: "suspended",
    });
    const result = await run.resume({
      step: "approval",
      resumeData: { approved: true },
    });

    expect(result).toMatchObject({
      status: "success",
      result: { status: "executed", value: "restart", calls: 1 },
    });
    expect(fixture.counter.calls).toBe(1);
  });

  it("resumes a rejected invocation with a denied result and no execution", async () => {
    const fixture = createApprovalFixture({ calls: 0 });
    const run = await fixture.workflow.createRun({ runId: "reject-denied" });

    await expect(run.start({ inputData: { value: "restart" } })).resolves.toMatchObject({
      status: "suspended",
    });
    const result = await run.resume({
      step: "approval",
      resumeData: { approved: false },
    });

    expect(result).toMatchObject({
      status: "success",
      result: { status: "denied", value: "restart", calls: 0 },
    });
    expect(fixture.counter.calls).toBe(0);
  });

  it("cancels a suspended run and prevents a later resume", async () => {
    const fixture = createApprovalFixture({ calls: 0 });
    const run = await fixture.workflow.createRun({ runId: "cancelled" });

    await expect(run.start({ inputData: { value: "restart" } })).resolves.toMatchObject({
      status: "suspended",
    });
    await run.cancel();

    await expect(
      run.resume({ step: "approval", resumeData: { approved: true } }),
    ).rejects.toThrow(/not suspended/i);
    expect(fixture.counter.calls).toBe(0);
    await expect(fixture.workflow.getWorkflowRunById(run.runId)).resolves.toMatchObject({
      status: "canceled",
    });
  });
});
