import { z } from "zod";
import type { ModelRef } from "./types.js";

export const ModelScopeSchema = z.enum(["worker", "supervisor"]);

export const ReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** Safe, repository-owned request shape; provider SDK types never cross this boundary. */
export const ModelRefSchema = z
  .object({
    providerId: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(256),
    reasoning: z
      .object({
        effort: ReasoningEffortSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .transform(({ providerId, modelId, reasoning }): ModelRef => ({
    providerId,
    modelId,
    ...(reasoning?.effort === undefined
      ? {}
      : { reasoning: { effort: reasoning.effort } }),
  }));

export const ModelProviderParamsSchema = z.object({
  providerId: z.string().trim().min(1).max(100),
});

export const ModelScopeQuerySchema = z.object({
  scope: ModelScopeSchema.default("worker"),
});

export type ModelRefInput = z.infer<typeof ModelRefSchema>;
