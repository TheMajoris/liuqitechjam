import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project } from "./project-types.js";
import {
  hasCurrentPlatformInstructions,
  isPlatformManagedInstructions,
  PLATFORM_INSTRUCTIONS_HEADER,
  PLATFORM_INSTRUCTIONS_MARKER,
  REQUEST_SCOPE_RULES,
  type InstructionRefreshResult,
} from "../workspace.js";
import { PLATFORM_RUNTIME_CONTEXT_REFERENCE } from "../preview/preview-context-provider.js";

/**
 * Owns the physical layout of shared Project workspaces.
 *
 * The path is always derived from the Project ID here, never accepted from a
 * client, so a persisted record can never redirect a container mount.
 */
export class ProjectWorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(projectId: string): string {
    return path.join(this.root, projectId, "workspace");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".archived"), { recursive: true });
  }

  async create(project: Project): Promise<void> {
    await mkdir(project.workspacePath, { recursive: true });
    await writeFile(
      path.join(project.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(project.workspacePath, "README.md"),
      [
        "# " + project.name,
        "",
        project.description || "A shared Project workspace.",
        "",
        "Every Agent on the attached Team edits these same files.",
        "AGENTS.md holds the shared workspace contract; each Agent's own instructions arrive with its request.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(project.workspacePath, "AGENTS.md"),
      this.contractContent(),
      "utf8",
    );
  }

  /**
   * The shared workspace contract: everything true for every Agent, forever.
   *
   * A directory holds exactly one AGENTS.md, so it can never describe which of
   * several Team Agents is acting. Identity and standing guidance are per-turn
   * facts delivered by AgentRuntimePromptComposer instead. Nothing mutable
   * belongs here either — the Project name is renamable, so it stays in the
   * runtime context and this file never needs refreshing for it.
   */
  private contractContent(): string {
    return [
      // Unchanged header and marker: they are how the platform recognizes a
      // file it owns, and the migration guard depends on both.
      PLATFORM_INSTRUCTIONS_HEADER,
      PLATFORM_INSTRUCTIONS_MARKER,
      "",
      "## Shared Project workspace",
      "",
      ...REQUEST_SCOPE_RULES,
      "- This is a shared Project workspace. Other Agents on this Team edit these same files between your turns.",
      "- Read the current files before changing them; do not assume you wrote them.",
      "- Refer to files by Project-relative paths such as src/App.tsx.",
      "- Never ask another Agent for a host filesystem path, and never print one.",
      "- Preserve existing work and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "## Your instructions",
      "",
      "You are not named in this file: it is shared by every Agent on the Team.",
      PLATFORM_RUNTIME_CONTEXT_REFERENCE,
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
  }

  /**
   * Brings the contract file to the current layout before a turn runs.
   *
   * Callers hold the Project write lease, so this cannot race another turn.
   * It is a read on the steady path and writes only for a missing or outdated
   * platform-owned file, which is also how a Project created before this
   * layout sheds the last acting Agent's identity. A user-authored AGENTS.md
   * is never swept.
   */
  async ensureWorkspaceContract(project: Project): Promise<InstructionRefreshResult> {
    const contractPath = path.join(project.workspacePath, "AGENTS.md");
    let existing: string;
    try {
      existing = await readFile(contractPath, "utf8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await lstat(project.workspacePath);
      } catch (workspaceError) {
        if (isErrno(workspaceError, "ENOENT")) return "workspace_missing";
        throw workspaceError;
      }
      await writeFile(contractPath, this.contractContent(), "utf8");
      return "created";
    }
    if (hasCurrentPlatformInstructions(existing)) return "current";
    if (!isPlatformManagedInstructions(existing)) return "skipped";
    await writeFile(contractPath, this.contractContent(), "utf8");
    return "updated";
  }

  async archive(project: Project): Promise<string | null> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(this.root, ".archived", project.id + "-" + timestamp);
    try {
      await rename(project.workspacePath, destination);
    } catch (error) {
      // A database Project can outlive its checkout if the workspace was
      // removed externally. Treat only that source-side ENOENT as an
      // already-archived result; preserve EACCES and every other filesystem
      // failure for the caller.
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await lstat(project.workspacePath);
      } catch (sourceError) {
        if (isErrno(sourceError, "ENOENT")) return null;
        throw sourceError;
      }
      // The source still exists, so ENOENT came from the destination side (or
      // another rename condition) and must not be swallowed.
      throw error;
    }
    return destination;
  }

  /** Restore an archive when a subsequent privileged reconciliation fails. */
  async restore(project: Project, archivedWorkspace: string): Promise<void> {
    await rename(archivedWorkspace, project.workspacePath);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
