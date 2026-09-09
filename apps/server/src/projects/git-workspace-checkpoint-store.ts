import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  assertNoCaseCollisions,
  CHECKPOINT_LIMITS,
  sourceV1Policy,
  validateManifestEntry,
  type CheckpointPolicy,
  type ManifestEntry,
} from "./workspace-checkpoint-policy.js";
import {
  WorkspaceCheckpointError,
  type WorkspaceCheckpointErrorCode,
} from "./workspace-checkpoint-types.js";

const NULL_SHA = "0000000000000000000000000000000000000000";
const REF_PREFIX = "refs/lqam/checkpoints/";
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RESTORE_TEMP_PREFIX = ".lqam-restore-";
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

// -------------------------------------------------------------- executor

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface GitCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: Buffer | undefined;
  timeoutMs: number;
  maxOutputBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * The only seam through which checkpoint code runs Git. Arguments are always
 * an array (never a shell string), content travels over stdin, and the
 * environment is the private one built by the store, so an Agent-authored
 * configuration, hook, attribute, or ignore rule is never consulted.
 */
export interface GitCommandExecutor {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

class GitSpawnError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "timeout" | "aborted" | "spawn",
  ) {
    super(message);
    this.name = "GitSpawnError";
  }
}

export function createGitCommandExecutor(binary = "git"): GitCommandExecutor {
  return {
    run(args, options) {
      return new Promise<GitCommandResult>((resolve, reject) => {
        let child;
        try {
          child = spawn(binary, [...args], {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          reject(new GitSpawnError(String(error), "spawn"));
          return;
        }
        const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timedOut = false;
        let aborted = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          aborted = true;
          child.kill("SIGKILL");
        };
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs);
        timer.unref();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > limit) {
            child.kill("SIGKILL");
            finish(() => reject(new GitSpawnError("Git output exceeded the bounded buffer", "spawn")));
            return;
          }
          stdoutChunks.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          // Stderr is retained only for classification; it is never surfaced.
          if (stderrBytes < 8_192) {
            stderrChunks.push(chunk.subarray(0, 8_192 - stderrBytes));
            stderrBytes += chunk.length;
          }
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          finish(() =>
            reject(
              new GitSpawnError(
                error.message,
                error.code === "ENOENT" ? "missing" : "spawn",
              ),
            ),
          );
        });
        child.on("close", (code) => {
          finish(() => {
            if (timedOut) {
              reject(new GitSpawnError("Git command timed out", "timeout"));
              return;
            }
            if (aborted) {
              reject(new GitSpawnError("Git command was aborted", "aborted"));
              return;
            }
            resolve({
              stdout: Buffer.concat(stdoutChunks),
              stderr: Buffer.concat(stderrChunks),
              exitCode: code ?? 1,
            });
          });
        });
        if (child.stdin) {
          child.stdin.on("error", () => undefined);
          if (options.input !== undefined) child.stdin.end(options.input);
          else child.stdin.end();
        }
      });
    },
  };
}

// --------------------------------------------------------------- manifests

export interface ValidatedManifest {
  entries: ManifestEntry[];
  manifestHash: string;
  fileCount: number;
  byteCount: number;
}

export interface PhysicalCapture {
  gitSha: string;
  treeSha: string;
  manifestHash: string;
  fileCount: number;
  byteCount: number;
  excludedFileCount: number;
}

export type RestoreAction =
  | { kind: "write"; path: string; mode: ManifestEntry["mode"]; oid: string; size: number }
  | { kind: "delete"; path: string };

export interface RestorePlan {
  projectId: string;
  targetCheckpointId: string;
  targetTreeSha: string;
  targetManifestHash: string;
  /** The ready safety checkpoint captured immediately before this plan. */
  safetyCheckpointId: string | null;
  sourceManifestHash: string;
  actions: RestoreAction[];
  /** SHA-256 of the canonical plan; persisted so a resume reapplies the same plan. */
  planHash: string;
}

/** Git blob identity for exact bytes: sha1("blob <size>\0" + content). */
export function gitBlobOid(content: Buffer): string {
  return createHash("sha1")
    .update("blob " + String(content.length) + "\0")
    .update(content)
    .digest("hex");
}

function compareEntries(left: ManifestEntry, right: ManifestEntry): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

export function manifestHashOf(entries: readonly ManifestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort(compareEntries)) {
    hash.update(`${entry.mode} ${entry.oid} ${entry.size}\t${entry.path}\n`);
  }
  return hash.digest("hex");
}

function toValidatedManifest(entries: ManifestEntry[]): ValidatedManifest {
  const sorted = [...entries].sort(compareEntries);
  return {
    entries: sorted,
    manifestHash: manifestHashOf(sorted),
    fileCount: sorted.length,
    byteCount: sorted.reduce((total, entry) => total + entry.size, 0),
  };
}

function planHashOf(plan: Omit<RestorePlan, "planHash">): string {
  const hash = createHash("sha256");
  hash.update(
    [plan.projectId, plan.targetCheckpointId, plan.targetTreeSha, plan.targetManifestHash,
      plan.safetyCheckpointId ?? "", plan.sourceManifestHash].join("\n") + "\n",
  );
  for (const action of plan.actions) {
    hash.update(
      action.kind === "write"
        ? `write ${action.mode} ${action.oid} ${action.size}\t${action.path}\n`
        : `delete\t${action.path}\n`,
    );
  }
  return hash.digest("hex");
}

// ------------------------------------------------------------- inventory

interface SourceFile extends ManifestEntry {
  content: Buffer;
}

interface SourceInventory {
  files: SourceFile[];
  excludedFileCount: number;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === code
  );
}

// ----------------------------------------------------------------- store

export interface GitWorkspaceCheckpointStoreOptions {
  /** Private parent of every Project checkpoint repository; never mounted. */
  privateRoot: string;
  /** Derives the canonical workspace path; persisted paths are never trusted. */
  workspacePathFor: (projectId: string) => string;
  git?: GitCommandExecutor;
  gitBinary?: string;
  policy?: CheckpointPolicy;
  /** Runtime secret values supplied privately to the content scanner. */
  configuredSecrets?: () => readonly string[];
}

/**
 * The only module that runs checkpoint Git commands or materializes a source
 * tree. Each Project owns one bare repository under the private root, outside
 * every Agent and preview mount. Blobs are written from already-scanned bytes,
 * trees and commits through plumbing, and refs with expected-old guards so a
 * repeated capture is idempotent rather than duplicated.
 */
export class GitWorkspaceCheckpointStore {
  private readonly privateRoot: string;
  private readonly git: GitCommandExecutor;
  private readonly policy: CheckpointPolicy;
  private readonly configuredSecrets: () => readonly string[];
  private readonly workspacePathFor: (projectId: string) => string;
  private capabilityProbe: Promise<WorkspaceCheckpointErrorCode | null> | null = null;

  constructor(options: GitWorkspaceCheckpointStoreOptions) {
    this.privateRoot = path.resolve(options.privateRoot);
    this.git = options.git ?? createGitCommandExecutor(options.gitBinary ?? "git");
    this.policy = options.policy ?? sourceV1Policy;
    this.configuredSecrets = options.configuredSecrets ?? (() => []);
    this.workspacePathFor = options.workspacePathFor;
  }

  /** Probe the Git executable once; a missing binary is a capability gap, not a crash. */
  async probeCapability(): Promise<WorkspaceCheckpointErrorCode | null> {
    if (!this.capabilityProbe) {
      this.capabilityProbe = (async () => {
        try {
          await this.ensurePrivateRoot();
          const version = await this.git.run(["--version"], {
            cwd: this.privateRoot,
            env: this.baseEnvironment(),
            timeoutMs: CHECKPOINT_LIMITS.gitCommandTimeoutMs,
          });
          if (version.exitCode !== 0) return "CHECKPOINT_UNAVAILABLE";
          const probeRepository = path.join(this.privateRoot, ".probe-" + randomBytes(4).toString("hex"));
          try {
            await this.initializeRepository(probeRepository);
          } finally {
            await rm(probeRepository, { recursive: true, force: true }).catch(() => undefined);
          }
          return null;
        } catch {
          return "CHECKPOINT_UNAVAILABLE";
        }
      })();
    }
    return this.capabilityProbe;
  }

  repositoryPath(projectId: string): string {
    assertSafeIdentifier(projectId);
    return path.join(this.privateRoot, projectId, "repository.git");
  }

  private projectPrivateDirectory(projectId: string): string {
    assertSafeIdentifier(projectId);
    return path.join(this.privateRoot, projectId);
  }

  /** Whether the Project's private repository currently exists on disk. */
  async hasRepository(projectId: string): Promise<boolean> {
    try {
      const stats = await lstat(path.join(this.repositoryPath(projectId), "objects"));
      return stats.isDirectory();
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  async ensureRepository(projectId: string, allowCreate: boolean): Promise<void> {
    await this.ensurePrivateRoot();
    const repository = this.repositoryPath(projectId);
    if (await this.hasRepository(projectId)) return;
    if (!allowCreate) {
      // A record that references a missing repository is corruption. An
      // empty replacement would make an old checkpoint look valid.
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_CORRUPT",
        "The Project checkpoint repository is missing",
      );
    }
    await mkdir(this.projectPrivateDirectory(projectId), { recursive: true, mode: 0o700 });
    await this.initializeRepository(repository);
  }

  async deleteRepository(projectId: string): Promise<void> {
    await rm(this.projectPrivateDirectory(projectId), { recursive: true, force: true });
  }

  /**
   * Capture the current eligible source of one Project as an immutable
   * commit under refs/lqam/checkpoints/<checkpointId>.
   *
   * The complete source set is enumerated and scanned before any object is
   * written, so a detected secret never becomes an unreachable blob either.
   */
  async capture(
    intent: {
      projectId: string;
      checkpointId: string;
      parentGitSha: string | null;
      createdAt: string;
    },
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<PhysicalCapture> {
    assertSafeIdentifier(intent.checkpointId);
    const workspacePath = await this.trustedWorkspacePath(intent.projectId);
    const repository = this.repositoryPath(intent.projectId);
    if (!(await this.hasRepository(intent.projectId))) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The Project checkpoint repository is missing");
    }

    // A ref that already exists for this intent is a completed capture whose
    // acknowledgement was lost. Reuse it rather than writing a second commit.
    const existing = await this.inspectIntentRef(intent.projectId, intent.checkpointId);
    const inventory = await this.enumerateSource(workspacePath, { scan: true, signal: options.signal });
    throwIfAborted(options.signal);
    const manifest = toValidatedManifest(inventory.files.map(stripContent));
    if (existing) {
      if (existing.manifestHash !== manifest.manifestHash) {
        throw new WorkspaceCheckpointError(
          "CHECKPOINT_CORRUPT",
          "A checkpoint ref already exists for this intent with different contents",
        );
      }
      return { ...existing, excludedFileCount: inventory.excludedFileCount };
    }

    await this.writeBlobs(repository, inventory.files);
    throwIfAborted(options.signal);
    const treeSha = await this.writeTree(intent.projectId, manifest.entries, options.signal);
    const commitSha = await this.commitTree(intent, treeSha, options.signal);
    await this.createRef(intent.projectId, intent.checkpointId, commitSha, options.signal);

    // Validate what Git recorded against what was approved before the caller
    // is allowed to persist a captured identity.
    const recorded = await this.readTreeManifest(intent.projectId, treeSha, options.signal);
    if (recorded.manifestHash !== manifest.manifestHash) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The recorded checkpoint tree does not match the approved source");
    }
    return {
      gitSha: commitSha,
      treeSha,
      manifestHash: manifest.manifestHash,
      fileCount: manifest.fileCount,
      byteCount: manifest.byteCount,
      excludedFileCount: inventory.excludedFileCount,
    };
  }

  /** Reconstruct captured physical metadata from a prewritten intent ref. */
  async inspectIntentRef(
    projectId: string,
    checkpointId: string,
  ): Promise<Omit<PhysicalCapture, "excludedFileCount"> | null> {
    assertSafeIdentifier(checkpointId);
    if (!(await this.hasRepository(projectId))) return null;
    const result = await this.runGit(projectId, ["rev-parse", "--verify", "--quiet", REF_PREFIX + checkpointId + "^{commit}"], {
      allowExit: [0, 1],
    });
    if (result.exitCode !== 0) return null;
    const gitSha = result.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/u.test(gitSha)) return null;
    const tree = await this.runGit(projectId, ["rev-parse", gitSha + "^{tree}"]);
    const treeSha = tree.stdout.toString("utf8").trim();
    const manifest = await this.readTreeManifest(projectId, treeSha);
    return {
      gitSha,
      treeSha,
      manifestHash: manifest.manifestHash,
      fileCount: manifest.fileCount,
      byteCount: manifest.byteCount,
    };
  }

  /**
   * Prove a checkpoint's commit, tree, and every blob still exist and still
   * describe the recorded manifest. Failure is corruption, never permission
   * to reinitialize.
   */
  async validate(
    checkpoint: { projectId: string; gitSha: string; treeSha: string; manifestHash: string },
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<ValidatedManifest> {
    if (!(await this.hasRepository(checkpoint.projectId))) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The Project checkpoint repository is missing");
    }
    const commit = await this.runGit(
      checkpoint.projectId,
      ["cat-file", "-e", checkpoint.gitSha + "^{commit}"],
      { allowExit: [0, 1, 128], signal: options.signal },
    );
    if (commit.exitCode !== 0) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The checkpoint commit is missing");
    }
    const tree = await this.runGit(checkpoint.projectId, ["rev-parse", checkpoint.gitSha + "^{tree}"], {
      signal: options.signal,
    });
    if (tree.stdout.toString("utf8").trim() !== checkpoint.treeSha) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The checkpoint commit does not reference its recorded tree");
    }
    const manifest = await this.readTreeManifest(checkpoint.projectId, checkpoint.treeSha, options.signal);
    if (manifest.manifestHash !== checkpoint.manifestHash) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The checkpoint tree no longer matches its recorded manifest");
    }
    for (const entry of manifest.entries) validateManifestEntry(this.policy, entry);
    await this.assertBlobsPresent(checkpoint.projectId, manifest.entries, options.signal);
    return manifest;
  }

  /** The eligible source currently on disk, without scanning or writing. */
  async currentManifest(projectId: string, signal?: AbortSignal): Promise<ValidatedManifest> {
    const workspacePath = await this.trustedWorkspacePath(projectId);
    const inventory = await this.enumerateSource(workspacePath, { scan: false, signal });
    return toValidatedManifest(inventory.files.map(stripContent));
  }

  /**
   * Compute the exact per-path actions that turn the current eligible source
   * into the target manifest, refusing before any mutation when an excluded
   * or unsafe path would have to be touched.
   */
  async prepareRestore(
    input: {
      projectId: string;
      targetCheckpointId: string;
      targetTreeSha: string;
      targetManifestHash: string;
      safetyCheckpointId: string | null;
      /**
       * Recorded source tree to plan from instead of the live directory. A
       * resumed apply plans from the safety checkpoint it was backed up to,
       * so the same plan and hash are reproduced regardless of how far the
       * interrupted apply got.
       */
      sourceTreeSha?: string | undefined;
    },
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<RestorePlan> {
    const workspacePath = await this.trustedWorkspacePath(input.projectId);
    const target = await this.readTreeManifest(input.projectId, input.targetTreeSha, options.signal);
    if (target.manifestHash !== input.targetManifestHash) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The restore target no longer matches its recorded manifest");
    }
    for (const entry of target.entries) validateManifestEntry(this.policy, entry);
    assertNoCaseCollisions(target.entries.map((entry) => entry.path));
    const current =
      input.sourceTreeSha === undefined
        ? await this.currentManifest(input.projectId, options.signal)
        : await this.readTreeManifest(input.projectId, input.sourceTreeSha, options.signal);
    const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
    const targetByPath = new Map(target.entries.map((entry) => [entry.path, entry]));
    const currentFolded = new Map(current.entries.map((entry) => [entry.path.toLowerCase(), entry.path]));

    const actions: RestoreAction[] = [];
    for (const entry of target.entries) {
      const existing = currentByPath.get(entry.path);
      const folded = currentFolded.get(entry.path.toLowerCase());
      if (folded !== undefined && folded !== entry.path) {
        throw restoreConflict();
      }
      await this.assertWritableTargetPath(workspacePath, entry.path);
      if (existing && existing.oid === entry.oid && existing.mode === entry.mode) continue;
      actions.push({ kind: "write", path: entry.path, mode: entry.mode, oid: entry.oid, size: entry.size });
    }
    for (const entry of current.entries) {
      if (!targetByPath.has(entry.path)) actions.push({ kind: "delete", path: entry.path });
    }
    const draft = {
      projectId: input.projectId,
      targetCheckpointId: input.targetCheckpointId,
      targetTreeSha: input.targetTreeSha,
      targetManifestHash: target.manifestHash,
      safetyCheckpointId: input.safetyCheckpointId,
      sourceManifestHash: current.manifestHash,
      actions,
    };
    return { ...draft, planHash: planHashOf(draft) };
  }

  /**
   * Apply a prepared plan. Not atomic across files; the caller keeps the
   * Project gated and only records `restored` after the manifest re-check.
   * Re-running the same plan is safe: every entry on disk must already match
   * either the source or the target side, and unknown edits are refused.
   */
  async applyRestore(
    plan: RestorePlan,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<ValidatedManifest> {
    if (planHashOf(plan) !== plan.planHash) {
      throw new WorkspaceCheckpointError("CHECKPOINT_RESTORE_FAILED", "The restore plan was altered");
    }
    const workspacePath = await this.trustedWorkspacePath(plan.projectId);
    const target = await this.readTreeManifest(plan.projectId, plan.targetTreeSha, options.signal);
    if (target.manifestHash !== plan.targetManifestHash) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The restore target changed after the plan was prepared");
    }
    const live = await this.currentManifest(plan.projectId, options.signal);
    if (live.manifestHash !== plan.sourceManifestHash && live.manifestHash !== plan.targetManifestHash) {
      // A partially applied plan is a mixture of source and target entries.
      // Anything matching neither side is an edit nobody planned for.
      const targetByPath = new Map(target.entries.map((entry) => [entry.path, entry]));
      const plannedWrites = new Map(
        plan.actions.filter((action): action is Extract<RestoreAction, { kind: "write" }> => action.kind === "write")
          .map((action) => [action.path, action]),
      );
      const plannedDeletes = new Set(
        plan.actions.filter((action) => action.kind === "delete").map((action) => action.path),
      );
      for (const entry of live.entries) {
        const targetEntry = targetByPath.get(entry.path);
        const matchesTarget = targetEntry !== undefined && targetEntry.oid === entry.oid;
        const isPlannedDelete = plannedDeletes.has(entry.path);
        const isPlannedWrite = plannedWrites.has(entry.path);
        if (matchesTarget) continue;
        if (isPlannedDelete || isPlannedWrite) continue;
        throw restoreConflict();
      }
    }

    const blobs = await this.readBlobs(
      plan.projectId,
      plan.actions.filter((action): action is Extract<RestoreAction, { kind: "write" }> => action.kind === "write"),
      options.signal,
    );
    throwIfAborted(options.signal);
    const touchedDirectories = new Set<string>();
    for (const action of plan.actions) {
      throwIfAborted(options.signal);
      const absolute = path.join(workspacePath, ...action.path.split("/"));
      if (action.kind === "write") {
        const content = blobs.get(action.oid);
        if (!content) throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A target blob is missing");
        await this.assertWritableTargetPath(workspacePath, action.path);
        await mkdir(path.dirname(absolute), { recursive: true });
        await this.writeAtomically(absolute, content, action.mode);
      } else {
        let stats;
        try {
          stats = await lstat(absolute);
        } catch (error) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
        // Only a regular eligible file is ever removed; a symlink or a
        // directory that appeared at that path is refused, never cleaned.
        if (!stats.isFile()) throw restoreConflict();
        await unlink(absolute);
        touchedDirectories.add(path.dirname(absolute));
      }
    }
    await this.pruneEmptyDirectories(workspacePath, touchedDirectories);

    const verified = await this.currentManifest(plan.projectId, options.signal);
    if (verified.manifestHash !== plan.targetManifestHash) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_RESTORE_FAILED",
        "The restored source does not match the target checkpoint",
      );
    }
    return verified;
  }

  // ------------------------------------------------------------ internals

  private async ensurePrivateRoot(): Promise<void> {
    await mkdir(this.privateRoot, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.privateRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new WorkspaceCheckpointError("CHECKPOINT_UNAVAILABLE", "The checkpoint storage root is not a private directory");
    }
    await mkdir(this.hooksDirectory(), { recursive: true, mode: 0o700 });
    const config = this.emptyConfigPath();
    try {
      await lstat(config);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      await writeFile(config, "", { mode: 0o600 });
    }
  }

  private emptyConfigPath(): string {
    return path.join(this.privateRoot, "gitconfig.empty");
  }

  private hooksDirectory(): string {
    return path.join(this.privateRoot, "hooks.empty");
  }

  private async initializeRepository(repository: string): Promise<void> {
    await mkdir(repository, { recursive: true, mode: 0o700 });
    const result = await this.git.run(
      ["init", "--bare", "--quiet", "--object-format=sha1", "--template=" + this.hooksDirectory(), repository],
      { cwd: this.privateRoot, env: this.baseEnvironment(), timeoutMs: CHECKPOINT_LIMITS.gitCommandTimeoutMs },
    );
    if (result.exitCode !== 0) {
      throw new WorkspaceCheckpointError("CHECKPOINT_UNAVAILABLE", "The checkpoint repository could not be initialized");
    }
  }

  /**
   * Derive and verify the workspace path. The root must be a real directory:
   * a symlinked root could redirect a restore outside the Project.
   */
  private async trustedWorkspacePath(projectId: string): Promise<string> {
    const workspacePath = path.resolve(this.workspacePathFor(projectId));
    let stats;
    try {
      stats = await lstat(workspacePath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new WorkspaceCheckpointError("CHECKPOINT_CAPTURE_FAILED", "The Project workspace directory is missing");
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "The Project workspace root is not a plain directory");
    }
    const privateRootPrefix = this.privateRoot + path.sep;
    if (workspacePath === this.privateRoot || workspacePath.startsWith(privateRootPrefix)) {
      throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "The Project workspace overlaps the private checkpoint root");
    }
    return workspacePath;
  }

  private baseEnvironment(): NodeJS.ProcessEnv {
    const configuration: [string, string][] = [
      ["core.autocrlf", "false"],
      ["core.safecrlf", "false"],
      ["core.symlinks", "false"],
      ["core.fsmonitor", "false"],
      // Windows Git refuses object and index paths beyond MAX_PATH unless
      // told otherwise; the private root can sit under a deep data directory.
      ["core.longpaths", "true"],
      ["core.hooksPath", this.hooksDirectory()],
      ["commit.gpgsign", "false"],
      ["gc.auto", "0"],
      ["protocol.allow", "never"],
    ];
    const env: NodeJS.ProcessEnv = {
      HOME: this.privateRoot,
      USERPROFILE: this.privateRoot,
      XDG_CONFIG_HOME: this.privateRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: this.emptyConfigPath(),
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CEILING_DIRECTORIES: this.privateRoot,
      GIT_AUTHOR_NAME: "LQAM Checkpoints",
      GIT_AUTHOR_EMAIL: "checkpoints@lqam.invalid",
      GIT_COMMITTER_NAME: "LQAM Checkpoints",
      GIT_COMMITTER_EMAIL: "checkpoints@lqam.invalid",
      GIT_CONFIG_COUNT: String(configuration.length),
      LANG: "C",
      LC_ALL: "C",
    };
    configuration.forEach(([key, value], index) => {
      env["GIT_CONFIG_KEY_" + String(index)] = key;
      env["GIT_CONFIG_VALUE_" + String(index)] = value;
    });
    // Only what the executable needs to run; no provider credentials, no
    // inherited GIT_* variables, no repository discovery hints.
    for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "COMSPEC", "PATHEXT", "WINDIR"]) {
      const value = process.env[name];
      if (value !== undefined && env[name] === undefined) env[name] = value;
    }
    return env;
  }

  private repositoryEnvironment(projectId: string, indexFile?: string): NodeJS.ProcessEnv {
    return {
      ...this.baseEnvironment(),
      GIT_DIR: this.repositoryPath(projectId),
      ...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }),
    };
  }

  private async runGit(
    projectId: string,
    args: readonly string[],
    options: {
      input?: Buffer | undefined;
      allowExit?: readonly number[] | undefined;
      indexFile?: string | undefined;
      maxOutputBytes?: number | undefined;
      signal?: AbortSignal | undefined;
      failureCode?: WorkspaceCheckpointErrorCode | undefined;
      timeoutMs?: number | undefined;
    } = {},
  ): Promise<GitCommandResult> {
    let result: GitCommandResult;
    try {
      result = await this.git.run(args, {
        cwd: this.projectPrivateDirectory(projectId),
        env: this.repositoryEnvironment(projectId, options.indexFile),
        input: options.input,
        timeoutMs: options.timeoutMs ?? CHECKPOINT_LIMITS.gitCommandTimeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof GitSpawnError) {
        if (error.kind === "missing") {
          throw new WorkspaceCheckpointError("CHECKPOINT_UNAVAILABLE", "The Git executable is not available");
        }
        if (error.kind === "aborted") throw abortError();
        throw new WorkspaceCheckpointError(
          options.failureCode ?? "CHECKPOINT_CAPTURE_FAILED",
          error.kind === "timeout" ? "A checkpoint Git command timed out" : "A checkpoint Git command could not start",
          { cause: error },
        );
      }
      throw error;
    }
    const allowed = options.allowExit ?? [0];
    if (!allowed.includes(result.exitCode)) {
      // The public message stays fixed; the cause carries Git's own diagnostic
      // (exit code plus bounded stderr) for the server log only. Plumbing
      // stderr names files and paths, never workspace content or credentials.
      throw new WorkspaceCheckpointError(
        options.failureCode ?? "CHECKPOINT_CAPTURE_FAILED",
        "A checkpoint Git command failed",
        {
          cause: new Error(
            "git " + String(args[0] ?? "") + " exited " + String(result.exitCode) + ": " +
              result.stderr.toString("utf8").replace(/\s+/gu, " ").trim().slice(0, 512),
          ),
        },
      );
    }
    return result;
  }

  /**
   * Walk the workspace with lstat, never following links, skipping denied
   * directories whole, and reading each eligible file once. When `scan` is
   * set the bytes must pass the content policy before they are retained.
   */
  private async enumerateSource(
    workspacePath: string,
    options: { scan: boolean; signal?: AbortSignal | undefined },
  ): Promise<SourceInventory> {
    const files: SourceFile[] = [];
    let excludedFileCount = 0;
    let totalBytes = 0;
    const secrets = options.scan ? this.configuredSecrets() : [];
    const walk = async (relative: string): Promise<void> => {
      throwIfAborted(options.signal);
      const absolute = relative === "" ? workspacePath : path.join(workspacePath, ...relative.split("/"));
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const dirent of entries) {
        const name = dirent.name;
        if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
          excludedFileCount += 1;
          continue;
        }
        const childRelative = relative === "" ? name : relative + "/" + name;
        if (dirent.isSymbolicLink()) {
          excludedFileCount += 1;
          continue;
        }
        if (dirent.isDirectory()) {
          if (!safeClassify(this.policy, childRelative, "directory")) continue;
          await walk(childRelative);
          continue;
        }
        if (!dirent.isFile()) {
          excludedFileCount += 1;
          continue;
        }
        if (!safeClassify(this.policy, childRelative, "file")) {
          excludedFileCount += 1;
          continue;
        }
        const childAbsolute = path.join(absolute, name);
        const before = await lstat(childAbsolute);
        if (!before.isFile() || before.nlink > 1) {
          excludedFileCount += 1;
          continue;
        }
        if (before.size > CHECKPOINT_LIMITS.maxFileBytes) {
          throw new WorkspaceCheckpointError("CHECKPOINT_LIMIT_EXCEEDED", "An eligible file exceeds the per-file limit");
        }
        const content = await readFile(childAbsolute);
        const after = await lstat(childAbsolute);
        if (
          !after.isFile() ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          content.length !== before.size
        ) {
          throw new WorkspaceCheckpointError(
            "CHECKPOINT_CAPTURE_FAILED",
            "A workspace file changed while it was being captured",
          );
        }
        if (options.scan) {
          if (!this.policy.scanContent(childRelative, content, secrets)) {
            excludedFileCount += 1;
            continue;
          }
        }
        files.push({
          path: childRelative,
          mode: executableMode(before.mode),
          oid: gitBlobOid(content),
          size: content.length,
          content,
        });
        totalBytes += content.length;
        if (files.length > CHECKPOINT_LIMITS.maxFiles) {
          throw new WorkspaceCheckpointError("CHECKPOINT_LIMIT_EXCEEDED", "The workspace has more eligible files than one checkpoint permits");
        }
        if (totalBytes > CHECKPOINT_LIMITS.maxTotalBytes) {
          throw new WorkspaceCheckpointError("CHECKPOINT_LIMIT_EXCEEDED", "The eligible source exceeds the total checkpoint size limit");
        }
      }
    };
    await walk("");
    assertNoCaseCollisions(files.map((file) => file.path));
    return { files, excludedFileCount };
  }

  /**
   * Store approved bytes as loose blob objects: zlib("blob <size>\0" + bytes)
   * at objects/xx/yyyy. This is exactly what `git hash-object -w --no-filters`
   * produces, without one subprocess per file; Git reads and validates the
   * result through the plumbing commands that follow.
   */
  private async writeBlobs(repository: string, files: readonly SourceFile[]): Promise<void> {
    const objects = path.join(repository, "objects");
    for (const file of files) {
      const directory = path.join(objects, file.oid.slice(0, 2));
      const destination = path.join(directory, file.oid.slice(2));
      try {
        await lstat(destination);
        continue;
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
      await mkdir(directory, { recursive: true });
      const header = Buffer.from("blob " + String(file.content.length) + "\0", "utf8");
      const compressed = deflateSync(Buffer.concat([header, file.content]));
      const temporary = destination + ".tmp-" + randomBytes(4).toString("hex");
      await writeFile(temporary, compressed, { mode: 0o444 });
      try {
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        // Another capture may have written the same object first.
        try {
          await lstat(destination);
        } catch {
          throw error;
        }
      }
    }
  }

  private async writeTree(
    projectId: string,
    entries: readonly ManifestEntry[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const indexFile = path.join(this.projectPrivateDirectory(projectId), "index-" + randomBytes(6).toString("hex"));
    try {
      await this.runGit(projectId, ["read-tree", "--empty"], { indexFile, signal });
      const input = Buffer.from(
        entries.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join(""),
        "utf8",
      );
      await this.runGit(projectId, ["update-index", "-z", "--index-info"], { indexFile, input, signal });
      const tree = await this.runGit(projectId, ["write-tree", "--missing-ok"], { indexFile, signal });
      const treeSha = tree.stdout.toString("utf8").trim();
      if (!/^[0-9a-f]{40}$/u.test(treeSha)) {
        throw new WorkspaceCheckpointError("CHECKPOINT_CAPTURE_FAILED", "Git did not return a tree identity");
      }
      return treeSha;
    } finally {
      await rm(indexFile, { force: true }).catch(() => undefined);
      await rm(indexFile + ".lock", { force: true }).catch(() => undefined);
    }
  }

  private async commitTree(
    intent: { projectId: string; checkpointId: string; parentGitSha: string | null; createdAt: string },
    treeSha: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (intent.parentGitSha !== null && !/^[0-9a-f]{40}$/u.test(intent.parentGitSha)) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The parent checkpoint identity is invalid");
    }
    const args = ["commit-tree", treeSha];
    if (intent.parentGitSha !== null) args.push("-p", intent.parentGitSha);
    args.push("-F", "-");
    const message = Buffer.from(
      "LQAM workspace checkpoint " + intent.checkpointId + "\n\nPolicy: " + this.policy.version + "\n",
      "utf8",
    );
    const timestamp = Number.isFinite(Date.parse(intent.createdAt))
      ? new Date(intent.createdAt).toISOString()
      : new Date().toISOString();
    const result = await this.git.run(args, {
      cwd: this.projectPrivateDirectory(intent.projectId),
      env: {
        ...this.repositoryEnvironment(intent.projectId),
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      },
      input: message,
      timeoutMs: CHECKPOINT_LIMITS.gitCommandTimeoutMs,
      signal,
    }).catch((error: unknown) => {
      if (error instanceof GitSpawnError && error.kind === "aborted") throw abortError();
      throw new WorkspaceCheckpointError("CHECKPOINT_CAPTURE_FAILED", "The checkpoint commit could not be written", { cause: error });
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CAPTURE_FAILED", "The checkpoint commit could not be written");
    }
    const commitSha = result.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CAPTURE_FAILED", "Git did not return a commit identity");
    }
    return commitSha;
  }

  private async createRef(
    projectId: string,
    checkpointId: string,
    commitSha: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const result = await this.runGit(
      projectId,
      ["update-ref", REF_PREFIX + checkpointId, commitSha, NULL_SHA],
      { allowExit: [0, 1, 128], signal },
    );
    if (result.exitCode === 0) return;
    // The ref already exists: it is only acceptable when it names this commit.
    const existing = await this.inspectIntentRef(projectId, checkpointId);
    if (existing?.gitSha === commitSha) return;
    throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A different checkpoint ref already exists for this intent");
  }

  private async readTreeManifest(
    projectId: string,
    treeSha: string,
    signal?: AbortSignal,
  ): Promise<ValidatedManifest> {
    if (!/^[0-9a-f]{40}$/u.test(treeSha)) {
      throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The checkpoint tree identity is invalid");
    }
    const result = await this.runGit(projectId, ["ls-tree", "-r", "-z", "--long", treeSha], {
      signal,
      failureCode: "CHECKPOINT_CORRUPT",
      maxOutputBytes: 64 * 1024 * 1024,
    });
    const entries: ManifestEntry[] = [];
    for (const record of result.stdout.toString("utf8").split("\0")) {
      if (record.length === 0) continue;
      const tab = record.indexOf("\t");
      if (tab === -1) throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The checkpoint tree listing is malformed");
      const [mode, type, oid, sizeText] = record.slice(0, tab).trim().split(/\s+/u);
      const filePath = record.slice(tab + 1);
      if (type !== "blob" || (mode !== "100644" && mode !== "100755") || oid === undefined) {
        throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The checkpoint tree contains an unsupported entry");
      }
      const size = Number(sizeText);
      if (!Number.isInteger(size) || size < 0) {
        throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "The checkpoint tree listing is malformed");
      }
      entries.push({ path: filePath, mode, oid, size });
    }
    return toValidatedManifest(entries);
  }

  private async assertBlobsPresent(
    projectId: string,
    entries: readonly ManifestEntry[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (entries.length === 0) return;
    const input = Buffer.from(entries.map((entry) => entry.oid + "\n").join(""), "utf8");
    const result = await this.runGit(projectId, ["cat-file", "--batch-check"], {
      input,
      signal,
      failureCode: "CHECKPOINT_CORRUPT",
      maxOutputBytes: 64 * 1024 * 1024,
    });
    const lines = result.stdout.toString("utf8").split("\n").filter((line) => line.length > 0);
    const sizes = new Map(entries.map((entry) => [entry.oid, entry.size]));
    for (const line of lines) {
      const [oid, type, sizeText] = line.trim().split(/\s+/u);
      if (oid === undefined || type !== "blob" || Number(sizeText) !== sizes.get(oid)) {
        throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A checkpoint blob is missing or damaged");
      }
    }
  }

  /** Materialize target blobs in memory through one batched cat-file call. */
  private async readBlobs(
    projectId: string,
    writes: readonly Extract<RestoreAction, { kind: "write" }>[],
    signal: AbortSignal | undefined,
  ): Promise<Map<string, Buffer>> {
    const blobs = new Map<string, Buffer>();
    const unique = [...new Set(writes.map((action) => action.oid))];
    if (unique.length === 0) return blobs;
    const totalBytes = writes.reduce((total, action) => total + action.size, 0);
    if (totalBytes > CHECKPOINT_LIMITS.maxTotalBytes) {
      throw new WorkspaceCheckpointError("CHECKPOINT_LIMIT_EXCEEDED", "The restore target exceeds the checkpoint size limit");
    }
    const result = await this.runGit(projectId, ["cat-file", "--batch"], {
      input: Buffer.from(unique.map((oid) => oid + "\n").join(""), "utf8"),
      signal,
      failureCode: "CHECKPOINT_CORRUPT",
      maxOutputBytes: CHECKPOINT_LIMITS.maxTotalBytes + 4 * 1024 * 1024,
      timeoutMs: CHECKPOINT_LIMITS.operationTimeoutMs,
    });
    let offset = 0;
    const output = result.stdout;
    while (offset < output.length) {
      const newline = output.indexOf(0x0a, offset);
      if (newline === -1) break;
      const header = output.subarray(offset, newline).toString("utf8").trim().split(/\s+/u);
      offset = newline + 1;
      const [oid, type, sizeText] = header;
      if (oid === undefined || type === "missing") {
        throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A target blob is missing");
      }
      const size = Number(sizeText);
      if (type !== "blob" || !Number.isInteger(size) || size < 0 || offset + size > output.length) {
        throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A target blob is malformed");
      }
      const content = Buffer.from(output.subarray(offset, offset + size));
      offset += size + 1;
      if (gitBlobOid(content) !== oid) {
        throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A target blob does not match its identity");
      }
      // The policy is applied again on the way out: a blob that today's rules
      // would refuse to capture is never written back under the old identity.
      const writeFor = writes.find((action) => action.oid === oid);
      if (writeFor && !this.policy.scanContent(writeFor.path, content, this.configuredSecrets())) {
        throw new WorkspaceCheckpointError("CHECKPOINT_POLICY_MISMATCH", "A target file is no longer permitted by the source policy");
      }
      blobs.set(oid, content);
    }
    for (const oid of unique) {
      if (!blobs.has(oid)) throw new WorkspaceCheckpointError("CHECKPOINT_CORRUPT", "A target blob is missing");
    }
    return blobs;
  }

  /** Every ancestor must be a real directory or absent; the leaf must not be a directory. */
  private async assertWritableTargetPath(workspacePath: string, relativePath: string): Promise<void> {
    const components = relativePath.split("/");
    let current = workspacePath;
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
      }
      const isLeaf = index === components.length - 1;
      if (stats.isSymbolicLink()) throw restoreConflict();
      if (isLeaf ? stats.isDirectory() : !stats.isDirectory()) throw restoreConflict();
    }
  }

  private async writeAtomically(absolute: string, content: Buffer, mode: ManifestEntry["mode"]): Promise<void> {
    const temporary = path.join(
      path.dirname(absolute),
      RESTORE_TEMP_PREFIX + randomBytes(6).toString("hex"),
    );
    await writeFile(temporary, content, { mode: mode === "100755" ? 0o755 : 0o644 });
    try {
      await rename(temporary, absolute);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    if (process.platform !== "win32") {
      await chmod(absolute, mode === "100755" ? 0o755 : 0o644);
    }
  }

  private async pruneEmptyDirectories(workspacePath: string, directories: Set<string>): Promise<void> {
    const root = path.resolve(workspacePath);
    const candidates = [...directories].sort((left, right) => right.length - left.length);
    for (const start of candidates) {
      let current = path.resolve(start);
      while (current !== root && current.startsWith(root + path.sep)) {
        let entries;
        try {
          entries = await readdir(current);
        } catch {
          break;
        }
        if (entries.length > 0) break;
        try {
          await rmdir(current);
        } catch {
          break;
        }
        current = path.dirname(current);
      }
    }
  }
}

function stripContent(file: SourceFile): ManifestEntry {
  return { path: file.path, mode: file.mode, oid: file.oid, size: file.size };
}

function safeClassify(policy: CheckpointPolicy, relativePath: string, kind: "file" | "directory"): boolean {
  try {
    return policy.classifyPath(relativePath, kind).eligible;
  } catch {
    // An unrepresentable name is excluded, never a capture failure.
    return false;
  }
}

function executableMode(mode: number): ManifestEntry["mode"] {
  if (process.platform === "win32") return "100644";
  return (mode & 0o111) !== 0 ? "100755" : "100644";
}

function assertSafeIdentifier(value: string): void {
  if (!CHECKPOINT_ID_PATTERN.test(value)) {
    throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "An identifier is not safe for private storage paths");
  }
}

function restoreConflict(): WorkspaceCheckpointError {
  return new WorkspaceCheckpointError(
    "CHECKPOINT_RESTORE_CONFLICT",
    "An excluded or unsafe path prevents an exact source restore",
  );
}

function abortError(): Error {
  const error = new Error("Checkpoint operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

export { REF_PREFIX as CHECKPOINT_REF_PREFIX };
