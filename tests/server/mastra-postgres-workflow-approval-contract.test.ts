import { describe, expect, it } from "vitest";
import { Mastra } from "@mastra/core";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { PostgresStore } from "@mastra/pg";
import { z } from "zod";

type Counter = { starts: number };

const databaseUrl = process.env.MASTRA_PG_TEST_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;

const inputSchema = z.object({ value: z.string() });
const outputSchema = z.object({
  status: z.enum(["denied", "executed"]),
  value: z.string(),
  starts: z.number(),
});
const suspendSchema = z.object({ summary: z.string() });
const resumeSchema = z.object({ approved: z.boolean() });

function createApprovalWorkflow(counter: Counter) {
  const approvalStep = createStep({
    id: "approval",
    inputSchema,
    outputSchema,
    suspendSchema,
    resumeSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (resumeData === undefined) {
        return await suspend({ summary: "Approval is required" });
      }
      if (!resumeData.approved) {
        return { status: "denied" as const, value: inputData.value, starts: counter.starts };
      }
      counter.starts += 1;
      return { status: "executed" as const, value: inputData.value, starts: counter.starts };
    },
  });

  return createWorkflow({
    id: "postgres-approval-contract",
    description: "PostgreSQL-backed Mastra workflow approval contract fixture",
    inputSchema,
    outputSchema,
    retryConfig: { attempts: 0, delay: 0 },
  })
    .then(approvalStep)
    .commit();
}

postgresDescribe("Mastra PostgreSQL workflow approval contract", () => {
  it("round-trips a suspended snapshot and allows only one competing resume", async () => {
    const counter = { starts: 0 };
    const schemaName = `mastra_approval_${process.pid}_${Date.now().toString(36)}`;
    const store = new PostgresStore({
      id: `postgres-approval-${process.pid}`,
      connectionString: databaseUrl!,
      schemaName,
    });
    const workflow = createApprovalWorkflow(counter);

    new Mastra({
      logger: false,
      storage: store,
      workflows: { [workflow.id]: workflow },
    });

    try {
      await store.init();
      const workflowsStore = await store.getStore("workflows");
      expect(workflowsStore?.supportsConcurrentUpdates()).toBe(true);

      const run = await workflow.createRun({ runId: `postgres-approval-run-${Date.now()}` });
      const started = await run.start({ inputData: { value: "restart" } });
      expect(started.status).toBe("suspended");

      const suspendedSnapshot = await workflowsStore?.loadWorkflowSnapshot({
        workflowName: workflow.id,
        runId: run.runId,
      });
      expect(suspendedSnapshot).toMatchObject({
        runId: run.runId,
        status: "suspended",
      });

      const resumes = await Promise.allSettled([
        run.resume({ step: "approval", resumeData: { approved: true } }),
        run.resume({ step: "approval", resumeData: { approved: true } }),
      ]);
      const successes = resumes.filter((result) => result.status === "fulfilled");
      const failures = resumes.filter((result) => result.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(successes[0]).toMatchObject({
        status: "fulfilled",
        value: {
          status: "success",
          result: { status: "executed", starts: 1 },
        },
      });
      expect(counter.starts).toBe(1);

      const completedSnapshot = await workflowsStore?.loadWorkflowSnapshot({
        workflowName: workflow.id,
        runId: run.runId,
      });
      expect(completedSnapshot).toMatchObject({ runId: run.runId, status: "success" });
    } finally {
      try {
        await store.db.none(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await store.close();
      }
    }
  });
});
