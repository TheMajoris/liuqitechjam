import type { ReactNode } from "react";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state-block" role="status" aria-live="polite">
      <Spinner label={label} />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-block state-empty">
      <div className="state-glyph" aria-hidden="true">
        ◇
      </div>
      <p className="state-title">{title}</p>
      {hint ? <p className="state-hint">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  status,
  onRetry,
}: {
  message: string;
  status?: number | null;
  onRetry?: () => void;
}) {
  const permissionDenied = status === 401 || status === 403;
  const notReady = status === 404;
  return (
    <div className="state-block state-error" role="alert">
      <div className="state-glyph state-glyph-alert" aria-hidden="true">
        !
      </div>
      <p className="state-title">
        {permissionDenied
          ? "Access denied"
          : notReady
            ? "This surface is not available"
            : "Could not load this view"}
      </p>
      <p className="state-hint">
        {permissionDenied
          ? "Your control-plane token does not grant access to this resource."
          : notReady
            ? "The control plane did not expose this module. It may be disabled in the current profile."
            : message}
      </p>
      {onRetry && !permissionDenied ? (
        <button type="button" className="button button-ghost" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function DegradedBanner({ children }: { children: ReactNode }) {
  return (
    <div className="degraded-banner" role="status">
      <span className="degraded-dot" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="inline-error" role="alert">
      {message}
    </div>
  );
}
