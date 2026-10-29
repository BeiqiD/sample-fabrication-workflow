import { Link } from "react-router-dom";
import { usesLocalAuthentication } from "../lib/authentication-client";
import { advancedSettingsDestinations, settingsDestinations, settingsGroups } from "../lib/settingsDestinations";

export function SettingsPage() {
  const localSession = usesLocalAuthentication();
  return <div className="page settings-overview-page">
    <div className="page-heading"><div><h1>Settings</h1>
      <p className="lead">Manage research exports, storage and system maintenance.</p></div></div>

    <div className="settings-task-grid">
      <section className="settings-task-card settings-data-card" aria-labelledby="settings-data-title">
        <h2 className="card-title" id="settings-data-title">{settingsGroups[0].label}</h2>
        <p>Share research, create an offline copy, or import a native package.</p>
        <div className="settings-data-actions">
          {settingsGroups[0].destinations.map(destination => <div className="settings-destination" key={destination.to}>
            <h3><Link to={destination.to}>{destination.label} <span aria-hidden="true">→</span></Link></h3>
            <p>{destination.description}</p>
          </div>)}
        </div>
        <p className="settings-task-note">Accepted package and system recovery jobs are saved on the server. Return to their pages to check progress or resume work that needs attention.</p>
      </section>

      <section className="settings-task-card" aria-labelledby="settings-storage-title">
        <h2 className="card-title" id="settings-storage-title">{settingsGroups[1].label}</h2>
        <p>See where new uploads go and manage storage connections.</p>
        <ul className="settings-destination-list">
          {settingsGroups[1].destinations.map(destination => <li key={destination.to}>
            <Link to={destination.to}>{destination.label} <span aria-hidden="true">→</span></Link><p>{destination.description}</p>
          </li>)}
        </ul>
        <p className="settings-task-note">Viewing storage status is separate from managing it. Each page checks the permissions required for its actions.</p>
      </section>

      <section className="settings-task-card" aria-labelledby="settings-system-title">
        <h2 className="card-title" id="settings-system-title">{settingsGroups[2].label}</h2>
        <p>Installation backups, recovery and advanced File operations.</p>
        <ul className="settings-destination-list">
          <li><Link to={settingsDestinations.recovery.to}>{settingsDestinations.recovery.label} <span aria-hidden="true">→</span></Link>
            <p>{settingsDestinations.recovery.description}</p></li>
        </ul>
        <details className="settings-advanced-tools">
          <summary>Advanced maintenance</summary>
          <ul className="settings-destination-list">{advancedSettingsDestinations.map(destination => <li key={destination.to}>
            <Link to={destination.to}>{destination.label} <span aria-hidden="true">→</span></Link>
            {destination.description && <p>{destination.description}</p>}
          </li>)}</ul>
        </details>
        <p className="settings-task-note">System recovery requires system administrator access. File maintenance uses its own File operator permissions; evidence viewing and operator actions have separate access checks.</p>
      </section>
    </div>

    <section className="settings-personal-note" aria-labelledby="settings-personal-title">
      <h2 id="settings-personal-title">{localSession ? "Appearance and session" : "Appearance"}</h2>
      <p>Use the theme control in the top bar to change this browser’s appearance.
        {localSession && " The Sign out control ends your current session."}</p>
    </section>
  </div>;
}
