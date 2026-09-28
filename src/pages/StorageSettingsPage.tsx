import { useEffect, useRef, useState } from "react";
import type { StorageSettingsStatus } from "../../shared/contracts/storage-settings";
import { api } from "../lib/api";
import "./storage-settings.css";

const providerName = { r2: "Cloudflare R2", switchdrive: "SWITCHdrive" };
const configurationText = { configured: "Configuration present", missing: "Configuration missing", invalid: "Configuration needs attention" };
const accessText = { read_only: "Read only", read_write: "Read and write", retired: "Retired" };
const matchText = { matched: "Matches current configuration", mismatch: "Different from current configuration", not_configured: "Current configuration missing", invalid_configuration: "Current configuration needs attention" };

export function StorageSettingsPage() {
  const [status, setStatus] = useState<StorageSettingsStatus | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);

  async function refresh() {
    const request = ++sequence.current;
    controller.current?.abort();
    const pending = new AbortController(); controller.current = pending;
    setLoading(true); setError(false); setStatus(null);
    try {
      const value = await api.getStorageSettings(pending.signal);
      if (request === sequence.current && !pending.signal.aborted) setStatus(value);
    } catch {
      if (request === sequence.current && !pending.signal.aborted) setError(true);
    } finally {
      if (request === sequence.current && !pending.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => { sequence.current += 1; controller.current?.abort(); };
  }, []);

  return <div className="page storage-settings-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>Storage</h1>
      <p className="lead">View current upload destinations and registered storage profiles.</p></div>
      <button className="button" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    {loading && <p role="status">Reading storage configuration…</p>}
    {error && <div className="error-banner" role="alert"><p>Storage information is unavailable. Refresh to try again.</p></div>}
    {status && <>
      <div className="storage-settings-observation"><strong>Connection not checked</strong>
        <p className="muted">This page reads saved configuration. Refreshing does not test connectivity or access to stored files. Configuration changes are managed by your deployment.</p></div>

      <section className="card storage-settings-section" aria-labelledby="storage-uploads-title">
        <h2 className="card-title" id="storage-uploads-title">Current uploads</h2>
        <p className="muted">These are the destinations used by the existing upload workflows.</p>
        <div className="storage-upload-grid">
          <article className="storage-upload-destination"><h3>Images and Project attachments</h3>
            <p className="storage-destination-name">{providerName[status.uploadDestinations.ordinaryUploads]}</p>
            <p className="muted">Includes sample images, comment images, Project attachments, template reference images and import assets.</p>
            <p className="storage-configuration-note">{configurationText[status.bindings.r2.configuration]}</p>
          </article>
          <article className="storage-upload-destination"><h3>Original comment files</h3>
            <p className="storage-destination-name">{status.uploadDestinations.commentOriginals === "switchdrive" ? providerName.switchdrive
              : status.uploadDestinations.commentOriginals === "unsupported" ? "Unsupported provider" : "Not configured"}</p>
            <p className="muted">Original files attached to comments use the configured managed storage provider.</p>
            <p className="storage-configuration-note">{configurationText[status.bindings.managed.configuration]}</p>
          </article>
        </div>
      </section>

      <section className="card storage-settings-section" aria-labelledby="storage-profiles-title">
        <div className="storage-section-heading"><h2 className="card-title" id="storage-profiles-title">Registered profiles</h2>
          <span className="section-count" aria-label={`${status.profiles.items.length} profiles shown`}>{status.profiles.items.length}</span></div>
        <p className="muted">Profiles record storage identities and their recorded conversion access. Their access settings do not select the upload destinations above. A configuration match does not confirm connectivity.</p>
        {status.profiles.items.length === 0 ? <p className="muted">No storage profiles have been registered.</p> : <ul className="storage-profile-list">
          {status.profiles.items.map((profile) => <li key={profile.id}>
            <div className="storage-profile-heading"><h3><code>{profile.id}</code></h3><span>{providerName[profile.adapterType]}</span></div>
            <dl><div><dt>Configuration revision</dt><dd>{profile.configurationRevision}</dd></div>
              <div><dt>File conversion access</dt><dd>{accessText[profile.runtimeAccess]}</dd></div>
              <div><dt>Deployment match</dt><dd>{matchText[profile.bindingMatch]}</dd></div></dl>
          </li>)}
        </ul>}
        {status.profiles.hasMore && <p className="muted">Showing the first {status.profiles.limit} profiles. Additional profiles are registered.</p>}
      </section>
      <details className="storage-settings-advanced"><summary>Advanced file maintenance</summary>
        <div><a href="/maintenance/file-evidence">Historical file evidence</a><a href="/maintenance/file-shadow">File conversion maintenance</a></div>
      </details>
    </>}
  </div>;
}
