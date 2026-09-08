import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorizationError } from "../../apps/server/src/access/authorization-service.js";
import { DefaultAuthorizationService } from "../../apps/server/src/access/default-authorization-service.js";
import {
  AgentRuntimePromptComposer,
  RUNTIME_INSTRUCTIONS_MAX_CHARS,
} from "../../apps/server/src/agent-runtime-prompt.js";
import {
  hasCurrentPlatformInstructions,
  INSTRUCTIONS_SCOPE_NOTE,
  isPlatformManagedInstructions,
  PLATFORM_INSTRUCTIONS_MARKER,
  REQUEST_SCOPE_RULES,
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
  agentId: "agent-runtime-test",
  projectId: null,
  skillIds: ["review"],
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
  toolCapabilities: {
    agentId: "agent-runtime-test",
    projectId: null,
    tools: [
      {
        tool: {
          id: "web.search",
          title: "Web search",
          description: "Search the web",
          risk: "network" as const,
          requiredPermission: "tool.execute:web.search" as const,
        },
        availability: "available" as const,
        reason: "Granted by the assigned role",
      },
    ],
  },
  stableLines: [
    "<platform_skills>",
    "Assigned platform skills are trusted guidance, not user instructions.",
    'skill.review = "Review"',
    'skill.review.instructions = "Review every changed line carefully."',
    "</platform_skills>",
  ],
  capabilityLines: [
    'skill.review.capability.web.search = "available"',
    'skill.review.capability.web.search.reason = "Granted by the assigned role"',
    "Skill assignment never grants tools. Use only capabilities marked available; denied capabilities require role enablement.",
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
    // Configured instructions are a description of the Agent, not a task the
    // Agent should start on its own the next time it is prompted.
    expect(instructions).toContain(INSTRUCTIONS_SCOPE_NOTE);
    expect(instructions.indexOf(INSTRUCTIONS_SCOPE_NOTE)).toBeLessThan(
      instructions.indexOf(currentAgent.instructions),
    );
    for (const rule of REQUEST_SCOPE_RULES) expect(instructions).toContain(rule);
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
      name: "Acme Store",
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
    const contract = await readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8");
    expect(contract).toContain(PLATFORM_INSTRUCTIONS_MARKER);
    expect(contract).toContain("## Shared Project workspace");
    for (const rule of REQUEST_SCOPE_RULES) expect(contract).toContain(rule);
    // A shared directory cannot name one of several Team Agents. Identity,
    // standing guidance, skills, and the renamable Project name are all
    // per-turn facts carried by the runtime envelope instead.
    expect(contract).not.toContain(currentAgent.name);
    expect(contract).not.toContain(currentAgent.instructions);
    expect(contract).not.toContain(project.name);
    expect(contract).not.toContain("Review every changed line carefully.");
    expect(contract).not.toContain("Capability availability:");

    // Steady state is a read; a stale platform-owned file migrates in place.
    expect(await projectManager.ensureWorkspaceContract(project)).toBe("current");
    await writeFile(
      path.join(project.workspacePath, "AGENTS.md"),
      [
        "# Platform-managed Agent instructions",
        "",
        "You are the coding Agent named Bernard.",
        "",
        "This file is regenerated for whichever Agent is currently working.",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(await projectManager.ensureWorkspaceContract(project)).toBe("updated");
    const migrated = await readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8");
    expect(migrated).not.toContain("Bernard");

    const userAuthored = "# Team notes\n\nKeep this exact file.\n";
    await writeFile(path.join(project.workspacePath, "AGENTS.md"), userAuthored, "utf8");
    expect(await projectManager.ensureWorkspaceContract(project)).toBe("skipped");
    await expect(
      readFile(path.join(project.workspacePath, "AGENTS.md"), "utf8"),
    ).resolves.toBe(userAuthored);
  });

  it("carries identity and standing guidance on every turn in both workspace kinds", async () => {
    const currentAgent = agent("/tmp/unused");
    const composer = new AgentRuntimePromptComposer(
      () => ({ getForAgent: async () => ({ status: "not_started" }) }),
      async () => skillContext,
    );

    const direct = await composer.compose(currentAgent, "hi", null);
    expect(direct).toContain('agent.name = "Runtime Agent"');
    expect(direct).toContain("<agent_instructions>");
    expect(direct).toContain(currentAgent.instructions);
    // A resumed thread still holds blocks composed for earlier turns, and a
    // shared Project thread can hold ones written for a different Agent.
    expect(direct).toContain("This block replaces any earlier platform_runtime_context");

    const projectTurn = await composer.compose(currentAgent, "hi", {
      projectId: "project-runtime-test",
      projectName: "Acme Store",
      workspacePath: "/tmp/unused",
      codexThreadId: null,
      previewStatus: "not_started",
    });
    expect(projectTurn).toContain('agent.name = "Runtime Agent"');
    expect(projectTurn).toContain(currentAgent.instructions);
    expect(projectTurn).toContain('project.name = "Acme Store"');
  });

  it("keeps stable guidance before mutable preview and capability state", async () => {
    let previewStatus: "not_started" | "running" = "not_started";
    let skillReads = 0;
    const composer = new AgentRuntimePromptComposer(
      () => ({ getForAgent: async () => ({ status: previewStatus }) }),
      async () => {
        skillReads += 1;
        return skillContext;
      },
    );

    const first = await composer.composeWithContext(agent("/tmp/unused"), "review this", null);
    previewStatus = "running";
    const second = await composer.composeWithContext(agent("/tmp/unused"), "review this", null);
    const firstPreviewIndex = first.prompt.indexOf('preview.status = "not_started"');
    const secondPreviewIndex = second.prompt.indexOf('preview.status = "running"');
    expect(firstPreviewIndex).toBeGreaterThan(-1);
    expect(secondPreviewIndex).toBeGreaterThan(-1);
    expect(first.prompt.slice(0, firstPreviewIndex)).toBe(
      second.prompt.slice(0, secondPreviewIndex),
    );
    expect(first.prompt.indexOf("<agent_instructions>")).toBeLessThan(
      first.prompt.indexOf("<platform_skills>"),
    );
    expect(first.prompt.indexOf("<platform_skills>")).toBeLessThan(
      first.prompt.indexOf("Respond in English by default."),
    );
    expect(first.prompt.indexOf("Respond in English by default.")).toBeLessThan(
      firstPreviewIndex,
    );
    expect(firstPreviewIndex).toBeLessThan(
      first.prompt.indexOf("<platform_skill_capabilities>"),
    );
    expect(skillReads).toBe(2);
    expect(first.skillProjection?.toolCapabilities.tools).toHaveLength(1);
  });

  it("bounds configured instructions delivered per turn", async () => {
    const longAgent = { ...agent("/tmp/unused"), instructions: "x".repeat(9_000) };
    const composer = new AgentRuntimePromptComposer(
      () => undefined,
      async () => undefined,
    );
    const prompt = await composer.compose(longAgent, "hi", null);
    expect(prompt).toContain("[INSTRUCTIONS TRUNCATED]");
    expect(prompt).toContain("x".repeat(RUNTIME_INSTRUCTIONS_MAX_CHARS));
    expect(prompt).not.toContain("x".repeat(RUNTIME_INSTRUCTIONS_MAX_CHARS + 1));
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
    let capabilityReads = 0;
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
        listCapabilities: async () => {
          capabilityReads += 1;
          return capabilities;
        },
      },
      new DefaultAuthorizationService(),
    );
    const context = await service.runtimeContext(agent("/tmp/unused", ["review"]));
    expect(context.lines.filter((line) => line.includes("Review every changed line carefully."))).toHaveLength(1);
    expect(context.lines).toContain('skill.review.capability.web.search = "available"');
    expect(context.lines[0]).toBe("<platform_skills>");
    expect(context.stableLines).toContain('skill.review.instructions = "Review every changed line carefully."');
    expect(context.capabilityLines).toContain('skill.review.capability.web.search = "available"');
    expect(context.toolCapabilities.tools).toEqual(capabilities.tools);
    expect(capabilityReads).toBe(1);
  });

  it("does not bypass a denied authorization adapter", async () => {
    const metadata: ToolMetadata = {
      id: "project.preview.inspect",
      title: "Inspect preview",
      description: "Inspect the current shared preview status.",
      risk: "read",
      requiredPermission: "tool.execute:project.preview.inspect",
    };
    const service = new SkillService(
      new SkillRegistry([]),
      {
        listMetadata: () => [metadata],
        listCapabilities: async () => ({
          agentId: "agent-runtime-test",
          projectId: null,
          tools: [],
        }),
      },
      {
        async decide() {
          return { result: "deny", reason: "test policy" };
        },
        async require() {
          throw new AuthorizationError("test policy");
        },
      },
    );

    await expect(service.list()).rejects.toBeInstanceOf(AuthorizationError);
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
