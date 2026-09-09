import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { transitions, variants } from "../motion/motion-tokens";

export interface ConfirmRequest {
  /** Short sentence naming what is about to happen. */
  title: string;
  /** What it costs and what survives it. Shown under the title. */
  body?: string;
  /** Label of the button that carries out the action. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get the danger treatment; the default is neutral. */
  tone?: "danger" | "primary";
  onConfirm: () => void;
}

interface ConfirmDialogProps {
  request: ConfirmRequest | null;
  onClose: () => void;
}

/**
 * The product's own confirmation, replacing `window.confirm`.
 *
 * The browser dialog stated the app's own words in the browser's chrome, gave
 * no room to say what a delete actually costs, and could not be styled or
 * tested. This is the same guard with the product's voice: Escape and the
 * backdrop cancel, focus starts on Cancel so a stray Enter is never a delete,
 * and focus is returned to whatever opened it.
 */
export function ConfirmDialog({ request, onClose }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!request) return;
    openerRef.current = document.activeElement;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose, request]);

  const tone = request?.tone ?? "danger";

  return (
    // A confirmation is the one dialog that must not blink out: dismissing it
    // and confirming it look identical if both vanish in a frame, and the
    // reader is left unsure which one they just did.
    <AnimatePresence>
      {request && (
        <motion.div
          className="modal-backdrop confirm-backdrop"
          onMouseDown={onClose}
          role="presentation"
          variants={variants.fade}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={transitions.fast}
        >
          <motion.div
            className="modal confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby={request.body ? "confirm-body" : undefined}
            onMouseDown={(event) => event.stopPropagation()}
            variants={variants.modal}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={transitions.base}
          >
            <div className="confirm-head">
              <span className={"confirm-glyph is-" + tone} aria-hidden="true">
                {tone === "danger" ? "!" : "?"}
              </span>
              <div>
                <h2 id="confirm-title">{request.title}</h2>
                {request.body && <p id="confirm-body">{request.body}</p>}
              </div>
            </div>
            <div className="modal-footer confirm-footer">
              <button
                type="button"
                ref={cancelRef}
                className="button button-ghost"
                onClick={onClose}
              >
                {request.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={
                  "button " + (tone === "danger" ? "button-danger" : "button-primary")
                }
                onClick={() => {
                  request.onConfirm();
                  onClose();
                }}
              >
                {request.confirmLabel ?? "Delete"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type ConfirmFn = (request: ConfirmRequest) => void;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * One dialog for the whole shell.
 *
 * Confirmation is asked for from the sidebar, the run header, the Agent page
 * and the roles editor. A context keeps that one modal — and one set of focus
 * and Escape rules — instead of four copies threaded through props.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const confirm = useCallback<ConfirmFn>((next) => setRequest(next), []);
  const close = useCallback(() => setRequest(null), []);
  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <ConfirmDialog request={request} onClose={close} />
    </ConfirmContext.Provider>
  );
}

/**
 * Ask before doing something that cannot be undone.
 *
 * Outside a provider this falls back to `window.confirm` rather than throwing,
 * so a component rendered in isolation (a test, a storybook-style harness)
 * still guards the action instead of silently performing it.
 */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  return (
    confirm ??
    ((request) => {
      const lines = [request.title, request.body].filter(Boolean).join("\n\n");
      if (window.confirm(lines)) request.onConfirm();
    })
  );
}
