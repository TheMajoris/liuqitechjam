import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import { api, ApiError } from "../api";
import type { PreviewActionError } from "../components/PreviewSidecar";
import type {
  Agent,
  AgentConversation,
  AgentRun,
  AgentSkills,
  Message,
  Preview,
} from "../types";

export type PreviewAction = "start" | "restart" | "stop";

export interface AgentWorkspaceController {
  messages: Message[];
  conversations: AgentConversation[];
  conversationId: string | null;
  activeRun: AgentRun | null;
  preview: Preview | null;
  previewLogs: string[];
  previewBusy: PreviewAction | null;
  previewActionError: PreviewActionError | null;
  agentSkills: AgentSkills | null;
  agentSkillsError: string | null;
  prompt: string;
  runInFlight: boolean;
  setPrompt: (value: string) => void;
  openConversation: (conversationId: string) => Promise<void>;
  createConversation: () => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  runPreviewAction: (action: PreviewAction) => Promise<void>;
  openPreview: () => void;
  sendMessage: (event: FormEvent) => Promise<void>;
}

interface UseAgentWorkspaceOptions {
  selectedId: string | null;
  refreshAgents: () => Promise<void>;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function toPreviewActionError(reason: unknown): PreviewActionError {
  if (reason instanceof ApiError) {
    return { message: reason.message, errorCode: reason.errorCode };
  }
  return {
    message: "Unable to complete the preview request. Please try again.",
    errorCode: null,
  };
}

function isRunActive(run: AgentRun | null): boolean {
  return run !== null && (run.status === "queued" || run.status === "running");
}

/**
 * Deep selected-Agent module. Conversation, run, preview, and skill lifecycle
 * details stay behind a small controller consumed by the view and sidebar.
 */
export function useAgentWorkspace({
  selectedId,
  refreshAgents,
  setAgents,
  setError,
}: UseAgentWorkspaceOptions): AgentWorkspaceController {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLogs, setPreviewLogs] = useState<string[]>([]);
  const [previewBusy, setPreviewBusy] = useState<PreviewAction | null>(null);
  const [previewActionError, setPreviewActionError] = useState<PreviewActionError | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkills | null>(null);
  const [agentSkillsError, setAgentSkillsError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const selectedIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  conversationIdRef.current = conversationId;

  const refreshMessages = useCallback(async (agentId: string) => {
    const currentConversationId = conversationIdRef.current;
    const result = await api.messages(agentId, currentConversationId ?? undefined);
    if (
      mountedRef.current &&
      selectedIdRef.current === agentId &&
      conversationIdRef.current === currentConversationId
    ) {
      setMessages(result.messages);
    }
  }, []);

  const refreshPreview = useCallback(
    async (
      agentId: string,
      options: { clearActionErrorOnSuccess?: boolean } = {},
    ): Promise<Preview | null> => {
      try {
        const result = await api.getPreview(agentId);
        if (mountedRef.current && selectedIdRef.current === agentId) {
          setPreview(result.preview);
          if (options.clearActionErrorOnSuccess) setPreviewActionError(null);
        }
        if (["starting", "running", "failed"].includes(result.preview.status)) {
          try {
            const logs = await api.getPreviewLogs(agentId, 100);
            if (mountedRef.current && selectedIdRef.current === agentId) {
              setPreviewLogs(logs.logs);
            }
          } catch {
            // Logs are supplemental; keep the status visible if the runtime
            // exits between the status and log requests.
          }
        } else if (mountedRef.current && selectedIdRef.current === agentId) {
          setPreviewLogs([]);
        }
        return result.preview;
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 404) {
          if (mountedRef.current && selectedIdRef.current === agentId) {
            setPreview(null);
            setPreviewLogs([]);
            if (options.clearActionErrorOnSuccess) setPreviewActionError(null);
          }
          return null;
        }
        throw reason;
      }
    },
    [],
  );

  const pollRun = useCallback(
    async (runId: string, agentId: string): Promise<void> => {
      if (pollingRunIds.current.has(runId)) return;
      pollingRunIds.current.add(runId);
      try {
        while (mountedRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          if (!mountedRef.current) return;
          const result = await api.run(runId);
          if (selectedIdRef.current === agentId) setActiveRun(result.run);
          if (!isRunActive(result.run)) {
            await Promise.all([refreshMessages(agentId), refreshAgents()]);
            return;
          }
        }
      } finally {
        pollingRunIds.current.delete(runId);
      }
    },
    [refreshAgents, refreshMessages],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setActiveRun(null);
    setPreview(null);
    setPreviewLogs([]);
    setPreviewActionError(null);
    setAgentSkills(null);
    setAgentSkillsError(null);
    if (!selectedId) {
      setMessages([]);
      setConversations([]);
      setConversationId(null);
      return;
    }

    void api
      .conversations(selectedId)
      .then(async ({ conversations: next }) => {
        if (selectedIdRef.current !== selectedId) return;
        setConversations(next);
        const opened = next[0]?.id ?? null;
        setConversationId(opened);
        conversationIdRef.current = opened;
        const [, result] = await Promise.all([
          refreshMessages(selectedId),
          api.runs(selectedId, opened ?? undefined),
        ]);
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (isRunActive(latest)) {
          void pollRun(latest.id, selectedId).catch((reason) => setError(errorMessage(reason)));
        }
      })
      .catch((reason) => setError(errorMessage(reason)));

    void refreshPreview(selectedId, { clearActionErrorOnSuccess: true }).catch((reason) => {
      if (mountedRef.current && selectedIdRef.current === selectedId) {
        setPreviewActionError(toPreviewActionError(reason));
      }
    });

    void api
      .agentSkills(selectedId)
      .then(({ skills }) => {
        if (mountedRef.current && selectedIdRef.current === selectedId) setAgentSkills(skills);
      })
      .catch((reason) => {
        if (mountedRef.current && selectedIdRef.current === selectedId) {
          setAgentSkillsError(errorMessage(reason));
        }
      });
  }, [pollRun, refreshMessages, refreshPreview, selectedId, setError]);

  useEffect(() => {
    if (!selectedId || !preview || (preview.status !== "starting" && preview.status !== "running")) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshPreview(selectedId, { clearActionErrorOnSuccess: true }).catch((reason) => {
        if (mountedRef.current && selectedIdRef.current === selectedId) {
          setPreviewActionError(toPreviewActionError(reason));
        }
      });
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [preview?.status, refreshPreview, selectedId]);

  const openConversation = useCallback(
    async (nextId: string) => {
      if (!selectedId || nextId === conversationIdRef.current) return;
      setConversationId(nextId);
      conversationIdRef.current = nextId;
      setMessages([]);
      setActiveRun(null);
      setError(null);
      try {
        const [, result] = await Promise.all([
          refreshMessages(selectedId),
          api.runs(selectedId, nextId),
        ]);
        if (conversationIdRef.current !== nextId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (isRunActive(latest)) void pollRun(latest.id, selectedId).catch(() => undefined);
      } catch (reason) {
        setError(errorMessage(reason));
      }
    },
    [pollRun, refreshMessages, selectedId, setError],
  );

  const createConversation = useCallback(async () => {
    if (!selectedId) return;
    try {
      const { conversation } = await api.createConversation(selectedId);
      setConversations((current) => [conversation, ...current]);
      setConversationId(conversation.id);
      conversationIdRef.current = conversation.id;
      setMessages([]);
      setActiveRun(null);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [selectedId, setError]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      if (!selectedId) return;
      try {
        const { conversation } = await api.renameConversation(selectedId, id, title);
        setConversations((current) =>
          current.map((item) => (item.id === id ? conversation : item)),
        );
      } catch (reason) {
        setError(errorMessage(reason));
      }
    },
    [selectedId, setError],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      if (!selectedId) return;
      try {
        await api.deleteConversation(selectedId, id);
        const remaining = conversations.filter((item) => item.id !== id);
        setConversations(remaining);
        if (conversationIdRef.current !== id) return;
        const next = remaining[0]?.id ?? null;
        setConversationId(next);
        conversationIdRef.current = next;
        setMessages([]);
        setActiveRun(null);
        if (next) await refreshMessages(selectedId);
      } catch (reason) {
        setError(errorMessage(reason));
      }
    },
    [conversations, refreshMessages, selectedId, setError],
  );

  const runPreviewAction = useCallback(
    async (action: PreviewAction) => {
      if (!selectedId) return;
      setPreviewBusy(action);
      setPreviewActionError(null);
      try {
        const result =
          action === "start"
            ? await api.startPreview(selectedId)
            : action === "restart"
              ? await api.restartPreview(selectedId)
              : await api.stopPreview(selectedId);
        if (selectedIdRef.current === selectedId) {
          setPreview(result.preview);
          if (result.preview.status === "running") {
            const logs = await api.getPreviewLogs(selectedId, 100).catch(() => null);
            if (logs) setPreviewLogs(logs.logs);
          } else {
            setPreviewLogs([]);
          }
        }
      } catch (reason) {
        if (mountedRef.current && selectedIdRef.current === selectedId) {
          setPreviewActionError(toPreviewActionError(reason));
        }
        await refreshPreview(selectedId).catch(() => undefined);
      } finally {
        setPreviewBusy(null);
      }
    },
    [refreshPreview, selectedId],
  );

  const openPreview = useCallback(() => {
    if (!preview?.url) return;
    window.open(preview.url, "_blank", "noopener,noreferrer");
  }, [preview?.url]);

  const sendMessage = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!selectedId || !prompt.trim()) return;
      const content = prompt.trim();
      setPrompt("");
      setError(null);
      try {
        const result = await api.sendMessage(
          selectedId,
          content,
          conversationIdRef.current ?? undefined,
        );
        if (selectedIdRef.current === selectedId) {
          setMessages((current) => [...current, result.message]);
          setActiveRun(result.run);
        }
        if (result.message.conversationId) {
          conversationIdRef.current = result.message.conversationId;
          setConversationId(result.message.conversationId);
        }
        void api
          .conversations(selectedId)
          .then(({ conversations: next }) => {
            if (selectedIdRef.current === selectedId) setConversations(next);
          })
          .catch(() => undefined);
        setAgents((current) =>
          current.map((agent) =>
            agent.id === selectedId ? { ...agent, status: "busy" } : agent,
          ),
        );
        await pollRun(result.run.id, selectedId);
      } catch (reason) {
        setError(errorMessage(reason));
        setActiveRun(null);
        await refreshAgents();
      }
    },
    [pollRun, prompt, refreshAgents, selectedId, setAgents, setError],
  );

  return {
    messages,
    conversations,
    conversationId,
    activeRun,
    preview,
    previewLogs,
    previewBusy,
    previewActionError,
    agentSkills,
    agentSkillsError,
    prompt,
    runInFlight: isRunActive(activeRun),
    setPrompt,
    openConversation,
    createConversation,
    renameConversation,
    deleteConversation,
    runPreviewAction,
    openPreview,
    sendMessage,
  };
}
