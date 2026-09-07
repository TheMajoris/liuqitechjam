import { useEffect, useState } from "react";
import { api, type AgentDraft } from "../../api";

interface AgentDraftAssistantProps {
  /** Current form values, so a rewrite improves what is there. */
  name: string;
  description: string;
  instructions: string;
  disabled: boolean;
  /** Applied only when the person presses Use. */
  onApply: (draft: { description?: string; instructions?: string }) => void;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Writing help for the two fields that decide how an Agent behaves.
 *
 * Configuring an Agent asks for a system prompt, which is a skill most people
 * do not have and should not need: the description and instructions are where
 * a first attempt usually goes wrong, and a vague instruction block is why an
 * Agent then does the wrong thing. This turns a sentence of intent into a
 * concrete draft.
 *
 * It is a suggestion, never an action. The draft is shown for review beside
 * what is already in the form, applying it is a separate press, and every
 * field stays editable afterwards. It touches no skill, role, tool, or model:
 * what an Agent is *allowed* to do is decided by the controls below, and no
 * amount of generated prose changes that.
 */
export function AgentDraftAssistant({
  name,
  description,
  instructions,
  disabled,
  onApply,
}: AgentDraftAssistantProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState("");
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .agentDraftAvailable()
      .then((result) => {
        if (!cancelled) setAvailable(result.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing is offered on a server that cannot answer: a button that always
  // fails is worse than no button.
  if (available !== true) return null;

  const ask = async () => {
    const text = intent.trim();
    if (text.length < 3) {
      setError("Describe the Agent in a sentence or two first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDraft(
        (
          await api.draftAgent({
            intent: text,
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
            fields: ["description", "instructions"],
          })
        ).draft,
      );
    } catch (reason) {
      setError(errorMessage(reason));
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-draft" aria-labelledby="agent-draft-heading">
      <div className="agent-draft-head">
        <div>
          <span className="eyebrow">Writing help</span>
          <h4 id="agent-draft-heading">Not sure what to write?</h4>
        </div>
        <button
          type="button"
          className="button button-ghost"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : "Draft it for me"}
        </button>
      </div>

      {open && (
        <div className="agent-draft-body">
          <label className="agent-draft-field">
            <span>Say what you want this Agent to do, in your own words</span>
            <textarea
              rows={3}
              value={intent}
              maxLength={2_000}
              disabled={disabled || busy}
              placeholder="Reviews my pull requests and flags anything that could break in production"
              onChange={(event) => setIntent(event.target.value)}
            />
          </label>

          <div className="agent-draft-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={disabled || busy || intent.trim().length < 3}
              onClick={() => void ask()}
            >
              {busy ? "Drafting…" : draft ? "Try again" : "Write a draft"}
            </button>
            <span className="agent-draft-note">
              A suggestion you can edit. It changes no skill, role, or model.
            </span>
          </div>

          {error && (
            <p className="ws-inline-error" role="alert">
              {error}
            </p>
          )}

          {draft && (
            <div className="agent-draft-result">
              {draft.description && (
                <div className="agent-draft-preview">
                  <span className="eyebrow">Suggested description</span>
                  <p>{draft.description}</p>
                </div>
              )}
              {draft.instructions && (
                <div className="agent-draft-preview">
                  <span className="eyebrow">Suggested instructions</span>
                  <pre>{draft.instructions}</pre>
                </div>
              )}
              <div className="agent-draft-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={disabled}
                  onClick={() => {
                    onApply({
                      ...(draft.description ? { description: draft.description } : {}),
                      ...(draft.instructions ? { instructions: draft.instructions } : {}),
                    });
                    setOpen(false);
                  }}
                >
                  Use this draft
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={disabled}
                  onClick={() => setDraft(null)}
                >
                  Discard
                </button>
                {(description.trim() || instructions.trim()) && (
                  <span className="agent-draft-note">
                    This replaces what is in those two fields.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
