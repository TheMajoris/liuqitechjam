import { useEffect, useRef, useState } from "react";
import type {
  Agent,
  OrchestrationParticipant,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "../../types";
import { AgentAvatar } from "./AgentAvatar";
import {
  agentName,
  formatDateTime,
  humanizeFailure,
  isOrchestrationActive,
  turnStatusLabel,
  turnStepNumber,
} from "./orchestration-utils";

interface OrchestrationConversationProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  action?: "create" | "start" | "stop" | "continue" | "delete" | null;
  onContinue?: (prompt: string, sessionId: string) => void;
}

const UNFINISHED: OrchestrationTurn["status"][] = ["failed", "cancelled", "timed_out"];

function closingNote(detail: OrchestrationSessionDetail): string | null {
  const { session } = detail;
  switch (session.status) {
    case "completed":
      return "Conversation completed.";
    case "stopped":
      return "Conversation stopped.";
    case "interrupted":
      return "The service restarted before this conversation finished.";
    case "failed":
      return humanizeFailure(session.errorCode, session.errorMessage);
    default:
      return null;
  }
}

export function OrchestrationConversation({
  detail,
  agents,
  action = null,
  onContinue,
}: OrchestrationConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [followUp, setFollowUp] = useState("");
  const turns = detail?.turns ?? [];
  const continuationPrompts = detail?.continuationPrompts ?? [];
  const session = detail?.session ?? null;
  const active = session ? isOrchestrationActive(session.status) : false;

  useEffect(() => {
    if (!active) return;
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, turns.length, continuationPrompts.length]);

  const participants = new Map<string, OrchestrationParticipant>(
    session?.participants.map((participant) => [participant.id, participant]) ?? [],
  );

  const ordered = turns
    .map((turn, index) => ({ turn, step: turnStepNumber(turn, index) }))
    .sort((left, right) => left.step - right.step);

  const entries = [
    ...ordered.map(({ turn, step }, index) => ({
      kind: "turn" as const,
      turn,
      step,
      timestamp: turn.completedAt ?? turn.createdAt,
      order: index,
    })),
    ...continuationPrompts.map((prompt, index) => ({
      kind: "prompt" as const,
      prompt,
      timestamp: prompt.createdAt,
      order: index,
    })),
  ].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp) || left.order - right.order,
  );

  const hasDispatched = ordered.some(({ turn }) => turn.status === "dispatched");
  const pending =
    active && !hasDispatched && session?.currentParticipantId
      ? participants.get(session.currentParticipantId)
      : undefined;

  if (!session) {
    return (
      <section className="orch-chat" aria-labelledby="orch-conversation-heading">
        <h2 className="orch-sr-only" id="orch-conversation-heading">Conversation</h2>
        <div className="orch-chat-empty" role="status">
          <span className="orch-empty-glyph" aria-hidden="true">◎</span>
          <strong>Nothing to read yet</strong>
          <span>Pick or create a conversation to see how the Agents work through it.</span>
        </div>
      </section>
    );
  }

  const note = closingNote(detail!);
  const canContinue = !active && session.status !== "draft" && onContinue;

  return (
    <section className="orch-chat" aria-labelledby="orch-conversation-heading">
      <h2 className="orch-sr-only" id="orch-conversation-heading">Conversation</h2>
      <ol className="orch-chat-list" aria-label="Task and Agent replies in order">
        <li className="orch-chat-item orch-chat-item-user">
          <div className="orch-chat-bubble">
            <div className="orch-chat-topline">
              <strong>You</strong>
              <time dateTime={session.createdAt}>{formatDateTime(session.createdAt)}</time>
            </div>
            <p className="orch-chat-text">{session.originalPrompt}</p>
          </div>
        </li>

        {entries.map((entry) => {
          if (entry.kind === "prompt") {
            return (
              <li className="orch-chat-item orch-chat-item-user" key={entry.prompt.id}>
                <div className="orch-chat-bubble">
                  <div className="orch-chat-topline">
                    <strong>You</strong>
                    <time dateTime={entry.prompt.createdAt}>{formatDateTime(entry.prompt.createdAt)}</time>
                  </div>
                  <p className="orch-chat-text">{entry.prompt.prompt}</p>
                </div>
              </li>
            );
          }

          const { turn, step } = entry;
          const participant = participants.get(turn.participantId);
          const name = agentName(agents, turn.agentId);
          const focus = participant?.role.trim();
          const timestamp = entry.timestamp;
          const unfinished = UNFINISHED.includes(turn.status);

          if (turn.status === "dispatched") {
            return (
              <li className="orch-chat-item" key={turn.id}>
                <AgentAvatar agentId={turn.agentId} name={name} />
                <div className="orch-chat-bubble is-typing">
                  <div className="orch-chat-topline">
                    <strong>{name}</strong>
                    <span className="orch-chat-turn">Turn {step}</span>
                  </div>
                  <p className="orch-chat-typing" role="status">
                    <span aria-hidden="true" />
                    <span aria-hidden="true" />
                    <span aria-hidden="true" />
                    <span className="orch-sr-only">{name} is working on its turn</span>
                  </p>
                </div>
              </li>
            );
          }

          return (
            <li className="orch-chat-item" key={turn.id}>
              <AgentAvatar agentId={turn.agentId} name={name} />
              <div className={`orch-chat-bubble ${unfinished ? "is-unfinished" : ""}`}>
                <div className="orch-chat-topline">
                  <strong>
                    {name}
                    {focus && focus !== name && (
                      <span className="orch-chat-focus">{focus}</span>
                    )}
                  </strong>
                  <span className="orch-chat-meta">
                    <span className="orch-chat-turn">Turn {step}</span>
                    <time dateTime={timestamp}>{formatDateTime(timestamp)}</time>
                  </span>
                </div>
                {unfinished ? (
                  <p className="orch-chat-unfinished">
                    {turnStatusLabel(turn.status)} —{" "}
                    {humanizeFailure(turn.errorCode, turn.safeOutput)}
                  </p>
                ) : (
                  <p className="orch-chat-text">
                    {turn.safeOutput || "This Agent finished without leaving a reply."}
                  </p>
                )}
                {turn.outputTruncated && !unfinished && (
                  <p className="orch-chat-truncated">Reply shortened before it was passed on.</p>
                )}
              </div>
            </li>
          );
        })}

        {pending && (
          <li className="orch-chat-item" key="pending">
            <AgentAvatar
              agentId={pending.agentId}
              name={agentName(agents, pending.agentId)}
            />
            <div className="orch-chat-bubble is-typing">
              <div className="orch-chat-topline">
                <strong>{agentName(agents, pending.agentId)}</strong>
              </div>
              <p className="orch-chat-typing" role="status">
                <span aria-hidden="true" />
                <span aria-hidden="true" />
                <span aria-hidden="true" />
                <span className="orch-sr-only">
                  {agentName(agents, pending.agentId)} is about to speak
                </span>
              </p>
            </div>
          </li>
        )}
      </ol>

      {ordered.length === 0 && !active && session.status === "draft" && (
        <p className="orch-chat-hint" role="status">
          Start the conversation and the first Agent&apos;s reply lands here.
        </p>
      )}

      {note && (
        <p
          className={`orch-chat-note ${session.status === "failed" ? "is-failure" : ""}`}
          role="status"
        >
          {note}
        </p>
      )}

      {canContinue && (
        <form
          className="orch-follow-up"
          onSubmit={(event) => {
            event.preventDefault();
            if (!followUp.trim() || action !== null) return;
            onContinue(followUp, session.id);
            setFollowUp("");
          }}
        >
          <label htmlFor="orch-follow-up-input">Continue this conversation</label>
          <textarea
            id="orch-follow-up-input"
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            placeholder="Ask the team to keep going…"
            rows={2}
            disabled={action !== null}
          />
          <button type="submit" className="orch-button orch-button-primary" disabled={!followUp.trim() || action !== null}>
            {action === "continue" ? "Continuing…" : "Continue"}
          </button>
        </form>
      )}

      <div ref={bottomRef} aria-hidden="true" />
    </section>
  );
}
