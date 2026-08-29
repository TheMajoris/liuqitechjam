/**
 * Preview permissions are intentionally repository-owned rather than tied to
 * an Agent role. Wave 8 can replace the default policy without changing the
 * PreviewService boundary.
 */
export type PermissionId =
  | "preview.inspect"
  | "preview.start"
  | "preview.restart"
  | "preview.stop"
  | "preview.logs";

