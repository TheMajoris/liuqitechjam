import { NavLink, Outlet } from "react-router-dom";
import type { SystemInfo } from "../api/contracts";
import { NAV_DESTINATIONS } from "./navigation";

export function AppShell({ system }: { system: SystemInfo | null }) {
  const runtimeLabel = system
    ? system.runtimeProvider === "container"
      ? `Container runtime · ${system.containerEngine ?? "engine"}`
      : "Local process runtime"
    : "Runtime status pending";

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <aside className="rail" aria-label="Primary">
        <div className="rail-brand" title="Secretless Control Plane">
          <span className="rail-brand-mark" aria-hidden="true">
            ⛨
          </span>
          <span className="rail-brand-text">
            <strong>Control Plane</strong>
            <span>Kill Switch track</span>
          </span>
        </div>

        <nav className="rail-nav">
          <ul>
            {NAV_DESTINATIONS.map((dest) => (
              <li key={dest.to}>
                <NavLink
                  to={dest.to}
                  className={({ isActive }) =>
                    `rail-link${isActive ? " is-active" : ""}`
                  }
                  title={dest.hint}
                >
                  <span className="rail-link-glyph" aria-hidden="true">
                    {dest.glyph}
                  </span>
                  <span className="rail-link-label">{dest.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="rail-foot">
          <span className="rail-foot-dot" aria-hidden="true" />
          <span>{runtimeLabel}</span>
        </div>
      </aside>

      <main className="main" id="main-content" tabIndex={-1}>
        <Outlet context={system} />
      </main>
    </div>
  );
}
