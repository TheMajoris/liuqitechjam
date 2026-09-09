import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitCommandExecutor,
  gitBlobOid,
  GitWorkspaceCheckpointStore,
  type GitCommandExecutor,
} from "../../../apps/server/src/projects/git-workspace-checkpoint-store.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore(options: { git?: GitCommandExecutor; secrets?: string[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lqam-checkpoint-store-"));
  roots.push(root);
  const workspace = path.join(root, "projects", "project-1", "workspace");
  await mkdir(workspace, { recursive: true });
  const store = new GitWorkspaceCheckpointStore({
    privateRoot: path.join(root, "checkpoints"),
    workspacePathFor: (projectId) => path.join(root, "projects", projectId, "workspace"),
    ...(options.git === undefined ? {} : { git: options.git }),
    configuredSecrets: () => options.secrets ?? [],
  });
  return { root, workspace, store };
}

async function write(workspace: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(workspace, ...relative.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function exists(workspace: string, relative: string): Promise<boolean> {
  try {
    await lstat(path.join(workspace, ...relative.split("/")));
    return true;
  } catch {
    return false;
  }
}

let ordinal = 0;
function checkpointId(): string {
  ordinal += 1;
  return "cp-" + String(ordinal).padStart(4, "0");
}

describe("GitWorkspaceCheckpointStore", () => {
  it("captures eligible source into a private bare repository outside the workspace", async () => {
    const { root, workspace, store } = await makeStore();
    await write(workspace, "README.md", "# Demo\n");
    await write(workspace, "src/app.ts", 'export const message = "hello";\n');
    await write(workspace, ".env", "ARK_API_KEY=not-a-real-secret-value\n");
    await write(workspace, "node_modules/pkg/index.js", "module.exports = 1;\n");
    await write(workspace, "image.png", "binary-ish");

    await store.ensureRepository("project-1", true);
    const capture = await store.capture(
      { projectId: "project-1", checkpointId: checkpointId(), parentGitSha: null, createdAt: new Date().toISOString() },
    );

    expect(capture.fileCount).toBe(2);
    expect(capture.excludedFileCount).toBe(2);
    expect(capture.gitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(await exists(workspace, ".git")).toBe(false);
    const repository = path.join(root, "checkpoints", "project-1", "repository.git");
    expect((await lstat(path.join(repository, "objects"))).isDirectory()).toBe(true);

    const manifest = await store.validate({ projectId: "project-1", ...capture });
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["README.md", "src/app.ts"]);
    expect(manifest.entries[1]?.oid).toBe(gitBlobOid(Buffer.from('export const message = "hello";\n')));
  });

  it("restores exact bytes, removes eligible files created later, and leaves excluded files alone", async () => {
    const { workspace, store } = await makeStore();
    await write(workspace, "README.md", "# Demo\n\nA section that will be deleted.\n");
    await write(workspace, "src/message.ts", 'export const message = "Ready for review";\n');
    await write(workspace, ".env", "SECRET=keep-me\n");
    await store.ensureRepository("project-1", true);
    const good = await store.capture(
      { projectId: "project-1", checkpointId: "good", parentGitSha: null, createdAt: new Date().toISOString() },
    );

    // The failed Agent overwrites, deletes, and creates.
    await write(workspace, "src/message.ts", 'export const message = "BROKEN";\n');
    await rm(path.join(workspace, "README.md"));
    await write(workspace, "src/partial.ts", "// half done\n");
    await write(workspace, "generated.log", "noise\n");

    const safety = await store.capture(
      { projectId: "project-1", checkpointId: "safety", parentGitSha: good.gitSha, createdAt: new Date().toISOString() },
    );
    expect(safety.fileCount).toBe(2);

    const plan = await store.prepareRestore({
      projectId: "project-1",
      targetCheckpointId: "good",
      targetTreeSha: good.treeSha,
      targetManifestHash: good.manifestHash,
      safetyCheckpointId: "safety",
    });
    expect(plan.actions.map((action) => action.kind + ":" + action.path).sort()).toEqual([
      "delete:src/partial.ts",
      "write:README.md",
      "write:src/message.ts",
    ]);

    const verified = await store.applyRestore(plan);
    expect(verified.manifestHash).toBe(good.manifestHash);
    expect(await readFile(path.join(workspace, "src", "message.ts"), "utf8")).toBe(
      'export const message = "Ready for review";\n',
    );
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toContain("A section that will be deleted.");
    expect(await exists(workspace, "src/partial.ts")).toBe(false);
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=keep-me\n");
    expect(await exists(workspace, "generated.log")).toBe(true);
    // No restore temp files linger.
    const names = await readdir(path.join(workspace, "src"));
    expect(names.some((name) => name.startsWith(".lqam-restore-"))).toBe(false);

    // Applying the same plan again is a no-op, not a second mutation.
    const again = await store.applyRestore(plan);
    expect(again.manifestHash).toBe(good.manifestHash);
  });

  it("is idempotent for a repeated intent and rejects a mismatching ref", async () => {
    const { workspace, store } = await makeStore();
    await write(workspace, "a.txt", "one\n");
    await store.ensureRepository("project-1", true);
    const first = await store.capture(
      { projectId: "project-1", checkpointId: "same", parentGitSha: null, createdAt: new Date().toISOString() },
    );
    const second = await store.capture(
      { projectId: "project-1", checkpointId: "same", parentGitSha: null, createdAt: new Date().toISOString() },
    );
    expect(second.gitSha).toBe(first.gitSha);

    await write(workspace, "a.txt", "two\n");
    await expect(
      store.capture({ projectId: "project-1", checkpointId: "same", parentGitSha: null, createdAt: new Date().toISOString() }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CORRUPT" });
  });

  it("aborts on a detected secret before any object is written", async () => {
    const { root, workspace, store } = await makeStore({ secrets: ["configured-runtime-secret-value"] });
    await write(workspace, "src/config.ts", 'export const key = "configured-runtime-secret-value";\n');
    await store.ensureRepository("project-1", true);
    await expect(
      store.capture({ projectId: "project-1", checkpointId: checkpointId(), parentGitSha: null, createdAt: new Date().toISOString() }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_SECRET_DETECTED" });
    const objects = path.join(root, "checkpoints", "project-1", "repository.git", "objects");
    const shards = (await readdir(objects)).filter((name) => /^[0-9a-f]{2}$/u.test(name));
    expect(shards).toHaveLength(0);

    await write(
      workspace,
      "src/config.ts",
      "const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----`;\n",
    );
    await expect(
      store.capture({ projectId: "project-1", checkpointId: checkpointId(), parentGitSha: null, createdAt: new Date().toISOString() }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_SECRET_DETECTED" });
  });

  it("leaves the user's own Git repository untouched", async () => {
    const { workspace, store } = await makeStore();
    await write(workspace, "src/app.ts", "let a = 1;\n");
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: workspace };
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: workspace, env });
    await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: workspace, env });
    await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "user commit"], {
      cwd: workspace,
      env,
    });
    const userHeadBefore = await readFile(path.join(workspace, ".git", "HEAD"), "utf8");
    await write(workspace, "src/app.ts", "let a = 2; // unstaged\n");

    await store.ensureRepository("project-1", true);
    const capture = await store.capture(
      { projectId: "project-1", checkpointId: "user", parentGitSha: null, createdAt: new Date().toISOString() },
    );
    await write(workspace, "src/app.ts", "let a = 3;\n");
    const plan = await store.prepareRestore({
      projectId: "project-1",
      targetCheckpointId: "user",
      targetTreeSha: capture.treeSha,
      targetManifestHash: capture.manifestHash,
      safetyCheckpointId: null,
    });
    await store.applyRestore(plan);

    expect(await readFile(path.join(workspace, "src", "app.ts"), "utf8")).toBe("let a = 2; // unstaged\n");
    expect(await readFile(path.join(workspace, ".git", "HEAD"), "utf8")).toBe(userHeadBefore);
    const log = await execFileAsync("git", ["log", "--oneline"], { cwd: workspace, env });
    expect(log.stdout.trim().split("\n")).toHaveLength(1);
    expect(log.stdout).toContain("user commit");
  });

  it("refuses to restore when an excluded directory occupies a target path", async () => {
    const { workspace, store } = await makeStore();
    await write(workspace, "notes.md", "text\n");
    await store.ensureRepository("project-1", true);
    const capture = await store.capture(
      { projectId: "project-1", checkpointId: "dir", parentGitSha: null, createdAt: new Date().toISOString() },
    );
    await rm(path.join(workspace, "notes.md"));
    await write(workspace, "notes.md/.env", "hidden\n");

    await expect(
      store.prepareRestore({
        projectId: "project-1",
        targetCheckpointId: "dir",
        targetTreeSha: capture.treeSha,
        targetManifestHash: capture.manifestHash,
        safetyCheckpointId: null,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_RESTORE_CONFLICT" });
    expect(await readFile(path.join(workspace, "notes.md", ".env"), "utf8")).toBe("hidden\n");
  });

  it("marks a checkpoint corrupt when its repository disappears, without reinitializing it", async () => {
    const { root, workspace, store } = await makeStore();
    await write(workspace, "a.txt", "one\n");
    await store.ensureRepository("project-1", true);
    const capture = await store.capture(
      { projectId: "project-1", checkpointId: "gone", parentGitSha: null, createdAt: new Date().toISOString() },
    );
    await rm(path.join(root, "checkpoints", "project-1"), { recursive: true, force: true });

    await expect(store.validate({ projectId: "project-1", ...capture })).rejects.toMatchObject({
      code: "CHECKPOINT_CORRUPT",
    });
    await expect(store.ensureRepository("project-1", false)).rejects.toMatchObject({
      code: "CHECKPOINT_CORRUPT",
    });
    expect(await store.hasRepository("project-1")).toBe(false);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("one\n");
  });

  it("never follows symlinks and treats them as excluded", async () => {
    const { root, workspace, store } = await makeStore();
    await write(workspace, "a.txt", "one\n");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "must not be read\n", "utf8");
    let linked = true;
    try {
      await symlink(outside, path.join(workspace, "link.txt"), "file");
    } catch {
      linked = false;
    }
    await store.ensureRepository("project-1", true);
    const capture = await store.capture(
      { projectId: "project-1", checkpointId: "links", parentGitSha: null, createdAt: new Date().toISOString() },
    );
    expect(capture.fileCount).toBe(1);
    if (linked) expect(capture.excludedFileCount).toBe(1);
  });

  it("runs Git with a private environment and argument arrays only", async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const real = createGitCommandExecutor("git");
    const spy: GitCommandExecutor = {
      run(args, options) {
        calls.push({ args: [...args], env: options.env });
        return real.run(args, options);
      },
    };
    const { workspace, store } = await makeStore({ git: spy });
    await write(workspace, "a.txt", "one\n");
    await write(workspace, ".gitattributes", "*.txt filter=evil\n");
    await store.ensureRepository("project-1", true);
    await store.capture(
      { projectId: "project-1", checkpointId: "env", parentGitSha: null, createdAt: new Date().toISOString() },
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(call.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(call.env.ARK_API_KEY).toBeUndefined();
      expect(call.args.some((argument) => argument.includes("status") || argument === "checkout")).toBe(false);
    }
  });
});
