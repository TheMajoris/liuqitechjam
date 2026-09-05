import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DefaultAuthorizationService } from "../../apps/server/src/access/default-authorization-service.js";
import { AuditService } from "../../apps/server/src/audit/audit-service.js";
import { StorageAuditStoreAdapter } from "../../apps/server/src/audit/audit-store.js";
import { agentPrincipal } from "../../apps/server/src/access/access-types.js";
import { AgentService } from "../../apps/server/src/agent-service.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { runMigrations } from "../../apps/server/src/persistence/migrate.js";
import { importJsonToPostgres } from "../../apps/server/src/persistence/import-json.js";
import { PostgresStore } from "../../apps/server/src/persistence/postgres-store.js";
import { ProjectService } from "../../apps/server/src/projects/project-service.js";
import { ProjectServiceExecutionScope } from "../../apps/server/src/projects/project-execution.js";
import { ProjectWorkspaceManager } from "../../apps/server/src/projects/project-workspace.js";
import { emptyDatabase, JsonStore } from "../../apps/server/src/store.js";
import type { Agent, AgentRunner, RunnerRequest, RunnerResult } from "../../apps/server/src/types.js";
import { WorkspaceManager } from "../../apps/server/src/workspace.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.TEST_DATABASE_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL ?? adminUrl;
const configured = adminUrl !== undefined && runtimeUrl !== undefined;

/**
 * These checks are deliberately opt-in. A skipped suite says nothing about
 * database persistence or privileges; CI/presentation runs should provide a
 * disposable database through TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL.
 */
const postgresDescribe = configured ? describe.sequential : describe.skip;

const roots: string[] = [];
const openStores: PostgresStore[] = [];
let adminPool: pg.Pool | undefined;

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: `completed:${request.prompt}`,
      threadId: request.threadId ?? "postgres-test-thread",
      usage: null,
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function agent(id: string): Agent {
  const now = new Date().toISOString();
  return {
    id,
    name: `Agent ${id}`,
    description: "PostgreSQL integration fixture",
    instructions: "Be concise.",
    skillIds: [],
    status: "ready",
    workspacePath: `/tmp/launchpad-postgres-${id}`,
    codexThreadId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function applySchema(): Promise<void> {
  if (adminUrl === undefined) throw new Error("TEST_DATABASE_ADMIN_URL is not configured");
  await runMigrations({ adminUrl });
}

async function resetSchema(): Promise<void> {
  if (adminPool === undefined) return;
  await adminPool.query("DROP SCHEMA IF EXISTS launchpad CASCADE");
  await applySchema();
}

async function openStore(): Promise<PostgresStore> {
  if (runtimeUrl === undefined) throw new Error("TEST_DATABASE_URL is not configured");
  const store = new PostgresStore(runtimeUrl);
  openStores.push(store);
  await store.initialize();
  return store;
}

async function runJsonImport(sourcePath: string): Promise<void> {
  if (adminUrl === undefined) throw new Error("TEST_DATABASE_ADMIN_URL is not configured");
  await importJsonToPostgres({ adminUrl, sourcePath });
}

postgresDescribe("PostgreSQL persistence", () => {
  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await adminPool.query("SELECT 1");
  });

  beforeEach(async () => {
    await resetSchema();
  });

  afterEach(async () => {
    await Promise.all(openStores.splice(0).map((store) => store.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await adminPool?.end();
    adminPool = undefined;
  });

  it("persists agents, projects, runs, and messages across store recreation", async () => {
    const first = await openStore();
    const createdAt = "2026-09-05T00:00:00.000Z";
    await first.mutate((database) => {
      const record = agent("restart-agent");
      record.createdAt = createdAt;
      record.updatedAt = createdAt;
      database.agents.push(record);
      database.projects.push({
        id: "restart-project",
        name: "Restart project",
        description: "Persistent project",
        workspacePath: "/tmp/restart-project",
        teamId: null,
        ownerPrincipalId: "demo-owner",
        status: "active",
        createdAt,
        updatedAt: createdAt,
      });
      database.runs.push({
        id: "restart-run",
        agentId: record.id,
        status: "completed",
        prompt: "persist this",
        output: "done",
        error: null,
        usage: null,
        startedAt: createdAt,
        completedAt: createdAt,
        createdAt,
      });
      database.messages.push({
        id: "restart-message",
        agentId: record.id,
        runId: "restart-run",
        role: "assistant",
        content: "done",
        origin: "direct",
        createdAt,
      });
    });
    await first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const second = await openStore();
    const snapshot = second.snapshot();
    expect(snapshot.agents.map((record) => record.id)).toEqual(["restart-agent"]);
    expect(snapshot.projects[0]).toMatchObject({ id: "restart-project", createdAt });
    expect(snapshot.runs[0]).toMatchObject({ id: "restart-run", agentId: "restart-agent" });
    expect(snapshot.messages[0]).toMatchObject({ id: "restart-message", runId: "restart-run" });
  });

  it("rolls back failed mutations and enforces relational duplicate constraints", async () => {
    const store = await openStore();
    await expect(
      store.mutate((database) => {
        database.agents.push(agent("rolled-back"));
        throw new Error("abort this transaction");
      }),
    ).rejects.toThrow("abort this transaction");
    expect(store.snapshot().agents).toHaveLength(0);

    await store.mutate((database) => {
      database.agents.push(agent("duplicate"));
    });
    expect(store.snapshot().agents).toHaveLength(1);

    if (adminPool === undefined) throw new Error("PostgreSQL admin pool is not initialized");
    const now = new Date().toISOString();
    const values = [
      "duplicate-direct",
      "Duplicate direct",
      "ready",
      "/tmp/duplicate-direct",
      now,
      now,
      999,
      JSON.stringify(agent("duplicate-direct")),
    ];
    await adminPool.query(
      `INSERT INTO launchpad.agents
        (id, name, status, workspace_path, created_at, updated_at, ordinal, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      values,
    );
    await expect(
      adminPool.query(
        `INSERT INTO launchpad.agents
          (id, name, status, workspace_path, created_at, updated_at, ordinal, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        values,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("imports JSON transactionally without rewriting the source or losing links and hashes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-postgres-import-"));
    roots.push(root);
    const sourcePath = path.join(root, "launchpad.json");
    const sourceStore = new JsonStore(sourcePath);
    await sourceStore.initialize();
    const sourceAgent = agent("import-agent");
    await sourceStore.mutate((database) => {
      database.agents.push(sourceAgent);
      database.projects.push({
        id: "import-project",
        name: "Imported project",
        description: "Relationships survive import",
        workspacePath: "/tmp/import-project",
        teamId: null,
        ownerPrincipalId: "demo-owner",
        status: "active",
        createdAt: sourceAgent.createdAt,
        updatedAt: sourceAgent.updatedAt,
      });
      database.runs.push({
        id: "import-run",
        agentId: sourceAgent.id,
        status: "completed",
        prompt: "import this",
        output: "imported",
        error: null,
        usage: null,
        startedAt: sourceAgent.createdAt,
        completedAt: sourceAgent.updatedAt,
        createdAt: sourceAgent.createdAt,
      });
      database.messages.push({
        id: "import-message",
        agentId: sourceAgent.id,
        runId: "import-run",
        role: "assistant",
        content: "imported",
        origin: "direct",
        createdAt: sourceAgent.updatedAt,
      });
    });
    const sourceAudit = new AuditService(new StorageAuditStoreAdapter(sourceStore));
    const sourceEvent = await sourceAudit.record({
      type: "tool_started",
      status: "success",
      summary: "import evidence",
      principal: agentPrincipal(sourceAgent.id),
      agentId: sourceAgent.id,
      projectId: "import-project",
      runId: "import-run",
      metadata: { bearerToken: "redacted", reason: "preserve this" },
    });
    await sourceStore.close();
    const originalBytes = await readFile(sourcePath);

    const invalidPath = path.join(root, "invalid.json");
    await writeFile(invalidPath, '{"version":1,"agents":"not-an-array"}\n', "utf8");
    await expect(runJsonImport(invalidPath)).rejects.toThrow();
    const afterInvalid = await openStore();
    expect(afterInvalid.snapshot().agents).toHaveLength(0);
    await afterInvalid.close();
    openStores.splice(openStores.indexOf(afterInvalid), 1);

    await runJsonImport(sourcePath);
    const imported = await openStore();
    const importedSnapshot = imported.snapshot();
    expect(importedSnapshot.agents[0]).toMatchObject({ id: sourceAgent.id, createdAt: sourceAgent.createdAt });
    expect(importedSnapshot.projects[0]).toMatchObject({ id: "import-project", ownerPrincipalId: "demo-owner" });
    expect(importedSnapshot.runs[0]).toMatchObject({ id: "import-run", agentId: sourceAgent.id });
    expect(importedSnapshot.messages[0]).toMatchObject({ id: "import-message", runId: "import-run" });
    expect(importedSnapshot.auditEvents[0]).toMatchObject({
      id: sourceEvent.id,
      sequence: sourceEvent.sequence,
      hash: sourceEvent.hash,
      prevHash: sourceEvent.prevHash,
    });
    expect(await readFile(sourcePath)).toEqual(originalBytes);
    await imported.close();
    openStores.splice(openStores.indexOf(imported), 1);

    const nonemptySource = path.join(root, "second.json");
    await writeFile(nonemptySource, JSON.stringify({ ...emptyDatabase(), agents: [agent("second-agent")] }) + "\n", "utf8");
    await expect(runJsonImport(nonemptySource)).rejects.toThrow();
    const afterNonempty = await openStore();
    expect(afterNonempty.snapshot().agents.map((record) => record.id)).toEqual([sourceAgent.id]);
  });

  it("serializes concurrent audit appends, preserves redaction, and verifies the full chain", async () => {
    const store = await openStore();
    const adapter = new StorageAuditStoreAdapter(store);
    const audit = new AuditService(adapter);
    const events = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        audit.record({
          type: "tool_started",
          status: "success",
          summary: `concurrent ${index}`,
          principal: agentPrincipal("concurrent-agent"),
          metadata: { index, bearerToken: "do-not-persist", rawOutput: "do-not-persist" },
        }),
      ),
    );
    const sequences = events.map((event) => event.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(adapter.read()).toHaveLength(24);
    expect(adapter.read().every((event) => !JSON.stringify(event).includes("do-not-persist"))).toBe(true);
    expect(audit.verify()).toEqual({ ok: true, checked: 24 });
  });

  it("rejects audit UPDATE, DELETE, and TRUNCATE at the PostgreSQL boundary", async () => {
    const store = await openStore();
    const audit = new AuditService(new StorageAuditStoreAdapter(store));
    const event = await audit.record({
      type: "tool_started",
      status: "success",
      summary: "immutable evidence",
      principal: agentPrincipal("immutable-agent"),
    });
    if (adminPool === undefined) throw new Error("PostgreSQL admin pool is not initialized");
    const mutationPool = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await expect(
        mutationPool.query(
          "UPDATE launchpad.audit_events SET record = jsonb_set(record, '{summary}', '\"tampered\"'::jsonb) WHERE id = $1",
          [event.id],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        mutationPool.query("DELETE FROM launchpad.audit_events WHERE id = $1", [event.id]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(mutationPool.query("TRUNCATE launchpad.audit_events")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await mutationPool.end();
    }
    for (const statement of [
      "UPDATE launchpad.audit_events SET record = jsonb_set(record, '{summary}', '\"owner-tampered\"'::jsonb) WHERE id = $1",
      "DELETE FROM launchpad.audit_events WHERE id = $1",
      "TRUNCATE launchpad.audit_events",
    ]) {
      const values = statement.startsWith("TRUNCATE") ? [] : [event.id];
      await expect(adminPool.query(statement, values)).rejects.toMatchObject({ code: "P0001" });
    }
    expect((await adminPool.query("SELECT count(*)::int AS count FROM launchpad.audit_events")).rows[0]?.count).toBe(1);
  });

  it("keeps the existing Agent–Project–Run path working on PostgreSQL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-postgres-stack-"));
    roots.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      PERSISTENCE_BACKEND: "postgres",
      DATABASE_URL: runtimeUrl,
    });
    const store = await openStore();
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
    );
    await service.initialize();
    const projects = new ProjectService(
      store,
      new ProjectWorkspaceManager(path.join(root, "data", "projects")),
      service,
      new DefaultAuthorizationService(),
    );
    await projects.initialize();
    service.setProjectExecutionScope(new ProjectServiceExecutionScope(projects));
    const created = await service.createAgent({ name: "Postgres Agent" });
    const project = await projects.create({ name: "Postgres Project" });
    await projects.attachAgent(project.id, created.id);
    const accepted = await service.sendMessage(created.id, "persist this run", { projectId: project.id });
    const run = await service.waitForRun(accepted.run.id, { timeoutMs: 5_000 });
    expect(run.status).toBe("completed");
    expect(service.getMessages(created.id)).toHaveLength(2);
    expect((await projects.list()).some((record) => record.id === project.id)).toBe(true);

    await store.close();
    openStores.splice(openStores.indexOf(store), 1);
    const recreated = await openStore();
    expect(recreated.snapshot().agents).toHaveLength(1);
    expect(recreated.snapshot().runs).toMatchObject([{ id: accepted.run.id, status: "completed" }]);
    expect(recreated.snapshot().projects).toMatchObject([{ id: project.id, status: "active" }]);
    expect(recreated.snapshot().messages).toHaveLength(2);
  });
});
