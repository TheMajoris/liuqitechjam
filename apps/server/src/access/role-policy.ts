import type { PermissionId } from "./permission-types.js";
import type { ProjectRole } from "./access-types.js";

export const PROJECT_ROLE_PERMISSIONS: Readonly<Record<ProjectRole, readonly PermissionId[]>> = {
  owner: [
    "project.read",
    "project.write",
    "project.manage",
    "project.members.manage",
    "agent.invoke",
    "project.preview.inspect",
    "project.preview.logs",
    "project.preview.start",
    "project.preview.restart",
    "project.preview.stop",
  ],
  editor: [
    "project.read",
    "project.write",
    "agent.invoke",
    "project.preview.inspect",
    "project.preview.logs",
  ],
  viewer: [
    "project.read",
    "project.preview.inspect",
    "project.preview.logs",
  ],
};

export function roleAllows(role: ProjectRole, permission: PermissionId): boolean {
  // PreviewService uses explicit project.preview.* permissions. Keep the
  // generic preview IDs useful for callers that already carry a Project
  // resource in their authorization request.
  const permissions = PROJECT_ROLE_PERMISSIONS[role];
  if (!permissions) return false;
  if (permission === "preview.inspect") return permissions.includes("project.preview.inspect");
  if (permission === "preview.logs") return permissions.includes("project.preview.logs");
  if (permission === "preview.start") return permissions.includes("project.preview.start");
  if (permission === "preview.restart") return permissions.includes("project.preview.restart");
  if (permission === "preview.stop") return permissions.includes("project.preview.stop");
  // Tool permissions are distinct identifiers at the registry boundary but
  // inherit only the corresponding repository-owned role policy. ToolService
  // applies the separate explicit Agent–Project grant/approval gate after
  // this role check succeeds.
  if (permission === "tool.execute:web.search") return permissions.includes("project.read");
  if (permission === "tool.execute:project.preview.inspect") {
    return permissions.includes("project.preview.inspect");
  }
  if (permission === "tool.execute:project.preview.restart") {
    return permissions.includes("project.preview.restart");
  }
  return permissions.includes(permission);
}
