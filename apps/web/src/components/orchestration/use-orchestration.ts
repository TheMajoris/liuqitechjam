import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  type OrchestrationDraft,
  type WorkspaceDraft,
} from "./orchestration-utils";
import type {
  OrchestrationSession,
  OrchestrationSessionDetail,
  Project,
} from "../../types";
import { errorMessage, isOrchestrationActive } from "./orchestration-utils";

const POLL_INTERVAL_MS = 900;

type OrchestrationAction = "create" | "start" | "stop" | "continue" | "delete" | null;

export interface UseOrchestrationResult {
  sessions: OrchestrationSession[];
  /** The Workspace is the navigation parent; it may have no Conversation. */
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  detail: OrchestrationSessionDetail | null;
  loading: boolean;
  detailLoading: boolean;
  action: OrchestrationAction;
  error: string | null;
  clearError: () => void;
  refreshSessions: () => Promise<void>;
  selectWorkspace: (workspaceId: string | null) => void;
  selectSession: (sessionId: string) => void;
  createSession: (input: OrchestrationDraft) => Promise<OrchestrationSession>;
  createConversation: (
    workspaceId: string,
    input: OrchestrationDraft,
  ) => Promise<OrchestrationSession>;
  createWorkspace: (
    input: WorkspaceDraft,
  ) => Promise<{ project: Project; session: OrchestrationSession | null }>;
  startSession: (sessionId?: string) => Promise<void>;
  stopSession: (sessionId?: string) => Promise<void>;
  continueSession: (prompt: string, sessionId?: string) => Promise<void>;
  deleteSession: (sessionId?: string) => Promise<void>;
}

function replaceSession(
  sessions: OrchestrationSession[],
  session: OrchestrationSession,
): OrchestrationSession[] {
  const found = sessions.some((item) => item.id === session.id);
  return found
    ? sessions.map((item) => (item.id === session.id ? session : item))
    : [session, ...sessions];
}

export function useOrchestration(): UseOrchestrationResult {
  const [sessions, setSessions] = useState<OrchestrationSession[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrchestrationSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState<OrchestrationAction>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<number | null>(null);
  const pollInFlightRef = useRef(false);
  const pollGenerationRef = useRef(0);
  const sessionListGenerationRef = useRef(0);
  const selectedWorkspaceRef = useRef<string | null>(null);

  const publishWorkspaceSelection = useCallback((workspaceId: string | null) => {
    selectedWorkspaceRef.current = workspaceId;
    setSelectedWorkspaceId(workspaceId);
  }, []);

  const refreshSessions = useCallback(async () => {
    const requestGeneration = ++sessionListGenerationRef.current;
    setLoading(true);
    try {
      const result = await api.listOrchestrations();
      if (
        !mountedRef.current ||
        requestGeneration !== sessionListGenerationRef.current
      ) {
        return;
      }
      setSessions(result.sessions);
      const preferredWorkspaceId = selectedWorkspaceRef.current;
      setSelectedSessionId((current) => {
        if (current && result.sessions.some((session) => session.id === current)) {
          return current;
        }
        if (preferredWorkspaceId !== null) {
          return result.sessions.find((session) => session.projectId === preferredWorkspaceId)?.id ?? null;
        }
        return result.sessions[0]?.id ?? null;
      });
      if (preferredWorkspaceId === null) {
        publishWorkspaceSelection(result.sessions.find((session) => session.projectId)?.projectId ?? null);
      }
      setError(null);
    } catch (reason) {
      if (
        mountedRef.current &&
        requestGeneration === sessionListGenerationRef.current
      ) {
        setError(errorMessage(reason));
      }
      throw reason;
    } finally {
      if (
        mountedRef.current &&
        requestGeneration === sessionListGenerationRef.current
      ) {
        setLoading(false);
      }
    }
  }, [publishWorkspaceSelection]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshSessions().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
      pollGenerationRef.current += 1;
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!selectedSessionId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let disposed = false;
    setDetail(null);
    setDetailLoading(true);
    void api
      .getOrchestration(selectedSessionId)
      .then((next) => {
        if (!disposed && mountedRef.current) {
          setDetail(next);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!disposed && mountedRef.current) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!disposed && mountedRef.current) setDetailLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [selectedSessionId]);

  useEffect(() => {
    const session = detail?.session;
    if (!session || !isOrchestrationActive(session.status)) return;

    let disposed = false;
    const generation = ++pollGenerationRef.current;
    const poll = async () => {
      if (disposed || !mountedRef.current) return;
      if (pollInFlightRef.current) {
        pollTimerRef.current = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        return;
      }
      pollInFlightRef.current = true;
      try {
        const next = await api.getOrchestration(session.id);
        if (!disposed && mountedRef.current) {
          setDetail(next);
          setSessions((current) => replaceSession(current, next.session));
          setError(null);
        }
      } catch (reason) {
        // Keep the last successful detail/timeline visible while a transient
        // refresh fails, then try again on the next interval.
        if (!disposed && mountedRef.current) setError(errorMessage(reason));
      } finally {
        pollInFlightRef.current = false;
        if (!disposed && mountedRef.current && pollGenerationRef.current === generation) {
          pollTimerRef.current = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    };

    pollTimerRef.current = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      pollGenerationRef.current += 1;
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [detail?.session.id, detail?.session.status]);

  const clearError = useCallback(() => setError(null), []);

  const selectWorkspace = useCallback((workspaceId: string | null) => {
    publishWorkspaceSelection(workspaceId);
    setSelectedSessionId((current) => {
      if (workspaceId === null) return null;
      return sessions.find((session) => session.id === current && session.projectId === workspaceId)?.id ??
        sessions.find((session) => session.projectId === workspaceId)?.id ??
        null;
    });
    setError(null);
  }, [publishWorkspaceSelection, sessions]);

  const selectSession = useCallback((sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    publishWorkspaceSelection(session?.projectId ?? null);
    setSelectedSessionId(sessionId);
    setError(null);
  }, [publishWorkspaceSelection, sessions]);

  const createSession = useCallback(async (input: OrchestrationDraft) => {
    setAction("create");
    try {
      // The client never invents IDs: create the Project first, then bind the
      // Team to it. ProjectService owns membership and workspace allocation.
      const { projectName, ...draft } = input;
      const projectId = projectName?.trim()
        ? (await api.createProject({ name: projectName.trim() })).project.id
        : undefined;
      const result = await api.createOrchestration(
        projectId === undefined ? draft : { ...draft, projectId },
      );
      const nextDetail: OrchestrationSessionDetail = {
        session: result.session,
        turns: [],
        events: [],
        continuationPrompts: [],
      };
      if (mountedRef.current) {
        // A mount-time list request may still be resolving with a snapshot
        // from before this session existed. Invalidate that response before
        // publishing the newly created session and its selection.
        sessionListGenerationRef.current += 1;
        setLoading(false);
        setSessions((current) => replaceSession(current, result.session));
        publishWorkspaceSelection(result.session.projectId ?? null);
        setSelectedSessionId(result.session.id);
        setDetail(nextDetail);
        setError(null);
      }
      return result.session;
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason));
      throw reason;
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [publishWorkspaceSelection]);

  /** Start a Conversation inside an existing Workspace; never create a peer Workspace. */
  const createConversation = useCallback(async (
    workspaceId: string,
    input: OrchestrationDraft,
  ) => {
    const session = await createSession({
      ...input,
      projectId: workspaceId,
      projectName: undefined,
    });
    publishWorkspaceSelection(workspaceId);
    return session;
  }, [createSession, publishWorkspaceSelection]);

  /**
   * Create the persistent Workspace first. An empty task intentionally stops
   * here: no synthetic orchestration or placeholder prompt is written.
   */
  const createWorkspace = useCallback(async (input: WorkspaceDraft) => {
    setAction("create");
    try {
      const projectResult = await api.createProject({
        name: input.name.trim(),
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      });
      const project = projectResult.project;
      const participants = input.participants.map((participant, position) => ({
        ...participant,
        position,
        // The composer normally derives this from the Agent name. Keep the
        // backend contract safe for non-UI callers too.
        role: participant.role.trim() || "Agent",
      }));
      for (const agentId of new Set(participants.map((participant) => participant.agentId))) {
        await api.attachProjectAgent(project.id, agentId);
      }

      let session: OrchestrationSession | null = null;
      if (input.initialTask.trim()) {
        const result = await api.createOrchestration({
          name: input.name.trim(),
          originalPrompt: input.initialTask.trim(),
          participants,
          mode: input.mode,
          projectId: project.id,
          maxSteps: input.maxSteps,
          perAgentTimeoutMs: input.perAgentTimeoutMs,
        });
        session = result.session;
        const started = await api.startOrchestration(session.id);
        session = started.session;
      }

      if (mountedRef.current) {
        sessionListGenerationRef.current += 1;
        setLoading(false);
        if (session) setSessions((current) => replaceSession(current, session!));
        publishWorkspaceSelection(project.id);
        setSelectedSessionId(session?.id ?? null);
        setDetail(
          session
            ? { session, turns: [], events: [], continuationPrompts: [] }
            : null,
        );
        setError(null);
      }
      return { project, session };
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason));
      throw reason;
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [publishWorkspaceSelection]);

  const startSession = useCallback(async (sessionId?: string) => {
    const target = sessionId ?? selectedSessionId;
    if (!target) return;
    setAction("start");
    try {
      const result = await api.startOrchestration(target);
      if (mountedRef.current) {
        setSessions((current) => replaceSession(current, result.session));
        setDetail((current) =>
          current?.session.id === result.session.id
            ? { ...current, session: result.session }
            : current,
        );
        setError(null);
      }
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason));
      throw reason;
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [selectedSessionId]);

  const stopSession = useCallback(async (sessionId?: string) => {
    const target = sessionId ?? selectedSessionId;
    if (!target) return;
    setAction("stop");
    try {
      const result = await api.stopOrchestration(target);
      if (mountedRef.current) {
        setSessions((current) => replaceSession(current, result.session));
        setDetail((current) =>
          current?.session.id === result.session.id
            ? { ...current, session: result.session }
            : current,
        );
        setError(null);
      }
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason));
      throw reason;
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [selectedSessionId]);

  const continueSession = useCallback(async (prompt: string, sessionId?: string) => {
    const target = sessionId ?? selectedSessionId;
    if (!target || !prompt.trim()) return;
    setAction("continue");
    try {
      const result = await api.continueOrchestration(target, { prompt: prompt.trim() });
      if (mountedRef.current) {
        setSessions((current) => replaceSession(current, result.session));
        setSelectedSessionId(result.session.id);
        setDetail((current) =>
          current?.session.id === result.session.id
            ? { ...current, session: result.session }
            : null,
        );
        setError(null);
      }
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason));
      throw reason;
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [selectedSessionId]);

  const deleteSession = useCallback(async (sessionId?: string) => {
    const target = sessionId ?? selectedSessionId;
    if (!target) return;
    const session = sessions.find((item) => item.id === target);
    if (session && isOrchestrationActive(session.status)) {
      const message = "Stop this conversation before deleting it.";
      if (mountedRef.current) setError(message);
      throw new Error(message);
    }
    setAction("delete");
    try {
      await api.deleteOrchestration(target);
      if (mountedRef.current) {
        const remaining = sessions.filter((item) => item.id !== target);
        const workspaceId = session?.projectId ?? selectedWorkspaceRef.current;
        const sibling = workspaceId
          ? remaining.find((item) => item.projectId === workspaceId)
          : undefined;
        const nextSession = sibling ?? (workspaceId ? undefined : remaining[0]);
        sessionListGenerationRef.current += 1;
        setSessions(remaining);
        if (nextSession) {
          publishWorkspaceSelection(nextSession.projectId ?? null);
        } else if (workspaceId) {
          publishWorkspaceSelection(workspaceId);
        } else {
          publishWorkspaceSelection(null);
        }
        setSelectedSessionId((current) => current === target ? (nextSession?.id ?? null) : current);
        setDetail((current) => current?.session.id === target ? null : current);
        setError(null);
      }
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason));
      throw reason;
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [publishWorkspaceSelection, selectedSessionId, sessions]);

  return {
    sessions,
    selectedWorkspaceId,
    selectedSessionId,
    detail,
    loading,
    detailLoading,
    action,
    error,
    clearError,
    refreshSessions,
    selectWorkspace,
    selectSession,
    createSession,
    createConversation,
    createWorkspace,
    startSession,
    stopSession,
    continueSession,
    deleteSession,
  };
}
