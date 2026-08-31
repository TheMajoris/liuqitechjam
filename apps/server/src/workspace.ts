import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillRuntimeContext } from "./skills/skill-types.js";
import type { Agent } from "./types.js";

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

  async writeInstructions(agent: Agent, skillContext?: SkillRuntimeContext): Promise<void> {
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
      ...skillInstructionLines(skillContext),
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

function skillInstructionLines(context: SkillRuntimeContext | undefined): string[] {
  if (!context || context.skills.length === 0) return [];
  const lines = ["", "## Assigned platform skills", ""];
  for (const skill of context.skills) {
    lines.push("### " + skill.name);
    lines.push(skill.instructions);
    if (skill.capabilities.length > 0) {
      lines.push("");
      lines.push("Capability availability:");
      for (const capability of skill.capabilities) {
        lines.push(
          "- " +
            capability.toolId +
            ": " +
            capability.availability.replaceAll("_", " ") +
            " (" +
            capability.reason +
            ")",
        );
      }
    }
    lines.push("");
  }
  lines.push("Skill assignment never grants tools; use only capabilities marked available.");
  return lines;
}
