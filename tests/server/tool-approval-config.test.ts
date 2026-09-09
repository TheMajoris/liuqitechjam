import { describe, expect, it } from "vitest";
import {
  loadConfig,
  toolApprovalStartupDiagnostic,
} from "../../apps/server/src/config.js";

const testEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PERSISTENCE_BACKEND: "json",
};

describe("tool approval startup configuration", () => {
  it("is disabled by default and exposes one canonical opt-in mode", () => {
    const config = loadConfig(testEnvironment);
    expect(config.mcpToolApprovalEnabled).toBe(false);
    expect(config.mcpToolApprovalStorage).toBe("postgres");
    expect(config.mcpToolApprovalSchema).toBe("mastra_approval");
  });

  it("rejects production approval with JSON application persistence", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      PERSISTENCE_BACKEND: "json",
      MCP_TOOL_APPROVAL_ENABLED: "true",
      MCP_TOOL_APPROVAL_STORAGE: "postgres",
      DATABASE_URL: "postgres://launchpad:secret@db.example.test/app",
    })).toThrow(/PERSISTENCE_BACKEND=postgres/u);
  });

  it("permits explicit in-memory workflow storage only in test mode", () => {
    const config = loadConfig({
      ...testEnvironment,
      MCP_TOOL_APPROVAL_ENABLED: "true",
      MCP_TOOL_APPROVAL_STORAGE: "memory",
    });
    expect(config.mcpToolApprovalEnabled).toBe(true);
    expect(config.mcpToolApprovalStorage).toBe("memory");
    expect(() => loadConfig({
      NODE_ENV: "production",
      PERSISTENCE_BACKEND: "postgres",
      DATABASE_URL: "postgres://launchpad:secret@db.example.test/app",
      MCP_TOOL_APPROVAL_ENABLED: "true",
      MCP_TOOL_APPROVAL_STORAGE: "memory",
    })).toThrow(/InMemory storage/u);
  });

  it("provides safe operator guidance when PostgreSQL workflow storage is unavailable", () => {
    const message = toolApprovalStartupDiagnostic({
      mcpToolApprovalStorage: "postgres",
      mcpToolApprovalSchema: "mastra_approval",
    });
    expect(message).toContain("npm run db:migrate");
    expect(message).toContain('schema "mastra_approval"');
    expect(message).toContain("operator-managed");
    expect(message).not.toContain("DATABASE_URL=");
    expect(message).not.toContain("secret");
  });

  it("keeps memory-storage diagnostics scoped to non-production use", () => {
    expect(toolApprovalStartupDiagnostic({
      mcpToolApprovalStorage: "memory",
      mcpToolApprovalSchema: "mastra_approval",
    })).toContain("development/test");
  });

  it("requires explicit provisioning guidance for a custom PostgreSQL schema", () => {
    const message = toolApprovalStartupDiagnostic({
      mcpToolApprovalStorage: "postgres",
      mcpToolApprovalSchema: "custom_approval",
    });
    expect(message).toContain('"custom_approval" explicitly');
    expect(message).toContain("USAGE, CREATE");
    expect(message).toContain('only the default schema "mastra_approval"');
    expect(message).not.toMatch(/Run npm run db:migrate with DATABASE_ADMIN_URL/u);
    expect(message).not.toContain("DATABASE_URL=");
  });
});
