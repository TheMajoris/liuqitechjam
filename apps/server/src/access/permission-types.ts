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
  | "tool.execute:web.search"
  | "tool.execute:project.preview.inspect"
  | "tool.execute:project.preview.restart";
