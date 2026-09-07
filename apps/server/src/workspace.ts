import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillRuntimeContext } from "./skills/skill-types.js";
import type { Agent } from "./types.js";
import { PLATFORM_RUNTIME_CONTEXT_REFERENCE } from "./preview/preview-context-provider.js";

/** Bump when the platform-owned instruction layout changes. */
export const PLATFORM_INSTRUCTIONS_VERSION = 2;
export const PLATFORM_INSTRUCTIONS_MARKER =
  `<!-- lqam:platform-instructions:v${PLATFORM_INSTRUCTIONS_VERSION} -->`;

const PLATFORM_INSTRUCTIONS_HEADER = "# Platform-managed Agent instructions";
const LEGACY_PLATFORM_INSTRUCTION_FOOTERS = [
  "This file is regenerated when the Agent configuration is updated.",
  "This file is regenerated for whichever Agent is currently working.",
] as const;

/**
 * Recognizes only files produced by the platform instruction writers.
 *
 * The marker handles the current format. The footer checks are the bounded
 * compatibility path for pre-marker files so migration never sweeps an
 * arbitrary user-authored AGENTS.md.
 */
export function isPlatformManagedInstructions(content: string): boolean {
  const firstLine = content.split(/\r?\n/u, 1)[0];
  return (
    firstLine === PLATFORM_INSTRUCTIONS_HEADER &&
    (content.includes(PLATFORM_INSTRUCTIONS_MARKER) ||
      LEGACY_PLATFORM_INSTRUCTION_FOOTERS.some((footer) => content.includes(footer)))
  );
}

export function hasCurrentPlatformInstructions(content: string): boolean {
  return (
    content.split(/\r?\n/u, 1)[0] === PLATFORM_INSTRUCTIONS_HEADER &&
    content.includes(PLATFORM_INSTRUCTIONS_MARKER)
  );
}

export type InstructionRefreshResult =
  | "created"
  | "updated"
  | "current"
  | "skipped"
  | "workspace_missing";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent, skillContext?: SkillRuntimeContext): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent, skillContext);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  /**
   * Writes only the stable Agent/workspace contract. Skill bodies and
   * capability state are mutable run-time facts and are delivered once by
   * AgentRuntimePromptComposer instead of being copied into AGENTS.md.
   *
   * `skillContext` remains accepted for source compatibility with lifecycle
   * callers; it is intentionally ignored by this canonical writer.
   */
  async writeInstructions(agent: Agent, _skillContext?: SkillRuntimeContext): Promise<void> {
    const content = [
      PLATFORM_INSTRUCTIONS_HEADER,
      PLATFORM_INSTRUCTIONS_MARKER,
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Runtime context",
      "",
      PLATFORM_RUNTIME_CONTEXT_REFERENCE,
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  /**
   * Refreshes a known Agent workspace when its platform-owned instructions
   * predate the current layout. Arbitrary AGENTS.md files are left untouched.
   * A missing AGENTS.md is created only when the known workspace directory is
   * present; a removed workspace remains the existing execution-time error.
   */
  async refreshInstructions(
    agent: Agent,
    _skillContext?: SkillRuntimeContext,
  ): Promise<InstructionRefreshResult> {
    const instructionsPath = path.join(agent.workspacePath, "AGENTS.md");
    let existing: string;
    try {
      existing = await readFile(instructionsPath, "utf8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await lstat(agent.workspacePath);
      } catch (workspaceError) {
        if (isErrno(workspaceError, "ENOENT")) return "workspace_missing";
        throw workspaceError;
      }
      await this.writeInstructions(agent);
      return "created";
    }
    if (hasCurrentPlatformInstructions(existing)) return "current";
    if (!isPlatformManagedInstructions(existing)) return "skipped";
    await this.writeInstructions(agent);
    return "updated";
  }

  async archive(agent: Agent): Promise<string | null> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    try {
      await rename(agent.workspacePath, destination);
    } catch (error) {
      // A persisted Agent can outlive its local workspace if the directory was
      // removed externally. Treat only that source-side ENOENT as an already
      // archived result; preserve EACCES and every other filesystem failure.
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await lstat(agent.workspacePath);
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
  async restore(agent: Agent, archivedWorkspace: string): Promise<void> {
    await rename(archivedWorkspace, agent.workspacePath);
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
