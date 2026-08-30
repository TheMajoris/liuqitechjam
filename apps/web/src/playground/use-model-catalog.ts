import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
  loadingByProvider: Record<string, boolean>;
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
  retry: () => void;
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
  const [loadingByProvider, setLoadingByProvider] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(new Set<string>());
  const loadedProviders = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    setProvidersLoading(true);
    setError(null);
    try {
      const response = await api.listModelProviders();
      setProviders(response.providers);
      setDefaultModelRef(response.defaultModelRef);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  const loadProviderModels = useCallback(async (providerId: string, force = false) => {
    const normalizedProviderId = providerId.trim();
    if (
      !normalizedProviderId ||
      requests.current.has(normalizedProviderId) ||
      (!force && loadedProviders.current.has(normalizedProviderId))
    ) return;
    requests.current.add(normalizedProviderId);
    setLoadingByProvider((current) => ({ ...current, [normalizedProviderId]: true }));
    setError(null);
    try {
      const response = await api.listProviderModels(normalizedProviderId);
      const models = response.models.filter(
        (model) =>
          model.providerId === normalizedProviderId &&
          model.capabilities.scopes.includes("worker"),
      );
      setModelsByProvider((current) => ({ ...current, [normalizedProviderId]: models }));
      loadedProviders.current.add(normalizedProviderId);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      requests.current.delete(normalizedProviderId);
      setLoadingByProvider((current) => ({ ...current, [normalizedProviderId]: false }));
    }
  }, []);

  const supportedProviders = useMemo(() => workerProviders(providers), [providers]);
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
  const selectedFormModel = form.modelRef?.modelId
    ? selectedFormModels.find((model) => model.id === form.modelRef?.modelId)
    : undefined;
  const selectedFormReasoning = form.modelRef?.reasoning?.effort;
  const selectedFormEfforts = selectedFormModel?.capabilities.reasoningEfforts ?? [];
  const modelSelectionInvalid = Boolean(
    form.modelRef &&
      (!form.modelRef.providerId ||
        !form.modelRef.modelId ||
        selectedFormModelsLoading ||
        Boolean(error) ||
        !selectedFormModel ||
        (selectedFormModel.capabilities.reasoning &&
          selectedFormEfforts.length > 0 &&
          (!selectedFormReasoning || !selectedFormEfforts.includes(selectedFormReasoning))) ||
        (selectedFormReasoning !== undefined &&
          (!selectedFormModel.capabilities.reasoning ||
            !selectedFormEfforts.includes(selectedFormReasoning)))),
  );

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
      if (!providerId || !modelId) return;
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

  const retry = useCallback(() => {
    void refresh();
    if (form.modelRef?.providerId) void loadProviderModels(form.modelRef.providerId, true);
  }, [form.modelRef?.providerId, loadProviderModels, refresh]);

  const clearError = useCallback(() => setError(null), []);

  return {
    providers,
    modelsByProvider,
    providersLoading,
    loadingByProvider,
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
    retry,
    clearError,
  };
}
