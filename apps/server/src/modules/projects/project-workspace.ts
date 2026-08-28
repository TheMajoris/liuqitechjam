import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Owns the on-disk shared working directory for a Project. Workspaces are
 * created, contained, and archived by the Project — never by an assigned Agent.
 */
export class ProjectWorkspaceManager {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".archived"), { recursive: true });
  }

  /** Absolute path of a Project's shared workspace. */
  workspacePath(projectId: string): string {
    return path.join(this.root, projectId);
  }

  /**
   * Resolve `relativePath` inside a Project workspace, rejecting any value that
   * escapes it (`..`, absolute paths, symlink-style tricks in the literal path).
   */
  resolveWithin(projectId: string, relativePath: string): string {
    const base = this.workspacePath(projectId);
    const resolved = path.resolve(base, relativePath);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(
        `Path ${JSON.stringify(relativePath)} escapes the project workspace`,
      );
    }
    return resolved;
  }

  async create(projectId: string, projectName: string): Promise<string> {
    const workspacePath = this.workspacePath(projectId);
    await mkdir(workspacePath, { recursive: false });
    await writeFile(
      path.join(workspacePath, "README.md"),
      [
        "# " + projectName + " - shared project workspace",
        "",
        "Files produced by the Planner -> Builder -> Reviewer pipeline live here.",
        "Only the Builder role may write to this directory.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspacePath, ".gitignore"),
      ["node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    return workspacePath;
  }

  async archive(projectId: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".archived",
      projectId + "-" + timestamp,
    );
    await rename(this.workspacePath(projectId), destination);
    return destination;
  }
}
