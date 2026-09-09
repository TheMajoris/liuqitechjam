import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/persistence/migrate.js";
import { PostgresStore } from "../../../apps/server/src/persistence/postgres-store.js";
import { ToolApprovalStore } from "../../../apps/server/src/tools/tool-approval-store.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.TEST_DATABASE_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL ?? adminUrl;
const configured = adminUrl !== undefined && runtimeUrl !== undefined;
const postgresDescribe = configured ? describe.sequential : describe.skip;

let adminPool: pg.Pool | undefined;
let activeStore: PostgresStore | undefined;

postgresDescribe("ToolApprovalStore PostgreSQL compare-and-set", () => {
  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await adminPool.query("SELECT 1");
  });

  beforeEach(async () => {
    await adminPool?.query("DROP SCHEMA IF EXISTS launchpad CASCADE");
    if (adminUrl === undefined) throw new Error("TEST_DATABASE_ADMIN_URL is not configured");
    await runMigrations({ adminUrl });
  });

  afterEach(async () => {
    await activeStore?.close();
    activeStore = undefined;
  });

  afterAll(async () => {
    await adminPool?.end();
    adminPool = undefined;
  });

  it("allows exactly one execution start for the same durable version", async () => {
    if (runtimeUrl === undefined) throw new Error("TEST_DATABASE_URL is not configured");
    activeStore = new PostgresStore(runtimeUrl);
    await activeStore.initialize();
    const first = new ToolApprovalStore(activeStore);
    const second = new ToolApprovalStore(activeStore);
    const created = await first.createInvocation({
      approvalId: "pg-approval-1",
      invocationId: "pg-invocation-1",
      workflowRunId: "pg-workflow-1",
      agentId: "pg-agent-1",
      projectId: "pg-project-1",
      runId: "pg-run-1",
      toolId: "project.preview.restart",
      policyVersion: "tool-approval-v1",
      inputBinding: "private-input",
      privateInput: { safe: true },
      safeSummary: "Restart preview",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      initialStatus: "waiting",
    });

    const approved = await first.claimDecision({
      approvalId: created.approvalId,
      expectedVersion: created.version,
      approved: true,
      actor: { kind: "human", id: "demo-owner" },
    });
    const starts = await Promise.all([
      first.claimExecutionStart({
        approvalId: created.approvalId,
        expectedVersion: approved.record.version,
      }),
      second.claimExecutionStart({
        approvalId: created.approvalId,
        expectedVersion: approved.record.version,
      }),
    ]);
    expect(starts.filter((result) => result.claimed)).toHaveLength(1);
    expect(starts.filter((result) => !result.claimed)).toHaveLength(1);
    expect(starts.find((result) => !result.claimed)?.reason).toMatch(/already_started|stale/);
    expect(activeStore.snapshot().toolApprovalInvocations[0]).toMatchObject({
      status: "executing",
      version: 3,
    });
  });
});
