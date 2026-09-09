import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type {
  Agent,
  AgentRole,
  OrchestrationParticipant,
  OrchestrationSessionDetail,
  OrchestrationTurn,
  ProjectMembership,
  ProjectRole,
  ToolApproval,
} from "../../types";
import { transitions, variants } from "../../motion/motion-tokens";
import { MarkdownMessage } from "../MarkdownMessage";
import { ToolApprovalPrompt } from "../approvals/ToolApprovalPrompt";
import type { OrchestrationAction } from "./use-orchestration";
import { StickyComposer } from "../StickyComposer";
import { AgentAvatar } from "./AgentAvatar";
import {
  agentName,
  checkpointForTurn,
  formatDateTime,
  humanizeFailure,
  isOrchestrationActive,
  turnStatusLabel,
  turnStepNumber,
} from "./orchestration-utils";

interface OrchestrationConversationProps {
  detail: OrchestrationSessionDetail | null;
  agents: Agent[];
  /** Named capability roles, used to label who is speaking and in what job. */
  roles?: AgentRole[];
  /**
   * Project membership tiers. A capability role and a membership tier are
   * different things and can disagree — membership is what actually decides
   * whether a tool call is authorized — so both are shown.
   */
  memberships?: readonly ProjectMembership[];
  action?: OrchestrationAction;
  onContinue?: (prompt: string, sessionId: string) => void;
  /** Re-runs one failed recorded turn against the files as they are now. */
  onRetry?: (fromStepIndex: number) => void;
  /** Restores the source files to a turn's checkpoint and resumes after it. */
  onRecover?: (checkpointId: string) => void;
  /** Prompt-policy edit; omitted hides the control. */
  onClarifyFirstChange?: ((clarifyFirst: boolean) => void) | undefined;
  /** Live approval projections shown beside this Conversation's composer. */
  approvals?: readonly ToolApproval[];
  approvalPendingId?: string | null;
  approvalPendingAction?: "approve" | "reject" | null;
  approvalErrors?: Readonly<Record<string, string>>;
  onApprovalDecision?: (approvalId: string, approved: boolean) => void;
}

const UNFINISHED: OrchestrationTurn["status"][] = ["failed", "cancelled", "timed_out"];

/**
 * How a message joins the transcript.
 *
 * Every bubble shares this, so a follow-up the reader typed and a reply an
 * Agent produced arrive the same way. A turn that is still working keeps its
 * key when it completes, so the typing indicator becomes the reply in place
 * instead of one message leaving and another arriving.
 */
const chatItemMotion = {
  variants: variants.rise,
  initial: "initial",
  animate: "animate",
  exit: "exit",
  transition: transitions.base,
} as const;
function roleName(
  agents: Agent[],
  roles: AgentRole[],
  agentId: string,
): string | undefined {
  const globalRoleId = agents.find((agent) => agent.id === agentId)?.globalRoleId;
  if (!globalRoleId) return undefined;
  return roles.find((role) => role.id === globalRoleId)?.name.trim() || undefined;
}

const MEMBERSHIP_LABEL: Record<ProjectRole, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};

/**
 * The Agent's tier in this Project.
 *
 * Deliberately separate from `roleName` above: that reads the Agent's global
 * capability template, which is only a label. This is the tier the server
 * authorizes tool calls against, so an Agent whose capability role is named
 * "Owner" can still be an `editor` here and be refused.
 */
function membershipRole(
  memberships: readonly ProjectMembership[],
  agentId: string,
): ProjectRole | undefined {
  return memberships.find((membership) => membership.agentId === agentId)?.role;
}

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
  roles = [],
  memberships = [],
  action = null,
  onContinue,
  onRetry,
  onRecover,
  onClarifyFirstChange,
  approvals = [],
  approvalPendingId = null,
  approvalPendingAction = null,
  approvalErrors = {},
  onApprovalDecision,
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

  // Whoever is mid-turn, so the composer can say why it is locked.
  const workingParticipant = session.participants.find(
    (participant) => participant.id === session.currentParticipantId,
  );
  const workingName = workingParticipant
    ? agentName(agents, workingParticipant.agentId)
    : null;
  // Drafts accept their first task through the same anchored composer. The
  // owner routes that first message through the draft-start lifecycle call;
  // only active runs and in-flight actions lock the field.
  const composerLocked = active || action !== null;
  const retryPending = action === "retry";
  const retryBlocked = active;
  const retryDisabled = retryBlocked || action !== null;
  const recoverPending = action === "recover";
  const recoverBlocked = active;
  const recoverDisabled = recoverBlocked || action !== null;

  return (
    <div className="orch-chat-pane">
      <div className="orch-chat-scroll">
        <section className="orch-chat" aria-labelledby="orch-conversation-heading">
          <h2 className="orch-sr-only" id="orch-conversation-heading">Conversation</h2>
          <ol className="orch-chat-list" aria-label="Task and Agent replies in order">
            {session.originalPrompt.trim() && (
              <li className="orch-chat-item orch-chat-item-user">
                <div className="orch-chat-bubble">
                  <div className="orch-chat-topline">
                    <strong>You</strong>
                    <time dateTime={session.createdAt}>{formatDateTime(session.createdAt)}</time>
                  </div>
                  <p className="orch-chat-text">{session.originalPrompt}</p>
                </div>
              </li>
            )}

            {/* `initial={false}` matters: opening a finished conversation must
            show its record at once, not replay forty turns arriving. Only
            what actually appears while the reader is watching animates.
            Keyed by session because that skip applies to a presence group's
            first render only — without it, switching conversations would
            animate every old turn out while every new one arrived. */}
            <AnimatePresence initial={false} key={session.id}>
              {entries.map((entry) => {
                if (entry.kind === "prompt") {
                  return (
                    <motion.li
                      className="orch-chat-item orch-chat-item-user"
                      key={entry.prompt.id}
                      {...chatItemMotion}
                    >
                      <div className="orch-chat-bubble">
                        <div className="orch-chat-topline">
                          <strong>You</strong>
                          <time dateTime={entry.prompt.createdAt}>{formatDateTime(entry.prompt.createdAt)}</time>
                        </div>
                        <p className="orch-chat-text">{entry.prompt.prompt}</p>
                      </div>
                    </motion.li>
                  );
                }

                const { turn, step } = entry;
                const name = agentName(agents, turn.agentId);
                const focus = roleName(agents, roles, turn.agentId);
                const membership = membershipRole(memberships, turn.agentId);
                const timestamp = entry.timestamp;
                const unfinished = UNFINISHED.includes(turn.status);
                const checkpoint = turn.status === "completed"
                  ? checkpointForTurn(detail, turn)
                  : undefined;

                if (turn.status === "dispatched") {
                  return (
                    <motion.li className="orch-chat-item" key={turn.id} {...chatItemMotion}>
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
                    </motion.li>
                  );
                }

                return (
                  <motion.li className="orch-chat-item" key={turn.id} {...chatItemMotion}>
                    <AgentAvatar agentId={turn.agentId} name={name} />
                    <div className={`orch-chat-bubble ${unfinished ? "is-unfinished" : ""}`}>
                      <div className="orch-chat-topline">
                        <strong>
                          {name}
                          {focus && focus !== name && (
                            <span className="orch-chat-focus" title={`Capability role: ${focus}`}>
                              {focus}
                            </span>
                          )}
                          {membership && (
                            <span
                              className="orch-chat-membership"
                              title={`Project membership: ${MEMBERSHIP_LABEL[membership]}. This tier decides which tools this Agent may run.`}
                            >
                              {MEMBERSHIP_LABEL[membership]}
                            </span>
                          )}
                        </strong>
                        <span className="orch-chat-meta">
                          <span className="orch-chat-turn">Turn {step}</span>
                          {checkpoint && (
                            <span
                              className="orch-checkpoint-badge"
                              title={`Workspace checkpoint #${checkpoint.ordinal}, saved after this turn`}
                            >
                              Checkpoint #{checkpoint.ordinal}
                            </span>
                          )}
                          <time dateTime={timestamp}>{formatDateTime(timestamp)}</time>
                        </span>
                      </div>
                      {unfinished ? (
                        <p className="orch-chat-unfinished">
                          {turnStatusLabel(turn.status)} —{" "}
                          {humanizeFailure(turn.errorCode, turn.safeOutput, turn.modelId)}
                        </p>
                      ) : turn.safeOutput ? (
                        <MarkdownMessage className="orch-chat-text" content={turn.safeOutput} />
                      ) : (
                        <p className="orch-chat-text">
                          This Agent finished without leaving a reply.
                        </p>
                      )}
                      {turn.outputTruncated && !unfinished && (
                        <p className="orch-chat-truncated">Reply shortened before it was passed on.</p>
                      )}
                      {(turn.status === "failed" || turn.status === "timed_out") &&
                        turn.stepIndex !== undefined &&
                        onRetry && (
                          <div className="orch-chat-retry">
                            <button
                              type="button"
                              className="orch-chat-retry-action"
                              disabled={retryDisabled}
                              onClick={() => onRetry(turn.stepIndex as number)}
                            >
                              {retryPending ? "Retrying…" : "Retry from this turn (current files)"}
                            </button>
                            <p className="orch-chat-retry-note" role={retryPending ? "status" : undefined}>
                              {retryBlocked
                                ? "Stop the conversation before retrying it."
                                : retryPending
                                  ? "Retrying this Agent turn using the current files…"
                                  : action !== null
                                    ? "Wait for the current action to finish."
                                    : "This reruns the Agent turn using the current files and continues from there. Earlier turns stay in the record. Shared Workspace files are not rolled back."}
                            </p>
                          </div>
                        )}
                      {checkpoint?.recoverable && onRecover && (
                        <div className="orch-chat-retry orch-chat-restore">
                          <button
                            type="button"
                            className="orch-chat-retry-action"
                            disabled={recoverDisabled}
                            onClick={() => onRecover(checkpoint.checkpointId)}
                          >
                            {recoverPending ? "Restoring…" : `Restore after ${name} and resume`}
                          </button>
                          <p className="orch-chat-retry-note" role={recoverPending ? "status" : undefined}>
                            {recoverBlocked
                              ? "Stop the conversation before restoring its files."
                              : recoverPending
                                ? "Saving a safety checkpoint, then restoring the source files…"
                                : action !== null
                                  ? "Wait for the current action to finish."
                                  : "Source files go back to how they were after this turn; a safety checkpoint of the current files is saved first, and the next Agent starts with fresh Project context."}
                          </p>
                        </div>
                      )}
                    </div>
                  </motion.li>
                );
              })}

              {pending && (
                <motion.li className="orch-chat-item" key="pending" {...chatItemMotion}>
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
                </motion.li>
              )}
            </AnimatePresence>
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

          <div ref={bottomRef} aria-hidden="true" />
        </section>
      </div>

      {/*
        The composer stays mounted while the Team runs so the pane does not
        reflow mid-turn; it is disabled rather than removed, and a follow-up
        continues this same Team and shared Workspace.
      */}
      {onContinue && (
        <ToolApprovalPrompt
          approvals={approvals}
          getAgentName={(agentId) => agentName(agents, agentId)}
          runLabel={session.name}
          pendingDecisionId={approvalPendingId}
          pendingDecision={approvalPendingAction}
          decisionErrors={approvalErrors}
          onDecision={onApprovalDecision}
          className="tool-approval-prompt-orchestration"
        />
      )}

      {onContinue && (
        <StickyComposer
          value={followUp}
          placeholder={
            session.status === "draft"
              ? "Type the first task to start this conversation…"
              : "Ask the team to keep going…"
          }
          hint={
            session.status === "draft"
              ? "Enter to start · Shift + Enter for newline"
              : active
                ? (workingName ?? "The team") + " is working…"
                : "Enter to send · Shift + Enter for newline"
          }
          disabled={composerLocked}
          sending={action === "continue" || action === "start"}
          accessory={
            onClarifyFirstChange ? (
              // Beside Send because it is a property of the message being
              // sent — how the team should treat this task — not a property of
              // the conversation's identity, which is what the header states.
              <button
                type="button"
                className={
                  "composer-toggle" + (session.clarifyFirst ? " is-on" : "")
                }
                aria-pressed={session.clarifyFirst === true}
                // Editing mid-cycle would change the rules inside a run the
                // transcript already records, so it waits for the run to settle.
                disabled={active || action !== null}
                title={
                  active
                    ? "Stop the conversation to change this"
                    : "Agents ask questions until the task is unambiguous before they change anything. Applies from the next turn."
                }
                onClick={() => onClarifyFirstChange(session.clarifyFirst !== true)}
              >
                <span aria-hidden="true">?</span>
                Clarify first
              </button>
            ) : null
          }
          onChange={setFollowUp}
          onSubmit={(event) => {
            event.preventDefault();
            if (!followUp.trim() || composerLocked) return;
            onContinue(followUp, session.id);
            setFollowUp("");
          }}
        />
      )}
    </div>
  );
}
