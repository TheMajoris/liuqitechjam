import { describe, expect, it } from "vitest";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("passes the resolved worker model for new and resumed sessions", () => {
    const request = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      prompt: "continue",
      threadId: "thread-123",
      model: {
        providerId: "volcengine_ark",
        modelId: "ep-worker-b",
        codexModel: "ep-worker-b",
        usesDefaultModel: false,
      },
    };
    const args = buildCodexArgs(request, "workspace-write");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("ep-worker-b");
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
  });

  it("leaves the configured default model in CODEX_HOME for legacy/default runs", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "use the default",
        threadId: null,
        model: {
          providerId: "volcengine_ark",
          modelId: "ep-default",
          codexModel: "ep-default",
          usesDefaultModel: true,
        },
      },
      "workspace-write",
    );
    expect(args).not.toContain("--model");
  });

  it("binds a per-run MCP URL and env-var name without putting the bearer token in argv", () => {
    const token = "opaque-run-token";
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "use the available tools",
        threadId: null,
        mcp: { url: "http://127.0.0.1:3000/mcp", token },
      },
      "workspace-write",
    );

    expect(args).toContain("mcp_servers.launchpad.url=\"http://127.0.0.1:3000/mcp\"");
    expect(args).toContain(
      'mcp_servers.launchpad.bearer_token_env_var="LAUNCHPAD_MCP_BEARER_TOKEN"',
    );
    expect(args).not.toContain(token);
    expect(args.join(" ")).not.toContain(token);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});
