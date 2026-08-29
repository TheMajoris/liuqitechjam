import { useLayoutEffect, useRef } from "react";

const MAX_COMPOSER_HEIGHT = 200;

/**
 * ChatGPT-style composer anchored to the bottom of the conversation pane.
 *
 * It is a flex sibling of the scroll region rather than a fixed-position
 * element, so it stays put while messages scroll and keeps its alignment when
 * the Preview sidecar opens and narrows the pane.
 */
export function StickyComposer({
  value,
  placeholder,
  hint,
  disabled,
  sending,
  onChange,
  onSubmit,
}: {
  value: string;
  placeholder: string;
  hint: string;
  disabled: boolean;
  sending: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to a cap, then let the textarea scroll internally so a long
  // prompt can never swallow the conversation.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    const next = Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT);
    element.style.height = next + "px";
    element.style.overflowY = element.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [value]);

  const canSend = !disabled && !sending && value.trim().length > 0;

  return (
    <div className="composer-dock">
      <form className="composer" onSubmit={onSubmit}>
        <div className="composer-surface">
          <textarea
            ref={textarea}
            className="composer-input"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            aria-label="Message the Agent"
          />
          <button
            type="submit"
            className="send-button"
            disabled={!canSend}
            aria-label={sending ? "Agent is working" : "Send message"}
          >
            <span aria-hidden="true">{sending ? "…" : "↑"}</span>
          </button>
        </div>
      </form>
      <p className="composer-hint">{hint}</p>
    </div>
  );
}
