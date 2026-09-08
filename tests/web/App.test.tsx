import { describe, expect, it } from "vitest";
import { loadActiveProjects } from "../../apps/web/src/App";
import type { Project } from "../../apps/web/src/types";

function project(id: string, status: Project["status"] = "active"): Project {
  return {
    id,
    name: "Workspace " + id,
    description: "",
    teamId: null,
    agentIds: [],
    status,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

describe("workspace list refresh", () => {
  it("retains the previous list on failure but clears it for a successful empty response", async () => {
    const existing = project("existing");
    let visible = [existing];
    let error: string | null = null;
    const setProjects = (next: Project[]) => {
      visible = next;
    };
    const setError = (message: string) => {
      error = message;
    };
    const failure = new Error("Workspace service unavailable");

    await expect(
      loadActiveProjects(
        async () => {
          throw failure;
        },
        setProjects,
        setError,
      ),
    ).rejects.toBe(failure);
    expect(visible).toEqual([existing]);
    expect(error).toBe(failure.message);

    await expect(
      loadActiveProjects(async () => ({ projects: [] }), setProjects, setError),
    ).resolves.toEqual([]);
    expect(visible).toEqual([]);
  });
});
