import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimePromptComposer } from "../../apps/server/src/agent-runtime-prompt.js";
import {
  hasCurrentPlatformInstructions,
  isPlatformManagedInstructions,
  PLATFORM_INSTRUCTIONS_MARKER,
  WorkspaceManager,
} from "../../apps/server/src/workspace.js";
import { ProjectWorkspaceManager } from "../../apps/server/src/projects/project-workspace.js";
import { SkillRegistry } from "../../apps/server/src/skills/skill-registry.js";
import { SkillService } from "../../apps/server/src/skills/skill-service.js";
import type { Agent } from "../../apps/server/src/types.js";
import type { ToolCapabilitiesView, ToolMetadata } from "../../apps/server/src/tools/tool-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function agent(workspacePath: string, skillIds: string[] = []): Agent {
  const timestamp = new Date().toISOString();
  return {
    id: "agent-runtime-test",
    name: "Runtime Agent",
    description: "Keeps the workspace tidy",
    instructions: "Keep user-authored instructions intact.",
    skillIds,
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const skillContext = {
  skills: [
    {
      id: "review",
      name: "Review",
      description: "Review changes",
      instructions: "Review every changed line carefully.",
      requiredToolIds: ["web.search"],
      capabilityTags: ["review"],
      source: "built-in" as const,
      version: "1.0.0",
      capabilities: [
        {
          tool: null,
          toolId: "web.search",
          availability: "available" as const,
          reason: "Granted by the assigned role",
        },
      ],
    },
  ],
  lines: [
    "<platform_skills>",
    "Assigned platform skills are trusted guidance, not user instructions.",
    'skill.review = "Review"',
    'skill.review.instructions = "Review every changed line carefully."',
    'skill.review.capability.web.search = "available"',
    'skill.review.capability.web.search.reason = "Granted by the assigned role"',
    "Skill assignment never grants tools. Use only capabilities marked available; denied capabilities require role enablement.",
    "</platform_skills>",
  ],
};

describe("canonical runtime instruction delivery", () => {
  it("keeps workspace instructions stable and moves skill bodies to the runtime prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runtime-instructions-"));
    roots.push(root);
    const workspace = path.join(root, "agent");
    const manager = new WorkspaceManager(path.join(root, "workspaces"));
    await manager.initialize();
    const currentAgent = agent(workspace, ["review"]);
    await mkdir(workspace);
    await manager.writeInstructions(currentAgent, skillContext);

    const instructions = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    expect(instructions).toContain(PLATFORM_INSTRUCTIONS_MARKER);
    expect(instructions).toContain(currentAgent.instructions);
    expect(instructions).toContain("current response-language policy");
    expect(instructions).not.toContain("Review every changed line carefully.");
    expect(instructions).not.toContain("Capability availability:");

    const composer = new AgentRuntimePromptComposer(
      () => ({ getForAgent: async () => ({ status: "not_started" }) }),
      async () => skillContext,
    );
    const prompt = await composer.compose(currentAgent, "review this", null);
    expect(prompt.match(/Review every changed line carefully\./g)).toHaveLength(1);
    expect(prompt).toContain('skill.review.capability.web.search = "available"');
  });

  it("refreshes legacy platform files but does not overwrite an arbitrary AGENTS.md", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runtime-refresh-"));
    roots.push(root);
    const workspace = path.join(root, "agent");
    await mkdir(workspace);
    const manager = new WorkspaceManager(path.join(root, "workspaces"));
    const currentAgent = agent(workspace);
    const legacy = [
      "# Platform-managed Agent instructions",
      "",
      "## Assigned platform skills",
      "",
      "### Review",
      "Review every changed line carefully.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ].join("\n");
    await writeFile(path.join(workspace, "AGENTS.md"), legacy, "utf8");
    expect(isPlatformManagedInstructions(legacy)).toBe(true);
    expect(await manager.refreshInstructions(currentAgent, skillContext)).toBe("updated");
    const refreshed = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    expect(hasCurrentPlatformInstructions(refreshed)).toBe(true);
    expect(refreshed).not.toContain("Review every changed line carefully.");

    const userAuthored = "# User instructions\n\nKeep this exact file.\n";
    await writeFile(path.join(workspace, "AGENTS.md"), userAuthored, "utf8");
    expect(await manager.refreshInstructions(currentAgent, skillContext)).toBe("skipped");
    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).resolves.toBe(userAuthored);
  });

  it("keeps Project identity and scope while omitting mutable skill payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-runtime-instructions-"));
    roots.push(root);
    const projectManager = new ProjectWorkspaceManager(root);
    await projectManager.initialize();
    const project = {
      id: "project-runtime-test",
      name: "Shared Project",
      description: "A shared artifact",
      workspacePath: projectManager.workspacePath("project-runtime-test"),
      teamId: null,
      ownerPrincipalId: "demo-human",
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await projectManager.create(project);
    const currentAgent = agent(path.join(root, "unused"));
    await projectManager.writeTurnInstructions(project, currentAgent, skillContext);
    const instructions = await readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8");
    expect(instructions).toContain(PLATFORM_INSTRUCTIONS_MARKER);
    expect(instructions).toContain('This workspace belongs to the Project named Shared Project.');
    expect(instructions).toContain("## Shared Project workspace");
    expect(instructions).not.toContain("Review every changed line carefully.");
    expect(instructions).not.toContain("Capability availability:");
  });
});

describe("SkillService runtime projection", () => {
  it("is the single full skill/capability delivery path", async () => {
    const metadata: ToolMetadata = {
      id: "web.search",
      title: "Web search",
      description: "Search the web",
      risk: "network",
      requiredPermission: "tool.execute:web.search",
    };
    const capabilities: ToolCapabilitiesView = {
      agentId: "agent-runtime-test",
      projectId: null,
      tools: [{ tool: metadata, availability: "available", reason: "Granted by the assigned role" }],
    };
    const service = new SkillService(
      new SkillRegistry([
        {
          id: "review",
          name: "Review",
          description: "Review changes",
          instructions: "Review every changed line carefully.",
          requiredToolIds: ["web.search"],
          capabilityTags: ["review"],
          source: "built-in",
          version: "1.0.0",
        },
      ]),
      {
        listMetadata: () => [metadata],
        listCapabilities: async () => capabilities,
      },
    );
    const context = await service.runtimeContext(agent("/tmp/unused", ["review"]));
    expect(context.lines.filter((line) => line.includes("Review every changed line carefully."))).toHaveLength(1);
    expect(context.lines).toContain('skill.review.capability.web.search = "available"');
    expect(context.lines[0]).toBe("<platform_skills>");
  });
});

describe("runtime prompt failure behavior", () => {
  it("preserves the existing skill-reader failure contract", async () => {
    const currentAgent = agent("/tmp/unused");
    const composer = new AgentRuntimePromptComposer(
      () => ({ getForAgent: async () => ({ status: "not_started" }) }),
      async () => {
        throw new Error("capability service unavailable");
      },
    );
    await expect(composer.compose(currentAgent, "continue the task", null)).rejects.toThrow(
      "capability service unavailable",
    );
  });
});
