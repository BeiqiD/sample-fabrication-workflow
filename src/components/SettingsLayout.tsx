import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { advancedSettingsDestinations, settingsDestinations, settingsGroups } from "../lib/settingsDestinations";
import { ActionIcon } from "./ActionIcon";
import "../settings.css";

export function SettingsLayout() {
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const restoreNavigationFocus = useRef(false);
  const path = pathname.replace(/\/+$/, "").toLowerCase();
  const activeAdvanced = advancedSettingsDestinations.find(destination => destination.to === path);
  const [advancedExpanded, setAdvancedExpanded] = useState(Boolean(activeAdvanced));
  const currentLabel = path === "/settings" ? "Overview"
    : Object.values(settingsDestinations).find(destination => destination.to === path)?.label ?? "Settings";

  useEffect(() => {
    setExpanded(false);
    if (activeAdvanced) setAdvancedExpanded(true);
    if (restoreNavigationFocus.current) {
      toggle.current?.focus();
      restoreNavigationFocus.current = false;
    }
  }, [pathname, activeAdvanced]);

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
          <ActionIcon name="chevron-down" />
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
          {group.id === "system" && <div className="settings-advanced-navigation">
            <details open={advancedExpanded} onToggle={event => setAdvancedExpanded(event.currentTarget.open)}>
              <summary>Advanced maintenance</summary>
              <ul>{advancedSettingsDestinations.filter(destination => advancedExpanded || destination.to !== path).map(destination => <li key={destination.to}>
                <Link to={destination.to} aria-current={advancedExpanded && path === destination.to ? "page" : undefined}
                  onClick={closeAfterNavigation}>{destination.label}</Link>
              </li>)}</ul>
            </details>
            {!advancedExpanded && activeAdvanced && <Link to={activeAdvanced.to} aria-current="page" onClick={closeAfterNavigation}>{activeAdvanced.label}</Link>}
          </div>}
          </section>)}
        </div>
        </div>
      </nav>
    </aside>
    <div className="settings-content"><Outlet /></div>
  </div>;
}
