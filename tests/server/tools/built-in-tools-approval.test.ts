import { describe, expect, it } from "vitest";
import { createBuiltInToolDefinitions } from "../../../apps/server/src/tools/built-in-tools.js";
import { WEB_SEARCH_TOOL_APPROVAL_POLICY_VERSION } from "../../../apps/server/src/tools/tool-types.js";

describe("built-in tool approval policy", () => {
  it("requires a fresh Project-owner approval for Agent web.search calls", () => {
    const definitions = createBuiltInToolDefinitions({
      search: { search: async () => [] },
      fetch: {
        fetch: async () => ({
          url: "https://example.com",
          finalUrl: "https://example.com",
          status: 200,
          contentType: "text/plain",
          content: "",
        }),
      },
      preview: {
        get: async () => ({} as never),
        restart: async () => ({} as never),
      },
    });

    const search = definitions.find((definition) => definition.id === "web.search");
    const restart = definitions.find((definition) => definition.id === "project.preview.restart");
    expect(search?.approvalPolicy).toEqual({
      mode: "required",
      version: WEB_SEARCH_TOOL_APPROVAL_POLICY_VERSION,
      decisionAuthority: {
        kind: "project-owner",
        permission: "tool.execute:web.search",
      },
    });
    // Existing preview behavior remains approval-required under its original
    // policy version and owner permission.
    expect(restart?.approvalPolicy).toEqual({
      mode: "required",
      version: "tool-approval-v1",
      decisionAuthority: {
        kind: "project-owner",
        permission: "project.preview.restart",
      },
    });
  });
});
