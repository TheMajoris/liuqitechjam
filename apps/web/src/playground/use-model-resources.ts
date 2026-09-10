import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  ModelEndpointResource,
  ModelResourceSnapshot,
  ModelResourceView,
  ModelResourcesResponse,
  ModelUsageSnapshot,
} from "../types";

const POLL_MS = 20_000;

export function modelResourceKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function modelResourceKeyForRef(
  modelRef: { providerId?: string; modelId?: string } | null | undefined,
): string | null {
  if (!modelRef?.providerId || !modelRef.modelId) return null;
  return modelResourceKey(modelRef.providerId, modelRef.modelId);
}

export interface ModelResourcesController {
  resources: ModelResourceSnapshot[];
  byKey: Map<string, ModelResourceSnapshot>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  generatedAt: string | null;
  refresh: (silent?: boolean) => Promise<void>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function staleResources(resources: ModelResourceSnapshot[]): ModelResourceSnapshot[] {
  return resources.map((resource) =>
    resource.freshness === "fresh" ? { ...resource, freshness: "stale" } : resource,
  );
}

function endpointStatus(endpoint: ModelEndpointResource): ModelResourceSnapshot["endpointStatus"] {
  if (endpoint.status === "running") return "running";
  if (endpoint.status === "not_running") return "unavailable";
  return "unknown";
}

/** Exported for tests: the wire projection every live surface reads through. */
export function normalizeResponse(response: ModelResourcesResponse): {
  resources: ModelResourceSnapshot[];
  generatedAt: string | null;
  error: string | null;
} {
  if (response.resources !== undefined) {
    return {
      resources: response.resources,
      generatedAt: response.generatedAt ?? null,
      error: null,
    };
  }

  const view: ModelResourceView | null = response.resource ??
    (response.endpoints !== undefined && response.providerId
      ? {
          providerId: response.providerId,
          availability: response.availability ?? "unavailable",
          stale: response.stale ?? true,
          fetchedAt: response.fetchedAt ?? null,
          revision: response.revision ?? 0,
          endpoints: response.endpoints,
          inferenceUsage: response.inferenceUsage ?? null,
          error: response.error ?? null,
        }
      : null);
  if (!view) return { resources: [], generatedAt: response.generatedAt ?? null, error: null };

  const freshness: ModelResourceSnapshot["freshness"] =
    view.availability === "unavailable" && view.endpoints.length === 0
      ? "unavailable"
      : view.stale || view.availability === "partial"
        ? "stale"
        : "fresh";
  return {
    resources: view.endpoints.map((endpoint) => {
      const usage: ModelUsageSnapshot | null = endpoint.usage === null
        ? null
        : {
            ...(endpoint.usage.inputTokens === null ? {} : { inputTokens: endpoint.usage.inputTokens }),
            ...(endpoint.usage.cachedInputTokens === null
              ? {}
              : { cachedInputTokens: endpoint.usage.cachedInputTokens }),
            ...(endpoint.usage.outputTokens === null ? {} : { outputTokens: endpoint.usage.outputTokens }),
            ...(endpoint.usage.totalTokens === null ? {} : { totalTokens: endpoint.usage.totalTokens }),
            ...(endpoint.usage.requests === null ? {} : { requests: endpoint.usage.requests }),
            scope: "model",
            availability: view.inferenceUsage?.availability ?? "unavailable",
            ...(view.inferenceUsage === null
              ? {}
              : { queryInterval: view.inferenceUsage.queryInterval }),
            windowStart: view.inferenceUsage?.startTime ?? null,
            windowEnd: view.inferenceUsage?.endTime ?? null,
          };
      return {
        providerId: endpoint.providerId || view.providerId,
        modelId: endpoint.modelId,
        name: endpoint.name,
        foundationModel: endpoint.foundationModel,
        statusReason: endpoint.statusReason,
        rateLimit: endpoint.rateLimit,
        endpointStatus: endpointStatus(endpoint),
        usage,
        quota: endpoint.quota ?? null,
        contextWindowTokens: endpoint.contextWindowTokens ?? null,
        freshness,
        observedAt: endpoint.observedAt || view.fetchedAt,
      };
    }),
    generatedAt: response.generatedAt ?? view.fetchedAt ?? view.inferenceUsage?.observedAt ?? null,
    error: view.error,
  };
}

/**
 * One read-only live-resource poller shared by Workspace and Insights.
 * ModelArk is intentionally absent from this module: the server owns provider
 * credentials, caching, and normalization.
 */
export function useModelResources(enabled: boolean): ModelResourcesController {
  const [resources, setResources] = useState<ModelResourceSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const refresh = useCallback(async (silent = false, force = !silent) => {
    const requestId = ++requestSequence.current;
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const response = normalizeResponse(await api.modelResources(force));
      if (requestSequence.current !== requestId) return;
      setResources(response.resources);
      setGeneratedAt(response.generatedAt);
      setError(response.error);
    } catch (reason) {
      if (requestSequence.current !== requestId) return;
      setError(errorMessage(reason));
      // A failed refresh is still useful evidence when a previous snapshot
      // exists. Mark only fresh rows stale; unavailable rows remain unknown.
      setResources((current) => staleResources(current));
    } finally {
      if (requestSequence.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh(true, false);
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      requestSequence.current += 1;
    };
  }, [enabled, refresh]);

  const byKey = useMemo(
    () => new Map(resources.map((resource) => [modelResourceKey(resource.providerId, resource.modelId), resource])),
    [resources],
  );

  return { resources, byKey, loading, refreshing, error, generatedAt, refresh };
}
