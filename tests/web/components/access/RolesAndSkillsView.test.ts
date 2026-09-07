import { describe, expect, it } from "vitest";
import {
  BASE_PERMISSIONS,
  isRoleDraftDirty,
} from "../../../../apps/web/src/components/access/RolesAndSkillsView";

const baseline = {
  name: "Workspace editor",
  description: "Can edit shared files.",
  toolIds: ["web.search"],
  skillIds: ["skill-1"],
  permissionIds: ["project.read", "project.write", "agent.invoke"],
};

describe("RolesAndSkillsView role editor", () => {
  it("shows friendly Workspace labels alongside exact permission IDs", () => {
    expect(BASE_PERMISSIONS).toEqual(
      expect.arrayContaining([
        ["project.write", "Edit workspace files", expect.any(String)],
        ["agent.invoke", "Allow Agent runs", expect.any(String)],
      ]),
    );
  });

  it("marks meaningful draft changes while ignoring list order and trim-only edits", () => {
    expect(isRoleDraftDirty({ ...baseline }, { ...baseline })).toBe(false);
    expect(
      isRoleDraftDirty(
        { ...baseline, name: "  Workspace editor  ", permissionIds: [...baseline.permissionIds].reverse() },
        baseline,
      ),
    ).toBe(false);
    expect(
      isRoleDraftDirty(
        { ...baseline, permissionIds: [...baseline.permissionIds, "project.preview.inspect"] },
        baseline,
      ),
    ).toBe(true);
  });
});
