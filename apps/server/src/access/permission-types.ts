/**
 * Permissions are intentionally repository-owned rather than tied to an Agent
 * role. Wave 8 can replace the default policy without changing the service
 * boundaries that enforce them.
 */
export type PermissionId =
  | "agent.invoke"
  | "project.manage"
  | "project.members.manage"
  | "preview.inspect"
  | "preview.start"
  | "preview.restart"
  | "preview.stop"
  | "preview.logs"
  | "project.read"
  | "project.write"
  | "project.preview.inspect"
  | "project.preview.start"
  | "project.preview.restart"
  | "project.preview.stop"
  | "project.preview.logs"
  | "skill.read"
  | "skill.assign"
  | "skill.search"
  | "skill.install"
  | "skill.remove"
  | "role.read"
  | "role.manage"
  | "tool.execute:web.search"
  | "tool.execute:web.fetch"
  | "tool.execute:project.preview.inspect"
  | "tool.execute:project.preview.restart";

/** Backend-supported permission identifiers exposed to role editors. */
export const SUPPORTED_PERMISSION_IDS: readonly PermissionId[] = [
  "agent.invoke",
  "project.manage",
  "project.members.manage",
  "preview.inspect",
  "preview.start",
  "preview.restart",
  "preview.stop",
  "preview.logs",
  "project.read",
  "project.write",
  "project.preview.inspect",
  "project.preview.start",
  "project.preview.restart",
  "project.preview.stop",
  "project.preview.logs",
  "skill.read",
  "skill.assign",
  "skill.search",
  "skill.install",
  "skill.remove",
  "role.read",
  "role.manage",
  "tool.execute:web.search",
  "tool.execute:web.fetch",
  "tool.execute:project.preview.inspect",
  "tool.execute:project.preview.restart",
];
