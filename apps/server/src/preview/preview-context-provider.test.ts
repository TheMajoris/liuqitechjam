import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import {
  StorePreviewContextProvider,
  composeRuntimeContextPrompt,
} from "./preview-context-provider.js";
import type { PreviewRecord, PreviewStatus } from "./preview-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "preview-context-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

function previewRecord(
  agentId: string,
  status: PreviewStatus,
  updatedAt: string,
): PreviewRecord {
  return {
    id: "preview-" + updatedAt,
    agentId,
    status,
    workspacePath: "/workspaces/" + agentId,
    runtimeId: status === "running" ? "runtime-1" : null,
    host: "127.0.0.1",
    hostPort: status === "running" ? 41_231 : null,
    containerPort: status === "running" ? 3000 : null,
    command: ["npm", "run", "dev"],
    url: status === "running" ? "http://127.0.0.1:41231" : null,
    errorCode: null,
    errorMessage: null,
    createdAt: updatedAt,
    startedAt: status === "running" ? updatedAt : null,
    stoppedAt: null,
    updatedAt,
  };
}

describe("StorePreviewContextProvider", () => {
  it("reports not_started when the Agent never launched a Preview", async () => {
    const store = await makeStore();
    const provider = new StorePreviewContextProvider(store);

    await expect(provider.getForAgent("agent-1")).resolves.toEqual({ status: "not_started" });
  });

  it("reports the running status of the latest Preview record", async () => {
    const store = await makeStore();
    await store.mutate((database) => {
      database.previews.push(previewRecord("agent-1", "stopped", "2026-01-01T00:00:00.000Z"));
      database.previews.push(previewRecord("agent-1", "running", "2026-01-02T00:00:00.000Z"));
    });
    const provider = new StorePreviewContextProvider(store);

    await expect(provider.getForAgent("agent-1")).resolves.toEqual({ status: "running" });
  });

  it("reports a stopped Preview and never leaks another Agent's state", async () => {
    const store = await makeStore();
    await store.mutate((database) => {
      database.previews.push(previewRecord("agent-1", "stopped", "2026-01-02T00:00:00.000Z"));
      database.previews.push(previewRecord("agent-2", "running", "2026-01-03T00:00:00.000Z"));
    });
    const provider = new StorePreviewContextProvider(store);

    await expect(provider.getForAgent("agent-1")).resolves.toEqual({ status: "stopped" });
  });
});

describe("composeRuntimeContextPrompt", () => {
  it("wraps the prompt without altering it", () => {
    const composed = composeRuntimeContextPrompt("Make the Add button larger.", {
      status: "running",
    });

    expect(composed).toContain('preview.status = "running"');
    expect(composed).toContain("<user_request>\nMake the Add button larger.\n</user_request>");
  });

  it("carries only the status field, never runtime topology", () => {
    const composed = composeRuntimeContextPrompt("hello", { status: "running" });

    expect(composed).not.toMatch(/127\.0\.0\.1|runtime-|hostPort|workspacePath/);
  });
});
