import { useEffect, useRef, useState } from "react";
import type { CurrentStorageSettings, CurrentStorageSettingsStatus } from "../../shared/contracts/current-storage-settings";
import { api } from "../lib/api";
import { storageConfigurationClient } from "../lib/storage-configuration-client";
import { StorageRoleDefaultsForm } from "./StorageRoleDefaultsForm";
import "./storage-settings.css";

const providerName = { r2: "Cloudflare R2", switchdrive: "SWITCHdrive", s3: "S3" };
const configurationText = { configured: "Configuration present", missing: "Configuration missing", invalid: "Configuration needs attention" };
const accessText = { read_only: "Read only", read_write: "Read and write", retired: "Retired" };
const matchText = { matched: "Matches current configuration", mismatch: "Different from current configuration", not_configured: "Current configuration missing", invalid_configuration: "Current configuration needs attention", registered: "Registered" };

export function StorageSettingsPage() {
  const [status, setStatus] = useState<CurrentStorageSettings | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);

  async function refresh() {
    const request = ++sequence.current;
    controller.current?.abort();
    const pending = new AbortController(); controller.current = pending;
    setLoading(true); setError(false); setStatus(null);
    try {
      const value = await api.getCurrentStorageSettings(pending.signal);
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
    <p><a href="/settings/data">Data packages, reports and import</a></p>
    {loading && <p role="status">Reading storage configuration…</p>}
    {error && <div className="error-banner" role="alert"><p>Storage information is unavailable. Refresh to try again.</p></div>}
    {status?.version === 3 && <CurrentStorageSettingsView status={status} onChanged={() => void refresh()} />}
    {status?.version === 2 && <>
      <div className="storage-settings-observation"><strong>Connection not checked</strong>
        <p className="muted">This page reads saved configuration. Refreshing does not test connectivity or access to stored files. Active configuration is managed by your deployment.</p></div>

      <section className="card storage-settings-section" aria-labelledby="storage-uploads-title">
        <h2 className="card-title" id="storage-uploads-title">Current uploads</h2>
        <p className="muted">These destinations apply to new uploads. Existing files keep their recorded storage location.</p>
        {status.roleDefaults.state === "pending_bootstrap" && <p className="muted">Cloudflare R2 is selected for new uploads. This choice will be saved with the first file upload.</p>}
        <div className="storage-upload-grid">
          <article className="storage-upload-destination"><h3>Images and Project attachments</h3>
            <p className="storage-destination-name">{providerName[status.uploadDestinations.ordinaryUploads]}</p>
            <p className="muted">Includes sample images, comment images, Project attachments, template reference images and import assets.</p>
            <p className="storage-configuration-note">{configurationText[status.bindings.r2.configuration]}</p>
          </article>
          <article className="storage-upload-destination"><h3>Original comment files</h3>
            <p className="storage-destination-name">{status.uploadDestinations.commentOriginals === "r2" ? providerName.r2
              : status.uploadDestinations.commentOriginals === "switchdrive" ? providerName.switchdrive
              : status.uploadDestinations.commentOriginals === "unsupported" ? "Unsupported provider" : "Not configured"}</p>
            <p className="muted">Original files attached to comments are stored without modification, up to 100 MB per file.</p>
            <p className="storage-configuration-note">{configurationText[status.uploadDestinations.commentOriginals === "r2"
              ? status.bindings.r2.configuration : status.bindings.managed.configuration]}</p>
          </article>
        </div>
      </section>

      <section className="card storage-settings-section" aria-labelledby="storage-profiles-title">
        <div className="storage-section-heading"><h2 className="card-title" id="storage-profiles-title">Registered profiles</h2>
          <span className="section-count" aria-label={`${status.profiles.items.length} profiles shown`}>{status.profiles.items.length}</span></div>
        <p className="muted">Profiles record storage locations and their access settings. Registration or a configuration match does not confirm file access or connectivity.</p>
        {status.profiles.items.length === 0 ? <p className="muted">No storage profiles have been registered.</p> : <ul className="storage-profile-list">
          {status.profiles.items.map((profile) => <li key={profile.id}>
            <div className="storage-profile-heading"><h3><code>{profile.id}</code></h3><span>{providerName[profile.adapterType]}</span></div>
            <dl><div><dt>Configuration revision</dt><dd>{profile.configurationRevision}</dd></div>
              <div><dt>{profile.adapterType === "s3" ? "Access setting" : "File access"}</dt><dd>{accessText[profile.runtimeAccess]}</dd></div>
              <div><dt>{profile.adapterType === "s3" ? "Registration" : "Deployment match"}</dt><dd>{matchText[profile.bindingMatch]}</dd></div></dl>
            {profile.adapterType === "s3" && <p className="muted">File access is not available for this registered profile. Current upload destinations are unchanged.</p>}
          </li>)}
        </ul>}
        {status.profiles.hasMore && <p className="muted">Showing the first {status.profiles.limit} profiles. Additional profiles are registered.</p>}
      </section>
      <p><a href="/settings/storage/configuration">Manage storage candidates</a></p>
      <details className="storage-settings-advanced"><summary>Advanced file maintenance</summary>
        <div><a href="/maintenance/file-evidence">Historical file evidence</a><a href="/maintenance/file-shadow">File conversion maintenance</a>
          <a href="/maintenance/file-authority">File authority maintenance</a></div>
      </details>
    </>}
  </div>;
}

function CurrentStorageSettingsView({ status, onChanged }: { status: CurrentStorageSettingsStatus; onChanged: () => void }) {
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    void storageConfigurationClient.capability(request.signal).then(value => { if (!request.signal.aborted) setCanManage(value.canManage); })
      .catch(() => { if (!request.signal.aborted) setCanManage(false); });
    return () => request.abort();
  }, []);
  const destinations = [
    { title: "Images and Project attachments", role: status.roleDefaults.internal,
      description: "Includes sample images, comment images, Project attachments, template reference images and import assets." },
    { title: "Original comment files", role: status.roleDefaults.originals,
      description: "Original files attached to comments are stored without modification, up to 100 MB per file." },
  ];
  const availabilityText = { available: "Available in the current configuration", unavailable: "Unavailable in the current configuration", registered: "Registered; activation required", retired: "Retired" };
  return <>
    <div className="storage-settings-observation"><strong>Connection not checked</strong>
      <p className="muted">This page reads saved choices and local credential availability. Refreshing does not test provider connectivity or stored files.</p></div>
    <section className="card storage-settings-section" aria-labelledby="storage-uploads-title">
      <h2 className="card-title" id="storage-uploads-title">Current uploads</h2>
      <p className="muted">These destinations apply to new uploads. Existing files keep their recorded storage location.</p>
      {status.roleDefaults.state === "pending_bootstrap" && <p className="muted">Cloudflare R2 is selected for new uploads. This choice will be saved with the first file upload.</p>}
      {status.authority.fileAccess === "paused" && status.authority.mode === "active" && <p role="status">File access is paused. Saved destinations are retained.</p>}
      <div className="storage-upload-grid">{destinations.map((destination, index) => <article key={destination.title} className="storage-upload-destination">
        <h3>{destination.title}</h3><p className="storage-destination-name">{destination.role ? providerName[destination.role.adapterType]
          : status.roleDefaults.state === "legacy" && index === 1 ? status.bindings.managed.provider === "switchdrive" ? providerName.switchdrive : "Not configured" : providerName.r2}</p>
        {destination.role && <p><code>{destination.role.profileId}</code></p>}
        <p className="muted">{destination.description}</p>
        <p className="storage-configuration-note">{destination.role ? availabilityText[destination.role.availability]
          : configurationText[status.roleDefaults.state === "legacy" && index === 1 ? status.bindings.managed.configuration : status.bindings.r2.configuration]}</p>
        {destination.role?.availability === "unavailable" && <p className="muted">New uploads cannot use this selected profile until its configuration is restored or an administrator selects another available profile.</p>}
      </article>)}</div>
    </section>
    <StorageRoleDefaultsForm status={status} canManage={canManage} onChanged={onChanged} onForbidden={() => setCanManage(false)} />
    <section className="card storage-settings-section" aria-labelledby="storage-profiles-title">
      <div className="storage-section-heading"><h2 className="card-title" id="storage-profiles-title">Registered profiles</h2>
        <span className="section-count">{status.profiles.items.length}</span></div>
      <p className="muted">Availability describes local configuration and credentials. It does not confirm provider connectivity.</p>
      {status.profiles.items.length === 0 ? <p className="muted">No storage profiles have been registered.</p> : <ul className="storage-profile-list">
        {status.profiles.items.map(profile => <li key={profile.id}>
          <div className="storage-profile-heading"><h3><code>{profile.id}</code></h3><span>{providerName[profile.adapterType]}</span></div>
          <dl><div><dt>Configuration revision</dt><dd>{profile.configurationRevision}</dd></div>
            <div><dt>Access setting</dt><dd>{accessText[profile.runtimeAccess]}</dd></div>
            <div><dt>Availability</dt><dd>{availabilityText[profile.availability]}</dd></div>
            {profile.bindingRevision !== null && <div><dt>Activation revision</dt><dd>{profile.bindingRevision}</dd></div>}</dl>
          {profile.availability === "registered" && <p className="muted">Activate this profile from its tested storage candidate before selecting it for new uploads.</p>}
        </li>)}</ul>}
      {status.profiles.hasMore && <p className="muted">Showing the first {status.profiles.limit} profiles. Additional profiles are registered.</p>}
    </section>
    <p><a href="/settings/storage/configuration">Manage storage candidates and activation</a></p>
    <details className="storage-settings-advanced"><summary>Advanced file maintenance</summary><div>
      <a href="/maintenance/file-evidence">Historical file evidence</a><a href="/maintenance/file-shadow">File conversion maintenance</a>
      <a href="/maintenance/file-authority">File authority maintenance</a></div></details>
  </>;
}
