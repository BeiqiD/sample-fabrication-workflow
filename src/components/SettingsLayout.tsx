import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import "../settings.css";

const settingsGroups = [
  { id: "data", label: "Data and export", destinations: [
    { to: "/settings/data", label: "Research packages" },
    { to: "/export", label: "Content archive" },
  ] },
  { id: "storage", label: "Storage", destinations: [
    { to: "/settings/storage", label: "Storage overview" },
    { to: "/settings/storage/configuration", label: "Connections" },
    { to: "/settings/storage/migrations", label: "File migrations" },
  ] },
  { id: "system", label: "System and maintenance", destinations: [
    { to: "/settings/data/system", label: "Backup and recovery" },
    { to: "/maintenance/file-shadow", label: "File shadow pilot" },
    { to: "/maintenance/file-evidence", label: "File evidence" },
    { to: "/maintenance/file-authority", label: "File authority" },
  ] },
];

export function SettingsLayout() {
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const restoreNavigationFocus = useRef(false);
  const path = pathname.replace(/\/+$/, "").toLowerCase();
  const currentLabel = path === "/settings" ? "Overview"
    : settingsGroups.flatMap(group => group.destinations).find(destination => destination.to === path)?.label ?? "Settings";

  useEffect(() => {
    setExpanded(false);
    if (restoreNavigationFocus.current) {
      toggle.current?.focus();
      restoreNavigationFocus.current = false;
    }
  }, [pathname]);

  function closeAfterNavigation(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!window.matchMedia("(max-width: 720px)").matches) return;
    restoreNavigationFocus.current = event.currentTarget.getAttribute("href") !== pathname;
    setExpanded(false);
    toggle.current?.focus();
  }

  return <div className="settings-layout">
    <aside className="settings-sidebar">
      <nav className="settings-navigation" aria-label="Settings navigation">
        <button ref={toggle} type="button" className="settings-navigation-toggle" aria-expanded={expanded}
          aria-controls="settings-navigation-links" onClick={() => setExpanded(value => !value)}>
          <span><span>Settings navigation</span><strong>{currentLabel}</strong></span>
          <span aria-hidden="true">{expanded ? "−" : "+"}</span>
        </button>
        <div id="settings-navigation-links" className="settings-navigation-panel" data-expanded={expanded}>
        <Link className="settings-overview-link" to="/settings" aria-current={path === "/settings" ? "page" : undefined}
          onClick={closeAfterNavigation}>Overview</Link>
        <div className="settings-navigation-groups">
          {settingsGroups.map(group => <section className="settings-navigation-group" key={group.id}
            aria-labelledby={`settings-navigation-${group.id}`}>
            <h2 id={`settings-navigation-${group.id}`}>{group.label}</h2>
            <ul>{group.destinations.map(destination => <li key={destination.to}>
              <Link to={destination.to} aria-current={path === destination.to ? "page" : undefined}
                onClick={closeAfterNavigation}>{destination.label}</Link>
            </li>)}</ul>
          </section>)}
        </div>
        </div>
      </nav>
    </aside>
    <div className="settings-content"><Outlet /></div>
  </div>;
}
