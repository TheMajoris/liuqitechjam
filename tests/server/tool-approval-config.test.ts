import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/server/src/config.js";

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
});
