import { z } from "zod";
import type { ProjectRole } from "../access/access-types.js";

export type ProjectStatus = "active" | "archived";
export type { ProjectRole } from "../access/access-types.js";
export const ProjectRoleSchema = z.enum(["owner", "editor", "viewer"]);

/**
 * A Project owns the shared collaborative workspace that a Team's Agents edit.
 *
 * Agents keep their own identity, model assignment, and private workspace.
 * The Project only owns the artifact they collaborate on.
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  /** Backend-derived. Never accepted from a client. */
  workspacePath: string;
  /**
   * Legacy first-conversation pointer. Conversation cardinality comes from
   * orchestration records whose `projectId` references this Project.
   */
  teamId: string | null;
  /** Principal ID of the human owner; absent only on pre-Wave 8 records. */
  ownerPrincipalId?: string;
  status: ProjectStatus;
  /**
   * Incremented by every verified source restore. Queued work and thread
   * writes that carry an older epoch are rejected. Absent means zero.
   */
  workspaceEpoch?: number;
  /** Last verified source boundary; not a live cleanliness guarantee. */
  currentCheckpointId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Attachment of one Agent to one Project.
 *
 * `codexThreadId` is scoped to this pair on purpose: an Agent's private
 * Playground thread must never be resumed against the shared Project
 * filesystem, and vice versa. Each scope keeps its own continuity.
 */
export interface ProjectAgentAttachment {
  projectId: string;
  agentId: string;
  codexThreadId: string | null;
  /**
   * Resumable thread for the orchestration named by `orchestrationThreadScope`.
   *
   * The pair's direct thread stays in `codexThreadId` and is never reused for
   * orchestration work. Codex re-sends a whole thread as each resuming turn's
   * prompt, so a single shared slot would let one orchestration's history be
   * inherited — and paid for — by every task that followed it.
   */
  orchestrationThreadId?: string | null;
  /** The orchestration `orchestrationThreadId` belongs to. */
  orchestrationThreadScope?: string | null;
  attachedAt: string;
  /** Missing legacy roles are normalized to `editor`. */
  role?: ProjectRole;
  /**
   * Legacy per-Workspace role-template override. The feature was removed: an
   * Agent's role now applies in every Workspace. The field is kept only so a
   * stored value can be recognized and deleted at boot; nothing writes it.
   */
  roleId?: string;
  /** Reserved for later capability grants; never inferred from a role. */
  toolGrants?: string[];
  updatedAt?: string;
}

/**
 * Single-writer coordination record.
 *
 * At most one mutable Project turn runs at a time. The lease is persisted so
 * a server restart can reconcile it; frontend state is never authoritative.
 */
export interface ProjectWriteLease {
  projectId: string;
  runId: string;
  agentId: string;
  acquiredAt: string;
  /** Set for leases taken inside a checkpoint-enabled cycle reservation. */
  workspaceOperationId?: string;
  workspaceEpoch?: number;
}

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  workspacePath: z.string().min(1),
  teamId: z.string().nullable(),
  ownerPrincipalId: z.string().min(1).optional(),
  status: z.enum(["active", "archived"]),
  workspaceEpoch: z.number().int().nonnegative().optional(),
  currentCheckpointId: z.string().min(1).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ProjectAgentAttachmentSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  codexThreadId: z.string().nullable(),
  orchestrationThreadId: z.string().nullable().optional(),
  orchestrationThreadScope: z.string().nullable().optional(),
  attachedAt: z.string(),
  role: ProjectRoleSchema.optional(),
  // `roleId` was a per-Workspace role-template override. It is no longer
  // written; stored values are dropped at boot. Parsing stays permissive so an
  // older database still loads.
  roleId: z.string().min(1).optional(),
  toolGrants: z.array(z.string()).optional(),
  updatedAt: z.string().optional(),
});

export const ProjectWriteLeaseSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  acquiredAt: z.string(),
  workspaceOperationId: z.string().min(1).optional(),
  workspaceEpoch: z.number().int().nonnegative().optional(),
});

/** Safe HTTP projection. The host workspace path never crosses the boundary. */
export interface ProjectView {
  id: string;
  name: string;
  description: string;
  /** Legacy first-conversation pointer; not a one-conversation constraint. */
  teamId: string | null;
  agentIds: string[];
  memberships: ProjectMembershipView[];
  status: ProjectStatus;
  /** Present when the last settled lease cleanup needs operator recovery. */
  recoveryRequired?: true;
  /** Present when source checkpoints are enabled for this server. */
  workspaceCheckpoints?: {
    enabled: boolean;
    available: boolean;
    busy: boolean;
    recoveryRequired: boolean;
    workspaceEpoch: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMembershipView {
  agentId: string;
  role: ProjectRole;
}

export interface CreateProjectInput {
  name: string;
  description?: string | undefined;
}

export interface UpdateProjectInput {
  name?: string | undefined;
  description?: string | undefined;
}

export const PROJECT_LIMITS = {
  maxNameLength: 80,
  maxDescriptionLength: 500,
  /** How long a blocked Project turn waits for the write lease before failing. */
  writeLeaseWaitMs: 30_000,
  writeLeasePollIntervalMs: 50,
} as const;
