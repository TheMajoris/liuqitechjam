import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "../types.js";
import type { Project } from "./project-types.js";

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
        "The platform regenerates AGENTS.md for whichever Agent is currently working.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  /**
   * Rewrites AGENTS.md for the Agent about to take a Project turn.
   *
   * A directory holds exactly one AGENTS.md, and it is the only channel that
   * carries Agent instructions into the Codex worker. Rewriting it per turn is
   * what preserves separate Agent identities on one shared artifact. The write
   * lease serializes Project turns, so this can never race another turn.
   */
  async writeTurnInstructions(project: Project, agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Shared Project workspace",
      "",
      "- This workspace belongs to the Project named " + project.name + ".",
      "- Other Agents on this Team edit these same files between your turns.",
      "- Read the current files before changing them; do not assume you wrote them.",
      "- Refer to files by Project-relative paths such as src/App.tsx.",
      "- Never ask another Agent for a host filesystem path, and never print one.",
      "- Preserve existing work and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated for whichever Agent is currently working.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(project.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(project: Project): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(this.root, ".archived", project.id + "-" + timestamp);
    await rename(project.workspacePath, destination);
    return destination;
  }
}
