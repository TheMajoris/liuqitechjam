import { describe, expect, it } from "vitest";
import {
  assertNoCaseCollisions,
  sourceV1Policy,
  validateManifestEntry,
  validateRelativePath,
} from "../../../apps/server/src/projects/workspace-checkpoint-policy.js";

describe("source-v1 checkpoint policy", () => {
  it("denies credential paths regardless of allowlisting", () => {
    for (const denied of [
      ".env",
      ".env.local",
      "config/.env.production",
      ".ENV",
      ".aws/credentials",
      "secrets/config.json",
      "deploy/server.pem",
      "keys/id_rsa",
      "src/credentials.ts",
      "app.log",
      "notes.md~",
      ".git/config",
      "node_modules/pkg/index.js",
      "dist/bundle.js",
    ]) {
      expect(sourceV1Policy.classifyPath(denied, "file").eligible, denied).toBe(false);
    }
  });

  it("includes ordinary source, config and docs", () => {
    for (const eligible of [
      "README.md",
      "src/app.ts",
      "src/components/App.tsx",
      "package.json",
      "package-lock.json",
      "Dockerfile",
      ".gitignore",
      "docs/guide.mdx",
      "scripts/run.sh",
      "styles/site.css",
    ]) {
      expect(sourceV1Policy.classifyPath(eligible, "file").eligible, eligible).toBe(true);
    }
    expect(sourceV1Policy.classifyPath("logo.png", "file")).toMatchObject({
      eligible: false,
      reason: "not_allowlisted",
    });
  });

  it("does not descend into denied directories", () => {
    expect(sourceV1Policy.classifyPath("node_modules", "directory").eligible).toBe(false);
    expect(sourceV1Policy.classifyPath(".git", "directory").eligible).toBe(false);
    expect(sourceV1Policy.classifyPath("src", "directory").eligible).toBe(true);
  });

  it("rejects traversal, absolute paths and control characters", () => {
    for (const unsafe of ["../x.ts", "/etc/passwd", "C:/x.ts", "a/../b.ts", "a\\b.ts", "a\u0000b.ts", "a\nb.ts", "", "a//b.ts"]) {
      expect(() => validateRelativePath(unsafe), JSON.stringify(unsafe)).toThrow();
    }
    expect(() => validateRelativePath("with space/-leading-dash.ts")).not.toThrow();
  });

  it("detects secrets in otherwise eligible content and reveals nothing about them", () => {
    const configured = "configured-runtime-secret-value-123";
    const cases = [
      "const key = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';",
      "-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----",
      "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      'API_KEY="q8Zr2Lm9Xp4Vt7Bn1Cs6Dh3Fk5Gj0Yw"',
      "token: " + configured,
    ];
    for (const content of cases) {
      let thrown: unknown;
      try {
        sourceV1Policy.scanContent("src/x.ts", Buffer.from(content), [configured]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, content).toMatchObject({ code: "CHECKPOINT_SECRET_DETECTED" });
      expect(String((thrown as Error).message)).not.toContain("sk-");
      expect(String((thrown as Error).message)).not.toContain(configured);
    }
  });

  it("passes ordinary code that merely names a key", () => {
    const fine = [
      "const apiKey = process.env.ARK_API_KEY;",
      "apiKey: config.arkApiKey,",
      'password = "replace-with-your-password"',
      "export const SECRET_LIMIT = 42;",
      "// token: the participant identifier",
    ];
    for (const content of fine) {
      expect(sourceV1Policy.scanContent("src/x.ts", Buffer.from(content), []), content).toBe(true);
    }
    expect(sourceV1Policy.scanContent("src/x.ts", Buffer.from([0x50, 0x4b, 0x00, 0x03]), [])).toBe(false);
  });

  it("rejects manifest entries the current policy would never capture", () => {
    expect(() =>
      validateManifestEntry(sourceV1Policy, { path: ".env", mode: "100644", oid: "a".repeat(40), size: 1 }),
    ).toThrow(expect.objectContaining({ code: "CHECKPOINT_POLICY_MISMATCH" }));
    expect(() =>
      validateManifestEntry(sourceV1Policy, { path: "src/app.ts", mode: "120000" as "100644", oid: "a".repeat(40), size: 1 }),
    ).toThrow(expect.objectContaining({ code: "CHECKPOINT_CORRUPT" }));
    expect(() => assertNoCaseCollisions(["Src/App.ts", "src/app.ts"])).toThrow(
      expect.objectContaining({ code: "CHECKPOINT_INVALID_INPUT" }),
    );
  });
});
