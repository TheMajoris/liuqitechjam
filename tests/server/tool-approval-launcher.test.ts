import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const pocLauncher = new URL("../../scripts/start-local-poc.sh", import.meta.url);
const postgresLauncher = new URL("../../scripts/start-local-postgres.sh", import.meta.url);
const bootstrapSource = new URL("../../apps/server/src/bootstrap.ts", import.meta.url);

describe("local approval bootstrap contract", () => {
  it("enables approval mode by default for the local POC", async () => {
    const source = await readFile(pocLauncher, "utf8");
    expect(source).toContain('approval_enabled="${MCP_TOOL_APPROVAL_ENABLED:-}"');
    expect(source).toContain('approval_enabled="${MCP_APPROVAL_ENABLED:-}"');
    expect(source).toContain('approval_enabled="${TOOL_APPROVAL_ENABLED:-}"');
    expect(source).toContain('export MCP_TOOL_APPROVAL_ENABLED="$approval_enabled"');
    expect(source).toContain("approval_enabled=true");
  });

  it("leaves an externally configured database to the operator", async () => {
    const source = await readFile(postgresLauncher, "utf8");
    expect(source).toContain('if [[ -n "${DATABASE_URL:-}" ]]');
    expect(source).toContain("run npm run db:migrate separately");
    expect(source).toContain("return 0");
  });

  it("wires the safe approval diagnostic into bootstrap failure handling", async () => {
    const source = await readFile(bootstrapSource, "utf8");
    expect(source).toContain("toolApprovalStartupDiagnostic(config)");
    expect(source).toContain("console.warn(toolApprovalStartupDiagnostic(config))");
  });
});
