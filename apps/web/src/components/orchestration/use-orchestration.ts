import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import {
  type OrchestrationDraft,
  type WorkspaceDraft,
} from "./orchestration-utils";
import type {
  OrchestrationSession,
  OrchestrationSessionDetail,
  Project,
} from "../../types";
import { errorMessage, isOrchestrationActive, isRecoveryPending } from "./orchestration-utils";

const POLL_INTERVAL_MS = 900;

/** The single in-flight lifecycle request, shared by every view that shows it. */
export type OrchestrationAction =
  | "create"
  | "start"
  | "stop"
  | "continue"
  | "retry"
  | "recover"
  | "delete"
  | null;

/**
 * A response the server definitely produced. A 2xx or a 4xx settles the
 * request either way; a network failure or a 5xx leaves it uncertain, and the
 * same request ID must be reused so a resend cannot start a second restore.
 */
function isDefinitiveResponse(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status >= 400 && reason.status < 500;
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 layout from Math.random, for hosts without crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

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
  /** Report a failure the caller composed itself, in the same banner. */
  noteError: (message: string) => void;
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
  startSession: (sessionId?: string, prompt?: string) => Promise<void>;
  stopSession: (sessionId?: string) => Promise<void>;
  continueSession: (prompt: string, sessionId?: string) => Promise<void>;
  retryFromStep: (fromStepIndex: number, sessionId?: string) => Promise<void>;
  /**
   * Restore the Project's source files to one checkpoint and resume the
   * remaining participants. Only the durable `detail.recovery.stage` says
   * whether it worked; an accepted request is not a finished one.
   */
  recoverFromCheckpoint: (checkpointId: string, sessionId?: string) => Promise<void>;
  /** Carry on a recovery that stalled after its restore step. */
  resumeRecovery: (operationId: string, sessionId?: string) => Promise<void>;
  /** Put the files back to the safety checkpoint a stalled recovery saved. */
  restoreSafety: (operationId: string, sessionId?: string) => Promise<void>;
  /** Prompt-policy edit for the open Conversation. Grants nothing. */
  setClarifyFirst: (clarifyFirst: boolean, sessionId?: string) => Promise<void>;
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
  // React state updates land after the click handler returns. Keep a ref as
  // the immediate guard so two same-tick clicks cannot enqueue two retries.
  const retryInFlightRef = useRef(false);
  const recoverInFlightRef = useRef(false);
  // One request ID per confirmed recovery action, keyed by what it acts on.
  // It outlives a failed transport so a retry replays the same request rather
  // than asking the server for a second restore.
  const recoveryRequestIdsRef = useRef(new Map<string, string>());

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
    if (!session) return;
    // A restore-and-resume runs on the server between two sessions statuses,
    // so the poll follows the durable operation as well as the run itself.
    const recoveryPending = isRecoveryPending(detail?.recovery?.stage);
    if (!isOrchestrationActive(session.status) && !recoveryPending) return;

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
  }, [detail?.session.id, detail?.session.status, detail?.recovery?.stage]);

  /**
   * Turn "ask before acting" on or off for one Conversation.
   *
   * Applied optimistically because the server is the only writer and the call
   * is a single field: the toggle flips at once and reverts if the write is
   * refused, rather than sitting unresponsive for a round trip.
   */
  const setClarifyFirst = useCallback(async (
    clarifyFirst: boolean,
    sessionId?: string,
  ) => {
    const target = sessionId ?? selectedSessionId;
    if (!target) return;
    const patch = (session: OrchestrationSession): OrchestrationSession =>
      session.id === target ? { ...session, clarifyFirst } : session;
    setSessions((current) => current.map(patch));
    setDetail((current) =>
      current?.session.id === target
        ? { ...current, session: patch(current.session) }
        : current,
    );
    try {
      const result = await api.updateOrchestration(target, { clarifyFirst });
      if (!mountedRef.current) return;
      setSessions((current) => replaceSession(current, result.session));
      setDetail((current) =>
        current?.session.id === result.session.id
          ? { ...current, session: result.session }
          : current,
      );
      setError(null);
    } catch (reason) {
      if (!mountedRef.current) return;
      const revert = (session: OrchestrationSession): OrchestrationSession =>
        session.id === target ? { ...session, clarifyFirst: !clarifyFirst } : session;
      setSessions((current) => current.map(revert));
      setDetail((current) =>
        current?.session.id === target
          ? { ...current, session: revert(current.session) }
          : current,
      );
      setError(errorMessage(reason));
    }
  }, [selectedSessionId]);

  const clearError = useCallback(() => setError(null), []);
  const noteError = useCallback((message: string) => setError(message), []);

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
          ...(input.clarifyFirst ? { clarifyFirst: true } : {}),
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

  const startSession = useCallback(async (sessionId?: string, prompt?: string) => {
    const target = sessionId ?? selectedSessionId;
    if (!target) return;
    setAction("start");
    try {
      const result = await api.startOrchestration(target, prompt?.trim() || undefined);
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
    const selectedSession =
      detail?.session.id === target
        ? detail.session
        : sessions.find((session) => session.id === target);
    if (selectedSession?.status === "draft") {
      await startSession(target, prompt);
      return;
    }
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
  }, [detail, selectedSessionId, sessions, startSession]);

  /**
   * Re-run one recorded step. The accepted session is followed by an immediate
   * detail read, and the active-session poll keeps the journal current while
   * the new turns are appended.
   */
  const retryFromStep = useCallback(
    async (fromStepIndex: number, sessionId?: string) => {
      const target = sessionId ?? selectedSessionId;
      if (!target || retryInFlightRef.current) return;
      retryInFlightRef.current = true;
      setAction("retry");
      try {
        const result = await api.retryOrchestration(target, fromStepIndex);
        // The retry route is accepted asynchronously. Fetch the detail again
        // before publishing the accepted session so the view does not keep a
        // stale terminal transcript while the new child Run is being created.
        // If this read is transiently unavailable, the active-session poll
        // below still has the accepted status and will recover the journal.
        const acceptedDetail = await api.getOrchestration(target).catch(() => null);
        if (mountedRef.current) {
          setSessions((current) => replaceSession(current, result.session));
          setSelectedSessionId(result.session.id);
          setDetail((current) =>
            acceptedDetail ??
              (current?.session.id === result.session.id
                ? { ...current, session: result.session }
                : null),
          );
          setError(null);
        }
      } catch (reason) {
        if (mountedRef.current) setError(errorMessage(reason));
        throw reason;
      } finally {
        retryInFlightRef.current = false;
        if (mountedRef.current) setAction(null);
      }
    },
    [selectedSessionId],
  );

  /**
   * Shared shape of the three recovery calls. The server answers 202 with the
   * operation record, which is only an acceptance: the detail is re-read at
   * once so the recovery panel shows the durable stage, and the poll (which
   * now also follows pending recovery stages) carries it to settlement.
   */
  const runRecoveryAction = useCallback(
    async (
      target: string,
      requestKey: string,
      send: (requestId: string) => Promise<unknown>,
    ) => {
      if (recoverInFlightRef.current) return;
      recoverInFlightRef.current = true;
      setAction("recover");
      const ids = recoveryRequestIdsRef.current;
      const requestId = ids.get(requestKey) ?? newRequestId();
      ids.set(requestKey, requestId);
      try {
        await send(requestId);
        ids.delete(requestKey);
        const acceptedDetail = await api.getOrchestration(target).catch(() => null);
        if (mountedRef.current && acceptedDetail) {
          setSessions((current) => replaceSession(current, acceptedDetail.session));
          setDetail((current) =>
            current === null || current.session.id === acceptedDetail.session.id
              ? acceptedDetail
              : current,
          );
          setError(null);
        }
      } catch (reason) {
        // A rejection the server produced is final for this request ID; a lost
        // connection or a 5xx is not, and the next attempt replays the same ID.
        if (isDefinitiveResponse(reason)) ids.delete(requestKey);
        if (mountedRef.current) setError(errorMessage(reason));
        throw reason;
      } finally {
        recoverInFlightRef.current = false;
        if (mountedRef.current) setAction(null);
      }
    },
    [],
  );

  const recoverFromCheckpoint = useCallback(
    async (checkpointId: string, sessionId?: string) => {
      const target = sessionId ?? selectedSessionId;
      if (!target) return;
      await runRecoveryAction(
        target,
        `recover:${target}:${checkpointId}`,
        (requestId) =>
          api.recoverOrchestration(target, {
            checkpointId,
            requestId,
            acknowledgeSourceRestore: true,
          }),
      );
    },
    [runRecoveryAction, selectedSessionId],
  );

  const resumeRecovery = useCallback(
    async (operationId: string, sessionId?: string) => {
      const target = sessionId ?? selectedSessionId;
      if (!target) return;
      await runRecoveryAction(
        target,
        `resume:${target}:${operationId}`,
        (requestId) => api.resumeWorkspaceRecovery(target, operationId, { requestId }),
      );
    },
    [runRecoveryAction, selectedSessionId],
  );

  const restoreSafety = useCallback(
    async (operationId: string, sessionId?: string) => {
      const target = sessionId ?? selectedSessionId;
      if (!target) return;
      await runRecoveryAction(
        target,
        `safety:${target}:${operationId}`,
        (requestId) =>
          api.restoreWorkspaceSafety(target, operationId, {
            requestId,
            acknowledgeSourceRestore: true,
          }),
      );
    },
    [runRecoveryAction, selectedSessionId],
  );

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
    noteError,
    refreshSessions,
    selectWorkspace,
    selectSession,
    createSession,
    createConversation,
    createWorkspace,
    startSession,
    stopSession,
    continueSession,
    retryFromStep,
    recoverFromCheckpoint,
    resumeRecovery,
    restoreSafety,
    setClarifyFirst,
    deleteSession,
  };
}
