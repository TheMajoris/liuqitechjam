import { readFile } from "node:fs/promises";
import path from "node:path";
import { PreviewError } from "./preview-errors.js";
import type { PreviewErrorCode } from "./preview-types.js";

export type PreviewCommandKind = "vite" | "next" | "node";

export interface ResolvedPreviewCommand {
  /** argv only; no shell command is accepted by PreviewRuntime. */
  command: string[];
  containerPort: number;
  kind: PreviewCommandKind;
}

export interface PreviewCommandResolver {
  resolve(input: { workspacePath: string }): Promise<ResolvedPreviewCommand>;
}

type PackageJson = {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

function resolutionError(code: PreviewErrorCode, message: string): PreviewError {
  return new PreviewError(code, code === "PREVIEW_COMMAND_NOT_FOUND" ? 422 : 422, message);
}

function dependencyPresent(packageJson: PackageJson, name: string): boolean {
  const dependencies = packageJson.dependencies ?? {};
  const devDependencies = packageJson.devDependencies ?? {};
  return Object.prototype.hasOwnProperty.call(dependencies, name) ||
    Object.prototype.hasOwnProperty.call(devDependencies, name);
}

function scriptContainsBinary(script: string, binary: string): boolean {
  // This is only used for detection. The script itself is never interpolated
  // into a shell command; npm executes the trusted workspace script.
  return new RegExp("(?:^|[\\s;&|])" + binary.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "(?:$|[\\s])").test(
    script,
  );
}

function readScript(packageJson: PackageJson, name: string): string | null {
  const script = packageJson.scripts?.[name];
  return typeof script === "string" && script.trim().length > 0 ? script.trim() : null;
}

/**
 * Resolve only the small, known-good demo stack supported by Wave 7. A
 * package's script is treated as workspace artifact data, while the runtime
 * receives a fixed npm argv shape instead of an arbitrary command string.
 */
export class PackageJsonPreviewCommandResolver implements PreviewCommandResolver {
  async resolve(input: { workspacePath: string }): Promise<ResolvedPreviewCommand> {
    if (!path.isAbsolute(input.workspacePath) || input.workspacePath.includes("\0")) {
      throw new PreviewError(
        "PREVIEW_WORKSPACE_INVALID",
        422,
        "The Agent workspace path is invalid",
      );
    }

    let raw: string;
    try {
      raw = await readFile(path.join(input.workspacePath, "package.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw resolutionError(
          "PREVIEW_COMMAND_NOT_FOUND",
          "No package.json preview configuration was found in the Agent workspace",
        );
      }
      throw resolutionError(
        "PREVIEW_UNSUPPORTED_PROJECT",
        "The Agent workspace package.json could not be read",
      );
    }

    let packageJson: PackageJson;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("package.json must contain an object");
      }
      packageJson = parsed as PackageJson;
    } catch {
      throw resolutionError(
        "PREVIEW_UNSUPPORTED_PROJECT",
        "The Agent workspace package.json is invalid",
      );
    }

    const dev = readScript(packageJson, "dev");
    if (dev && (dependencyPresent(packageJson, "vite") || scriptContainsBinary(dev, "vite"))) {
      return {
        command: ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
        containerPort: 5173,
        kind: "vite",
      };
    }

    if (dev && (dependencyPresent(packageJson, "next") || scriptContainsBinary(dev, "next"))) {
      return {
        command: ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"],
        containerPort: 3000,
        kind: "next",
      };
    }

    const start = readScript(packageJson, "start");
    if (start && dependencyPresent(packageJson, "express") && /^node(?:\s|$)/.test(start)) {
      return {
        command: ["npm", "run", "start"],
        containerPort: 3000,
        kind: "node",
      };
    }

    throw resolutionError(
      "PREVIEW_UNSUPPORTED_PROJECT",
      "This workspace does not contain a supported Vite, Next.js, or Express preview script",
    );
  }
}

export const PreviewCommandResolver = PackageJsonPreviewCommandResolver;

