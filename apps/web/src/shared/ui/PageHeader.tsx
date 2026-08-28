import { useEffect } from "react";
import type { ReactNode } from "react";

/**
 * Renders the single <h1> for a route and syncs document.title. Every routed
 * page must render exactly one of these.
 */
export function PageHeader({
  title,
  lead,
  actions,
  meta,
}: {
  title: string;
  lead?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Control Plane`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {lead ? <p>{lead}</p> : null}
        {meta}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
