import { z } from "zod";
import type { PermissionId } from "../access/permission-types.js";

export type AgentRoleSource = "system" | "user";

/**
 * Reusable Agent role template. A role is a preset of explicit permissions,
 * platform tool IDs, and declarative skill IDs; none of those fields are
 * interpreted from the role name.
 */
export interface AgentRole {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  toolIds: string[];
  permissionIds: PermissionId[];
  source: AgentRoleSource;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRoleView extends AgentRole {
  assignedAgentCount: number;
  assignedProjectCount: number;
}

export interface CreateRoleInput {
  name: string;
  description?: string | undefined;
  skillIds?: readonly string[] | undefined;
  toolIds?: readonly string[] | undefined;
  permissionIds?: readonly (PermissionId | string)[] | undefined;
}

export interface UpdateRoleInput {
  name?: string | undefined;
  description?: string | undefined;
  skillIds?: readonly string[] | undefined;
  toolIds?: readonly string[] | undefined;
  permissionIds?: readonly (PermissionId | string)[] | undefined;
  /** Required when edits propagate to existing Project assignments. */
  confirmPropagation?: boolean | undefined;
}

export interface ProjectRoleAssignmentView {
  projectId: string;
  agentId: string;
  roleId: string;
  role: AgentRoleView;
}

export const AgentRoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  skillIds: z.array(z.string()),
  toolIds: z.array(z.string()),
  permissionIds: z.array(z.string()),
  source: z.enum(["system", "user"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ROLE_LIMITS = {
  maxNameLength: 80,
  maxDescriptionLength: 500,
  maxSkills: 32,
  maxTools: 64,
  maxPermissions: 64,
} as const;

/** Stable IDs used when migrating the old owner/editor/viewer attachments. */
export const LEGACY_ROLE_IDS = {
  owner: "legacy-owner",
  editor: "legacy-editor",
  viewer: "legacy-viewer",
} as const;

export type LegacyRoleName = keyof typeof LEGACY_ROLE_IDS;
