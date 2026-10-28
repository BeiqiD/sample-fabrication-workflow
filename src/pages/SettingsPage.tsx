import { Link } from "react-router-dom";
import { usesLocalAuthentication } from "../lib/authentication-client";

export function SettingsPage() {
  const localSession = usesLocalAuthentication();
  return <div className="page settings-overview-page">
    <div className="page-heading"><div><p className="eyebrow">Workspace</p><h1>Settings</h1>
      <p className="lead">Manage research exports, storage and system maintenance.</p></div></div>

    <div className="settings-task-grid">
      <section className="card settings-task-card settings-data-card" aria-labelledby="settings-data-title">
        <h2 className="card-title" id="settings-data-title">Data and export</h2>
        <p>Share research, create an offline copy, or import a native package.</p>
        <div className="settings-data-actions">
          <div className="settings-destination">
            <h3><Link to="/settings/data">Research packages and reports <span aria-hidden="true">→</span></Link></h3>
            <p>Export selected Samples or Projects as a native package or offline report, import a native package, and review saved package work.</p>
          </div>
          <div className="settings-destination">
            <h3><Link to="/export">Content archive <span aria-hidden="true">→</span></Link></h3>
            <p>Build a ZIP in this browser. Leaving its page cancels an active export and releases any prepared download.</p>
          </div>
          <div className="settings-destination">
            <h3><Link to="/settings/import-workbook">Workbook import <span aria-hidden="true">→</span></Link></h3>
            <p>Bring an existing FabuBlox process into Templates, then work with its steps and runs in the web workspace.</p>
          </div>
        </div>
        <p className="settings-task-note">Accepted package and system recovery jobs are saved on the server. Return to their pages to check progress or resume work that needs attention.</p>
      </section>

      <section className="card settings-task-card" aria-labelledby="settings-storage-title">
        <h2 className="card-title" id="settings-storage-title">Storage</h2>
        <p>See where new uploads go and manage storage connections.</p>
        <ul className="settings-destination-list">
          <li><Link to="/settings/storage">Storage overview <span aria-hidden="true">→</span></Link>
            <p>Current upload destinations and registered profiles.</p></li>
          <li><Link to="/settings/storage/configuration">Connections <span aria-hidden="true">→</span></Link>
            <p>Add, test and activate storage candidates.</p></li>
          <li><Link to="/settings/storage/migrations">File migrations <span aria-hidden="true">→</span></Link>
            <p>Review migration plans, execution and saved jobs.</p></li>
        </ul>
        <p className="settings-task-note">Viewing storage status is separate from managing it. Each page checks the permissions required for its actions.</p>
      </section>

      <section className="card settings-task-card" aria-labelledby="settings-system-title">
        <h2 className="card-title" id="settings-system-title">System and maintenance</h2>
        <p>Installation backups, recovery and advanced File operations.</p>
        <ul className="settings-destination-list">
          <li><Link to="/settings/data/system">Backup and recovery <span aria-hidden="true">→</span></Link>
            <p>Administrator-managed backup jobs and isolated system recovery.</p></li>
          <li><Link to="/maintenance/file-evidence">File evidence <span aria-hidden="true">→</span></Link>
            <p>Inspect recorded attachment history and unresolved evidence.</p></li>
          <li className="settings-related-links"><Link to="/maintenance/file-shadow">File shadow pilot</Link>
            <Link to="/maintenance/file-authority">File authority</Link></li>
        </ul>
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
