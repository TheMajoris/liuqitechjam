import { describe, expect, it } from "vitest";
import { createApp } from "../../../apps/server/src/app.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import type { AgentService } from "../../../apps/server/src/agent-service.js";
import type { AgentAppearance } from "../../../apps/server/src/types.js";

function appWithService(seen: AgentAppearance[]) {
  const service = {
    listAgents: () => [],
    systemInfo: async () => ({}),
    updateAgentAppearance: async (id: string, appearance: AgentAppearance) => {
      seen.push(appearance);
      return { id, appearance };
    },
  } as unknown as AgentService;
  return createApp(loadConfig({ NODE_ENV: "test" }), service);
}

const AGENT_ID = "8f1d2c34-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

describe("PATCH /api/agents/:id/appearance", () => {
  it("accepts a partial cosmetic change", async () => {
    const seen: AgentAppearance[] = [];
    const app = await appWithService(seen);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${AGENT_ID}/appearance`,
      payload: { accessory: "headset" },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([{ accessory: "headset" }]);
    await app.close();
  });

  it("rejects values the renderer cannot draw", async () => {
    const seen: AgentAppearance[] = [];
    const app = await appWithService(seen);
    for (const payload of [
      { accessory: "crown" },
      { hue: 999 },
      { hair: 42 },
      { skin: -1 },
      // An unknown field is a client bug, not something to silently ignore.
      { wings: true },
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/agents/${AGENT_ID}/appearance`,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(seen).toEqual([]);
    await app.close();
  });
});
