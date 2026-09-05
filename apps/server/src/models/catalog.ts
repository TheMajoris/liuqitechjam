import { z } from "zod";
import type { Storage } from "../store.js";
import { ModelCatalogError } from "./errors.js";
import { ARK_WORKER_PROVIDER_ID } from "./ark-provider.js";
import { ModelRefSchema } from "./schemas.js";
import type { ModelRef } from "./types.js";

/**
 * Persisted Ark metadata. Credentials are deliberately represented only by
 * the environment-variable name; the secret value never crosses this type,
 * the store, or the operator HTTP boundary.
 */
export interface ArkModelCatalogRecord {
  provider: typeof ARK_WORKER_PROVIDER_ID;
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  /** Optional for records created before operator default selection existed. */
  defaultModelRef?: ModelRef | null;
  /** Monotonically increasing successful update count. */
  revision?: number;
}

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "baseUrl must be an HTTP(S) URL without credentials, query, or fragment data",
    );
  }
  return baseUrl;
}

const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    try {
      normalizeBaseUrl(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "baseUrl is invalid",
      });
    }
  })
  .transform(normalizeBaseUrl);

const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !CONTROL_CHARACTER.test(value), {
    message: "model IDs cannot contain control characters",
  });

const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** Strict, Ark-only catalog input and on-disk representation. */
export const ArkModelCatalogSchema = z
  .object({
    provider: z.literal(ARK_WORKER_PROVIDER_ID),
    baseUrl: baseUrlSchema,
    apiKeyEnv: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(
        ENVIRONMENT_NAME,
        "apiKeyEnv must be an uppercase environment variable name",
      ),
    models: z.array(modelIdSchema).max(256),
    defaultModelRef: ModelRefSchema.nullable().optional(),
    revision: revisionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.models).size !== value.models.length) {
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "models must not contain duplicate IDs",
      });
    }
    if (
      value.defaultModelRef !== undefined &&
      value.defaultModelRef !== null &&
      value.defaultModelRef.providerId !== ARK_WORKER_PROVIDER_ID
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultModelRef", "providerId"],
        message: "The Ark catalog default must use the Ark provider",
      });
    }
    if (
      value.defaultModelRef !== undefined &&
      value.defaultModelRef !== null &&
      value.defaultModelRef.reasoning?.effort !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultModelRef", "reasoning"],
        message: "The Ark catalog default cannot include reasoning controls",
      });
    }
    if (
      value.defaultModelRef !== undefined &&
      value.defaultModelRef !== null &&
      !value.models.includes(value.defaultModelRef.modelId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultModelRef", "modelId"],
        message: "The default model must be enabled in models",
      });
    }
  })
  .transform((value): ArkModelCatalogRecord => ({
    provider: value.provider,
    baseUrl: value.baseUrl,
    apiKeyEnv: value.apiKeyEnv,
    models: [...value.models],
    ...(value.defaultModelRef === undefined
      ? {}
      : {
          defaultModelRef:
            value.defaultModelRef === null
              ? null
              : {
                  providerId: value.defaultModelRef.providerId,
                  modelId: value.defaultModelRef.modelId,
                },
        }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
  }));

export type ArkModelCatalogInput = z.input<typeof ArkModelCatalogSchema>;

const catalogSelectionSchema = z
  .object({
    modelIds: z.array(modelIdSchema).min(1).max(256),
    defaultModelRef: ModelRefSchema,
    revision: revisionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.modelIds).size !== value.modelIds.length) {
      context.addIssue({
        code: "custom",
        path: ["modelIds"],
        message: "modelIds must not contain duplicate IDs",
      });
    }
    if (value.defaultModelRef.providerId !== ARK_WORKER_PROVIDER_ID) {
      context.addIssue({
        code: "custom",
        path: ["defaultModelRef", "providerId"],
        message: "The Ark catalog default must use the Ark provider",
      });
    }
    if (value.defaultModelRef.reasoning?.effort !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["defaultModelRef", "reasoning"],
        message: "The Ark catalog default cannot include reasoning controls",
      });
    }
    if (!value.modelIds.includes(value.defaultModelRef.modelId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultModelRef", "modelId"],
        message: "The default model must be enabled in modelIds",
      });
    }
  });

export type ArkModelCatalogSelection = z.output<typeof catalogSelectionSchema>;

export function cloneArkModelCatalog(
  catalog: ArkModelCatalogRecord,
): ArkModelCatalogRecord {
  return {
    provider: catalog.provider,
    baseUrl: catalog.baseUrl,
    apiKeyEnv: catalog.apiKeyEnv,
    models: [...catalog.models],
    ...(catalog.defaultModelRef === undefined
      ? {}
      : {
          defaultModelRef:
            catalog.defaultModelRef === null
              ? null
              : { ...catalog.defaultModelRef },
        }),
    ...(catalog.revision === undefined ? {} : { revision: catalog.revision }),
  };
}

/** Convert an unknown operator payload into the safe canonical catalog. */
export function parseArkModelCatalog(value: unknown): ArkModelCatalogRecord {
  const parsed = ArkModelCatalogSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ModelCatalogError(
    "MODEL_CATALOG_INVALID",
    422,
    "The Ark model catalog is invalid",
  );
}

function parseCatalogSelection(value: unknown): ArkModelCatalogSelection {
  const parsed = catalogSelectionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ModelCatalogError(
    "MODEL_CATALOG_INVALID",
    422,
    "The Ark model catalog selection is invalid",
  );
}

export interface ModelCatalogReader {
  get(): ArkModelCatalogRecord;
}

/**
 * Persistent, atomic Ark catalog service. Storage serializes mutations and
 * publishes the in-memory snapshot only after its temp-file rename succeeds.
 */
export class ArkModelCatalogService implements ModelCatalogReader {
  constructor(private readonly store: Storage) {}

  /** Seed a new store once; an existing operator-managed catalog wins. */
  async initialize(seed: unknown): Promise<ArkModelCatalogRecord> {
    const parsedSeed = parseArkModelCatalog(seed);
    const existing = this.store.snapshot().modelCatalog;
    if (existing !== null && existing !== undefined) {
      const models = existing.models.length > 0
        ? [...existing.models]
        : [...parsedSeed.models];
      const seededDefault = parsedSeed.defaultModelRef;
      const defaultModelRef =
        existing.defaultModelRef !== undefined
          ? existing.defaultModelRef
          : seededDefault && models.includes(seededDefault.modelId)
            ? seededDefault
            : models[0]
              ? { providerId: ARK_WORKER_PROVIDER_ID, modelId: models[0] }
              : null;
      const canonical: ArkModelCatalogRecord = {
        ...cloneArkModelCatalog(existing),
        models,
        defaultModelRef:
          defaultModelRef === null ? null : { ...defaultModelRef },
        revision: existing.revision ?? 1,
      };
      const needsMigration =
        existing.defaultModelRef === undefined ||
        existing.revision === undefined ||
        existing.models.length !== canonical.models.length;
      if (!needsMigration) return canonical;
      return this.store.mutate((database) => {
        database.modelCatalog = cloneArkModelCatalog(canonical);
        return cloneArkModelCatalog(canonical);
      });
    }
    return this.store.mutate((database) => {
      if (database.modelCatalog !== null && database.modelCatalog !== undefined) {
        return cloneArkModelCatalog(database.modelCatalog);
      }
      database.modelCatalog = cloneArkModelCatalog(parsedSeed);
      return cloneArkModelCatalog(database.modelCatalog);
    });
  }

  get(): ArkModelCatalogRecord {
    const catalog = this.store.snapshot().modelCatalog;
    if (catalog === null || catalog === undefined) {
      throw new ModelCatalogError(
        "MODEL_CATALOG_UNAVAILABLE",
        503,
        "The Ark model catalog is not initialized",
      );
    }
    return cloneArkModelCatalog(catalog);
  }

  /** Replace metadata atomically; omitted optional fields preserve state. */
  async replace(value: unknown): Promise<ArkModelCatalogRecord> {
    const replacement = parseArkModelCatalog(value);
    return this.store.mutate((database) => {
      const current = database.modelCatalog;
      const currentRevision = current?.revision ?? 0;
      if (
        replacement.revision !== undefined &&
        replacement.revision !== currentRevision
      ) {
        throw new ModelCatalogError(
          "MODEL_CATALOG_CONFLICT",
          409,
          "The Ark model catalog changed; reload it and try again",
        );
      }
      const defaultModelRef = replacement.defaultModelRef === undefined
        ? current?.defaultModelRef
        : replacement.defaultModelRef;
      if (
        defaultModelRef !== undefined &&
        defaultModelRef !== null &&
        !replacement.models.includes(defaultModelRef.modelId)
      ) {
        throw new ModelCatalogError(
          "MODEL_CATALOG_INVALID",
          422,
          "The default model must be enabled in models",
        );
      }
      const next: ArkModelCatalogRecord = {
        ...cloneArkModelCatalog(replacement),
        ...(defaultModelRef === undefined ? {} : { defaultModelRef }),
        revision: currentRevision + 1,
      };
      database.modelCatalog = next;
      return cloneArkModelCatalog(next);
    });
  }

  /** Atomically update enabled IDs/default with optimistic revisioning. */
  async updateSelection(value: unknown): Promise<ArkModelCatalogRecord> {
    const selection = parseCatalogSelection(value);
    return this.store.mutate((database) => {
      const current = database.modelCatalog;
      if (current === null || current === undefined) {
        throw new ModelCatalogError(
          "MODEL_CATALOG_UNAVAILABLE",
          503,
          "The Ark model catalog is not initialized",
        );
      }
      const currentRevision = current.revision ?? 0;
      if (
        selection.revision !== undefined &&
        selection.revision !== currentRevision
      ) {
        throw new ModelCatalogError(
          "MODEL_CATALOG_CONFLICT",
          409,
          "The Ark model catalog changed; reload it and try again",
        );
      }
      const next: ArkModelCatalogRecord = {
        ...cloneArkModelCatalog(current),
        models: [...selection.modelIds],
        defaultModelRef: {
          providerId: selection.defaultModelRef.providerId,
          modelId: selection.defaultModelRef.modelId,
        },
        revision: currentRevision + 1,
      };
      database.modelCatalog = next;
      return cloneArkModelCatalog(next);
    });
  }
}
