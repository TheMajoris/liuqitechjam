import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api } from "../api";
import { workerProviders } from "../components/WorkerModelFields";
import type {
  Agent,
  ModelDescriptor,
  ModelProviderDescriptor,
  ModelRef,
  ReasoningEffort,
} from "../types";
import type { AgentForm } from "./agent-form";

export interface ModelCatalogController {
  providers: ModelProviderDescriptor[];
  modelsByProvider: Record<string, ModelDescriptor[]>;
  providersLoading: boolean;
  catalogRefreshing: boolean;
  loadingByProvider: Record<string, boolean>;
  providerErrors: Record<string, string | null>;
  providerStale: Record<string, boolean>;
  error: string | null;
  defaultWorkerModel: ModelRef | null;
  selectedFormModels: ModelDescriptor[];
  selectedFormModelsLoading: boolean;
  selectedAgentReasoning: ReasoningEffort | undefined;
  selectedAgentReasoningSupported: boolean;
  modelSelectionInvalid: boolean;
  refresh: () => Promise<void>;
  loadProviderModels: (providerId: string, force?: boolean) => Promise<void>;
  changeProvider: (providerId: string) => void;
  changeModel: (modelId: string) => void;
  changeReasoning: (effort: ReasoningEffort | undefined) => void;
  addFallbackModel: () => void;
  removeFallbackModel: (index: number) => void;
  changeFallbackProvider: (index: number, providerId: string) => void;
  changeFallbackModel: (index: number, modelId: string) => void;
  retry: () => Promise<void>;
  clearError: () => void;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function chooseDefaultEffort(model: ModelDescriptor | undefined): ReasoningEffort | undefined {
  const efforts = model?.capabilities.reasoningEfforts ?? [];
  if (model?.capabilities.reasoning !== true || efforts.length === 0) return undefined;
  return efforts.includes("medium") ? "medium" : efforts[0];
}

function cloneModelRef(modelRef: ModelRef): ModelRef {
  return {
    providerId: modelRef.providerId,
    modelId: modelRef.modelId,
    ...(modelRef.reasoning?.effort === undefined
      ? {}
      : { reasoning: { effort: modelRef.reasoning.effort } }),
  };
}

function isInvalidModelRef(
  modelRef: ModelRef | undefined,
  modelsByProvider: Record<string, ModelDescriptor[]>,
  loadingByProvider: Record<string, boolean>,
  providerIds: ReadonlySet<string>,
): boolean {
  if (!modelRef?.providerId || !modelRef.modelId) return true;
  if (loadingByProvider[modelRef.providerId]) return true;
  if (!providerIds.has(modelRef.providerId)) return true;
  const models = modelsByProvider[modelRef.providerId];
  // A provider with no successful list yet is not a valid selection. This is
  // intentionally strict for both Create and Edit: the server must persist an
  // explicit, currently catalogued modelRef rather than a hidden legacy default.
  if (!models) return true;
  const model = models.find(
    (candidate) => candidate.id === modelRef.modelId && candidate.providerId === modelRef.providerId,
  );
  if (!model) return true;
  const effort = modelRef.reasoning?.effort;
  const efforts = model.capabilities.reasoningEfforts ?? [];
  if (effort !== undefined && (!model.capabilities.reasoning || !efforts.includes(effort))) {
    return true;
  }
  return model.capabilities.reasoning && efforts.length > 0 && effort === undefined;
}

/**
 * Deep catalog module: discovery, lazy loading, stale-request suppression, and
 * form validity rules are kept out of the application composition facade.
 */
export function useModelCatalog(
  form: AgentForm,
  selected: Agent | null,
  setForm: Dispatch<SetStateAction<AgentForm>>,
): ModelCatalogController {
  const [providers, setProviders] = useState<ModelProviderDescriptor[]>([]);
  const [defaultModelRef, setDefaultModelRef] = useState<ModelRef | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelDescriptor[]>>({});
  const [providersLoading, setProvidersLoading] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [loadingByProvider, setLoadingByProvider] = useState<Record<string, boolean>>({});
  const [providerErrors, setProviderErrors] = useState<Record<string, string | null>>({});
  const [providerStale, setProviderStale] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const requests = useRef(new Map<string, number>());
  const requestSequence = useRef(0);
  const catalogRequestSequence = useRef(0);
  const loadedProviders = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const requestId = ++catalogRequestSequence.current;
    setProvidersLoading(true);
    setCatalogRefreshing(true);
    setError(null);
    // Keep cached lists visible while the control plane is checked again. This
    // prevents a refresh from turning an otherwise valid assignment into a
    // transient "unavailable" state.
    setProviderStale((current) =>
      Object.fromEntries(Object.keys(current).map((providerId) => [providerId, true])),
    );
    loadedProviders.current.clear();
    requests.current.clear();
    setLoadingByProvider({});
    setCatalogEpoch((current) => current + 1);
    try {
      const response = await api.listModelProviders("worker", true);
      if (catalogRequestSequence.current !== requestId) return;
      setProviders(response.providers);
      setDefaultModelRef(response.defaultModelRef);
    } catch (reason) {
      if (catalogRequestSequence.current === requestId) setError(errorMessage(reason));
    } finally {
      if (catalogRequestSequence.current === requestId) {
        setProvidersLoading(false);
        setCatalogRefreshing(false);
      }
    }
  }, []);

  const loadProviderModels = useCallback(async (providerId: string, force = false) => {
    const normalizedProviderId = providerId.trim();
    if (
      !normalizedProviderId ||
      requests.current.has(normalizedProviderId) ||
      (!force && loadedProviders.current.has(normalizedProviderId))
    ) return;
    const requestId = ++requestSequence.current;
    requests.current.set(normalizedProviderId, requestId);
    setLoadingByProvider((current) => ({ ...current, [normalizedProviderId]: true }));
    setProviderErrors((current) => ({ ...current, [normalizedProviderId]: null }));
    setError(null);
    try {
      const response = await api.listProviderModels(normalizedProviderId, "worker", force);
      const models = response.models.filter(
        (model) =>
          model.providerId === normalizedProviderId &&
          model.capabilities.scopes.includes("worker"),
      );
      // A refresh can invalidate an older request while it is in flight. Do
      // not let that stale response repopulate the Agent form cache.
      if (requests.current.get(normalizedProviderId) === requestId) {
        setModelsByProvider((current) => ({ ...current, [normalizedProviderId]: models }));
        setProviderStale((current) => ({ ...current, [normalizedProviderId]: false }));
        setProviderErrors((current) => ({ ...current, [normalizedProviderId]: null }));
        loadedProviders.current.add(normalizedProviderId);
      }
    } catch (reason) {
      if (requests.current.get(normalizedProviderId) === requestId) {
        const message = errorMessage(reason);
        setProviderErrors((current) => ({ ...current, [normalizedProviderId]: message }));
        setProviderStale((current) => ({ ...current, [normalizedProviderId]: true }));
      }
    } finally {
      if (requests.current.get(normalizedProviderId) === requestId) {
        requests.current.delete(normalizedProviderId);
        setLoadingByProvider((current) => ({ ...current, [normalizedProviderId]: false }));
      }
    }
  }, []);

  const supportedProviders = useMemo(() => workerProviders(providers), [providers]);
  const supportedProviderIds = useMemo(
    () => new Set(supportedProviders.map((provider) => provider.id)),
    [supportedProviders],
  );
  const defaultWorkerModel = useMemo<ModelRef | null>(() => {
    const providerIds = new Set(supportedProviders.map((provider) => provider.id));
    return defaultModelRef && providerIds.has(defaultModelRef.providerId) ? defaultModelRef : null;
  }, [defaultModelRef, supportedProviders]);

  const selectedFormModels = form.modelRef?.providerId
    ? modelsByProvider[form.modelRef.providerId] ?? []
    : [];
  const selectedFormModelsLoading = form.modelRef?.providerId
    ? loadingByProvider[form.modelRef.providerId] === true
    : false;
  const selectedAgentModel = selected?.modelRef?.providerId
    ? (modelsByProvider[selected.modelRef.providerId] ?? []).find(
        (model) => model.id === selected.modelRef?.modelId,
      )
    : undefined;
  const selectedAgentReasoning = selected?.modelRef?.reasoning?.effort;
  const selectedAgentReasoningSupported =
    selectedAgentReasoning !== undefined &&
    selectedAgentModel?.capabilities.reasoning === true &&
    selectedAgentModel.capabilities.reasoningEfforts?.includes(selectedAgentReasoning) === true;
  const fallbackModelRefs = form.fallbackModelRefs ?? [];
  const primaryModelSelectionInvalid = isInvalidModelRef(
    form.modelRef,
    modelsByProvider,
    loadingByProvider,
    supportedProviderIds,
  );
  const fallbackModelSelectionInvalid = fallbackModelRefs.some((modelRef) =>
    isInvalidModelRef(modelRef, modelsByProvider, loadingByProvider, supportedProviderIds),
  );
  const modelSelectionInvalid = primaryModelSelectionInvalid || fallbackModelSelectionInvalid;

  useEffect(() => {
    const providerIds = new Set<string>();
    if (form.modelRef?.providerId) providerIds.add(form.modelRef.providerId);
    for (const modelRef of fallbackModelRefs) {
      if (modelRef.providerId) providerIds.add(modelRef.providerId);
    }
    for (const providerId of providerIds) void loadProviderModels(providerId);
  }, [catalogEpoch, fallbackModelRefs, form.modelRef?.providerId, loadProviderModels]);

  const changeProvider = useCallback(
    (providerId: string) => {
      const normalizedProviderId = providerId.trim();
      setError(null);
      if (!normalizedProviderId) {
        setForm((current) => ({ ...current, modelRef: undefined }));
        return;
      }
      setForm((current) => ({
        ...current,
        modelRef: { providerId: normalizedProviderId, modelId: "" },
      }));
      void loadProviderModels(normalizedProviderId);
    },
    [loadProviderModels, setForm],
  );

  const changeModel = useCallback(
    (modelId: string) => {
      const providerId = form.modelRef?.providerId;
      if (!providerId) return;
      setError(null);
      const model = (modelsByProvider[providerId] ?? []).find((candidate) => candidate.id === modelId);
      const effort = chooseDefaultEffort(model);
      setForm((current) => ({
        ...current,
        modelRef: {
          providerId,
          modelId,
          ...(effort ? { reasoning: { effort } } : {}),
        },
      }));
    },
    [form.modelRef?.providerId, modelsByProvider, setForm],
  );

  const addFallbackModel = useCallback(() => {
    setError(null);
    setForm((current) => ({
      ...current,
      fallbackModelRefs: [
        ...(current.fallbackModelRefs ?? []).map(cloneModelRef),
        { providerId: "", modelId: "" },
      ],
    }));
  }, [setForm]);

  const removeFallbackModel = useCallback(
    (index: number) => {
      setError(null);
      setForm((current) => ({
        ...current,
        fallbackModelRefs: (current.fallbackModelRefs ?? [])
          .filter((_, candidateIndex) => candidateIndex !== index)
          .map(cloneModelRef),
      }));
    },
    [setForm],
  );

  const changeFallbackProvider = useCallback(
    (index: number, providerId: string) => {
      const normalizedProviderId = providerId.trim();
      setError(null);
      setForm((current) => {
        const fallbackModelRefs = (current.fallbackModelRefs ?? []).map(cloneModelRef);
        if (!fallbackModelRefs[index]) return current;
        fallbackModelRefs[index] = {
          providerId: normalizedProviderId,
          modelId: "",
        };
        return { ...current, fallbackModelRefs };
      });
      if (normalizedProviderId) void loadProviderModels(normalizedProviderId);
    },
    [loadProviderModels, setForm],
  );

  const changeFallbackModel = useCallback(
    (index: number, modelId: string) => {
      setError(null);
      setForm((current) => {
        const fallbackModelRefs = (current.fallbackModelRefs ?? []).map(cloneModelRef);
        const currentRef = fallbackModelRefs[index];
        if (!currentRef) return current;
        const model = (modelsByProvider[currentRef.providerId] ?? []).find(
          (candidate) => candidate.id === modelId,
        );
        const effort = chooseDefaultEffort(model);
        fallbackModelRefs[index] = {
          providerId: currentRef.providerId,
          modelId,
          ...(effort ? { reasoning: { effort } } : {}),
        };
        return { ...current, fallbackModelRefs };
      });
    },
    [modelsByProvider, setForm],
  );

  const changeReasoning = useCallback(
    (effort: ReasoningEffort | undefined) => {
      setForm((current) => {
        if (!current.modelRef) return current;
        const { reasoning: _reasoning, ...withoutReasoning } = current.modelRef;
        return {
          ...current,
          modelRef: {
            ...withoutReasoning,
            ...(effort ? { reasoning: { effort } } : {}),
          },
        };
      });
    },
    [setForm],
  );

  const retry = useCallback(async () => {
    await refresh();
    const providerIds = new Set<string>();
    if (form.modelRef?.providerId) providerIds.add(form.modelRef.providerId);
    for (const modelRef of form.fallbackModelRefs ?? []) {
      if (modelRef.providerId) providerIds.add(modelRef.providerId);
    }
    await Promise.all(Array.from(providerIds, (providerId) => loadProviderModels(providerId, true)));
  }, [form.fallbackModelRefs, form.modelRef?.providerId, loadProviderModels, refresh]);

  const clearError = useCallback(() => setError(null), []);

  return {
    providers,
    modelsByProvider,
    providersLoading,
    catalogRefreshing,
    loadingByProvider,
    providerErrors,
    providerStale,
    error,
    defaultWorkerModel,
    selectedFormModels,
    selectedFormModelsLoading,
    selectedAgentReasoning,
    selectedAgentReasoningSupported,
    modelSelectionInvalid,
    refresh,
    loadProviderModels,
    changeProvider,
    changeModel,
    changeReasoning,
    addFallbackModel,
    removeFallbackModel,
    changeFallbackProvider,
    changeFallbackModel,
    retry,
    clearError,
  };
}
