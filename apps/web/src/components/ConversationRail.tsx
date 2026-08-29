import { useEffect, useRef, useState } from "react";
import type { AgentConversation } from "../types";

/**
 * The Agent's private conversations.
 *
 * They nest under their Agent in the sidebar and appear only for the Agent
 * currently open, so the sidebar stays a list of Agents rather than a flat list
 * of every thread. Every conversation here shares that Agent's single
 * workspace — only the message history and the Codex session are per-conversation.
 */
export function ConversationRail({
  conversations,
  selectedId,
  open,
  busy,
  onToggleOpen,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  conversations: AgentConversation[];
  selectedId: string | null;
  open: boolean;
  busy: boolean;
  onToggleOpen: () => void;
  onSelect: (conversationId: string) => void;
  onCreate: () => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<AgentConversation | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) renameInput.current?.focus();
  }, [renamingId]);

  // A click anywhere else closes the compact menu, the way a real menu behaves.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuFor]);

  const commitRename = (conversation: AgentConversation) => {
    const next = draftTitle.trim();
    setRenamingId(null);
    if (next && next !== conversation.title) onRename(conversation.id, next);
  };

  return (
    <div className="conversation-rail">
      <div className="conversation-rail-head">
        <button
          type="button"
          className="conversation-disclosure"
          aria-expanded={open}
          aria-controls="agent-conversation-list"
          onClick={onToggleOpen}
        >
          <span className={"disclosure " + (open ? "is-open" : "")} aria-hidden="true">
            ▸
          </span>
          Conversations
          <span className="conversation-count">{conversations.length}</span>
        </button>
        <button
          type="button"
          className="conversation-new"
          onClick={onCreate}
          disabled={busy}
          aria-label="New conversation"
          title="New conversation"
        >
          <span aria-hidden="true">＋</span>
        </button>
      </div>

      {!open ? null : (
      <nav
        className="conversation-list"
        id="agent-conversation-list"
        aria-label="Conversations with this Agent"
      >
        {conversations.length === 0 && (
          <p className="conversation-empty">No conversations yet.</p>
        )}
        {conversations.map((conversation) => (
          <div
            className={
              "conversation-row " + (conversation.id === selectedId ? "is-selected" : "")
            }
            key={conversation.id}
          >
            {renamingId === conversation.id ? (
              <input
                ref={renameInput}
                className="conversation-rename"
                defaultValue={conversation.title}
                maxLength={80}
                aria-label={"Rename " + conversation.title}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={() => commitRename(conversation)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename(conversation);
                  }
                  if (event.key === "Escape") setRenamingId(null);
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="conversation-select"
                  aria-current={conversation.id === selectedId ? "true" : undefined}
                  onClick={() => onSelect(conversation.id)}
                >
                  {conversation.title}
                </button>
                <button
                  type="button"
                  className="conversation-menu-button"
                  aria-label={"Actions for " + conversation.title}
                  aria-expanded={menuFor === conversation.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuFor((current) =>
                      current === conversation.id ? null : conversation.id,
                    );
                  }}
                >
                  <span aria-hidden="true">···</span>
                </button>
              </>
            )}

            {menuFor === conversation.id && (
              <div className="conversation-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setDraftTitle(conversation.title);
                    setRenamingId(conversation.id);
                    setMenuFor(null);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  onClick={() => {
                    setConfirmDelete(conversation);
                    setMenuFor(null);
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </nav>
      )}

      {confirmDelete && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setConfirmDelete(null)}
          role="presentation"
        >
          <div
            className="modal conversation-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="conversation-delete-heading"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="conversation-delete-heading">
              Delete &ldquo;{confirmDelete.title}&rdquo;?
            </h2>
            {/* Saying this plainly matters: the files are the valuable part. */}
            <p>
              This deletes this conversation and its message history. The Agent and its
              workspace files will not be deleted.
            </p>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={() => {
                  onDelete(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                Delete conversation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
