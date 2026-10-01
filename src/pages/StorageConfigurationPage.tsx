import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SaveStorageCandidateInput, StorageCandidate, StorageConfigurationStatus } from "../../shared/contracts/storage-configuration";
import { storageConfigurationClient, StorageConfigurationRequestError, type StorageConfigurationCapability } from "../lib/storage-configuration-client";
import "./storage-settings.css";

type Provider = "s3" | "webdav" | "switchdrive";
const names: Record<Provider, string> = { s3: "S3 compatible", webdav: "WebDAV", switchdrive: "SWITCHdrive" };
const blank = { label: "", provider: "s3" as Provider, endpoint: "", bucket: "", region: "", root: "", forcePathStyle: true,
  accessKeyId: "", secretAccessKey: "", sessionToken: "", username: "", password: "" };

export function StorageConfigurationPage() {
  const [capability, setCapability] = useState<StorageConfigurationCapability | null>(null);
  const [status, setStatus] = useState<StorageConfigurationStatus | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [form, setForm] = useState(blank), [editing, setEditing] = useState<StorageCandidate | null>(null);
  const [replaceCredentials, setReplaceCredentials] = useState(true), [uncertainSave, setUncertainSave] = useState(false);
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);
  function resetEditor() { setForm(blank); setEditing(null); setReplaceCredentials(true); }
  async function refresh() {
    const current = ++sequence.current;
    controller.current?.abort(); const pending = new AbortController(); controller.current = pending;
    setLoading(true); setError(""); setCapability(null); setStatus(null);
    // Credentials are intentionally never retained across refreshes.
    resetEditor();
    try {
      const permission = await storageConfigurationClient.capability(pending.signal);
      const result = permission.canManage ? await storageConfigurationClient.read(pending.signal) : null;
      if (current !== sequence.current || pending.signal.aborted) return;
      setCapability(permission); setStatus(result); setUncertainSave(false);
    } catch {
      if (current === sequence.current && !pending.signal.aborted) setError("Storage configuration is unavailable. Refresh to try again.");
    } finally {
      if (current === sequence.current && !pending.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => { void refresh(); return () => { sequence.current += 1; controller.current?.abort(); }; }, []);
  function edit(candidate: StorageCandidate) {
    const namespace = candidate.namespace;
    setEditing(candidate); setReplaceCredentials(false); setNotice(""); setError("");
    setForm({ ...blank, label: candidate.label, provider: namespace.kind, endpoint: namespace.endpoint, root: namespace.root,
      ...(namespace.kind === "s3" ? { bucket: namespace.bucket, region: namespace.region, forcePathStyle: namespace.forcePathStyle } : {}) });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (saving || uncertainSave || !capability?.credentialEditingAvailable) return;
    const namespace = form.provider === "s3" ? { kind: "s3" as const, endpoint: form.endpoint, bucket: form.bucket, region: form.region,
      root: form.root, forcePathStyle: form.forcePathStyle } : { kind: form.provider, endpoint: form.endpoint, root: form.root };
    const credentials: SaveStorageCandidateInput["credentials"] = replaceCredentials ? { mode: "replace", value: form.provider === "s3"
      ? { accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey, ...(form.sessionToken ? { sessionToken: form.sessionToken } : {}) }
      : { username: form.username, password: form.password } } : { mode: "retain" };
    const input: SaveStorageCandidateInput = { ...(editing ? { profileId: editing.profileId } : {}), expectedRevision: editing?.revision ?? null,
      label: form.label, namespace, credentials };
    setSaving(true); setError(""); setNotice("");
    try {
      await storageConfigurationClient.save(input);
      resetEditor();
      // A successful commit is shown even if the subsequent metadata read fails.
      setNotice("Candidate saved as a draft. Current upload destinations are unchanged.");
      try { setStatus(await storageConfigurationClient.read()); }
      catch { setError("Draft saved. Refresh to read the latest candidates."); setUncertainSave(true); }
    } catch (failure) {
      // Clear entered credentials after every attempt; never echo server details.
      setForm(current => ({ ...current, accessKeyId: "", secretAccessKey: "", sessionToken: "", username: "", password: "" }));
      if (failure instanceof StorageConfigurationRequestError && failure.status === 400) setError("The candidate is invalid. Check its storage address and configuration, then enter credentials again.");
      else if (failure instanceof StorageConfigurationRequestError && failure.status === 409) {
        setError("This candidate changed. Refresh before saving a new revision."); setUncertainSave(true);
      } else if (failure instanceof StorageConfigurationRequestError && failure.status === 403) {
        setError("System administrator access is required. Refresh to check your access."); setUncertainSave(true);
      } else {
        setError("The save result is unavailable. Refresh saved candidates before trying again."); setUncertainSave(true);
      }
    } finally { setSaving(false); }
  }
  const set = (name: keyof typeof blank, value: string | boolean) => setForm(current => ({ ...current, [name]: value }));
  const externalEditing = capability?.credentialEditingAvailable && status?.credentialEditingAvailable;
  return <div className="page storage-settings-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>Storage configuration</h1>
      <p className="lead">Save external storage candidates for later testing and activation.</p></div>
      <button className="button" type="button" disabled={loading || saving} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    <p><a href="/settings/storage">Current storage settings</a></p>
    {loading && <p role="status">Reading configuration access…</p>}
    {error && <div className="error-banner" role="alert"><p>{error}</p></div>}
    {notice && <p role="status">{notice}</p>}
    {capability && !capability.canManage && <section className="card storage-settings-section"><h2 className="card-title">Read only</h2>
      <p>Only system administrators can manage storage candidates. Current Cloudflare R2 storage does not require external credentials.</p></section>}
    {capability?.canManage && status && <>
      <div className="storage-settings-observation"><strong>Saved drafts only</strong>
        <p className="muted">Saving does not test the connection, activate a provider or change upload destinations. Current Cloudflare R2 storage does not require external credentials.</p></div>
      {!externalEditing && <p className="muted">External credential editing is unavailable. An administrator must configure the installation encryption key before saving external candidates.</p>}
      <section className="card storage-settings-section" aria-labelledby="storage-candidates-title"><h2 className="card-title" id="storage-candidates-title">Saved candidates</h2>
        {status.candidates.items.length === 0 ? <p className="muted">No external storage candidates have been saved.</p> : <ul className="storage-profile-list">
          {status.candidates.items.map(candidate => <li key={candidate.profileId}>
            <div className="storage-profile-heading"><h3>{candidate.label}</h3><span>{names[candidate.namespace.kind]} · Draft · Revision {candidate.revision}</span></div>
            <dl><div><dt>Storage address</dt><dd>{candidate.namespace.endpoint}{candidate.namespace.kind === "s3" ? ` / ${candidate.namespace.bucket}` : ""}</dd></div>
              <div><dt>Root folder</dt><dd>{candidate.namespace.root || "/"}</dd></div><div><dt>Credentials</dt><dd>{candidate.credentials.status === "configured" ? "Configured" : "Unavailable"}</dd></div></dl>
            {externalEditing && <button className="button" type="button" disabled={saving || uncertainSave} onClick={() => edit(candidate)}>Edit {candidate.label}</button>}
          </li>)}
        </ul>}
        {status.candidates.hasMore && <p className="muted">Additional saved candidates are not shown.</p>}
      </section>
      {externalEditing && <section className="card storage-settings-section" aria-labelledby="storage-editor-title"><h2 className="card-title" id="storage-editor-title">{editing ? "New candidate revision" : "New candidate"}</h2>
        <form className="storage-candidate-form" onSubmit={event => void save(event)} autoComplete="off">
          <fieldset disabled={saving || uncertainSave}><div className="storage-candidate-fields">
            <label>Name<input required maxLength={120} value={form.label} onChange={event => set("label", event.target.value)} /></label>
            <label>Provider<select value={form.provider} disabled={!!editing} onChange={event => setForm({ ...blank, label: form.label, provider: event.target.value as Provider })}>
              <option value="s3">S3 compatible</option><option value="webdav">WebDAV</option><option value="switchdrive">SWITCHdrive</option></select></label>
            <label>HTTPS endpoint<input required type="url" disabled={!!editing} value={form.endpoint} onChange={event => set("endpoint", event.target.value)} placeholder="https://storage.example.org" /></label>
            <label>Root folder<input disabled={!!editing} value={form.root} onChange={event => set("root", event.target.value)} /></label>
            {form.provider === "s3" && <><label>Bucket<input required disabled={!!editing} value={form.bucket} onChange={event => set("bucket", event.target.value)} /></label>
              <label>Region<input required value={form.region} onChange={event => set("region", event.target.value)} /></label>
              <label className="storage-candidate-checkbox"><input type="checkbox" checked={form.forcePathStyle} onChange={event => set("forcePathStyle", event.target.checked)} />Use path style requests</label></>}
          </div>
          {editing && <><p className="muted">This creates revision {editing.revision + 1}. To use a different storage address, add a new candidate.</p>
            <label className="storage-candidate-checkbox"><input type="checkbox" checked={replaceCredentials} onChange={event => setReplaceCredentials(event.target.checked)} />Replace credentials</label></>}
          {replaceCredentials && <div className="storage-candidate-fields storage-candidate-credentials">
            {form.provider === "s3" ? <><label>Access key ID<input required value={form.accessKeyId} onChange={event => set("accessKeyId", event.target.value)} autoComplete="off" /></label>
              <label>Secret access key<input required type="password" value={form.secretAccessKey} onChange={event => set("secretAccessKey", event.target.value)} autoComplete="new-password" /></label>
              <label>Session token (optional)<input type="password" value={form.sessionToken} onChange={event => set("sessionToken", event.target.value)} autoComplete="new-password" /></label></>
              : <><label>Username<input required value={form.username} onChange={event => set("username", event.target.value)} autoComplete="off" /></label>
                <label>Password<input required type="password" value={form.password} onChange={event => set("password", event.target.value)} autoComplete="new-password" /></label></>}
          </div>}
          <p className="muted">Credentials are encrypted when saved. Saved credentials cannot be displayed or exported here.</p>
          <div className="storage-candidate-actions"><button className="button primary" type="submit" disabled={saving || uncertainSave}>{saving ? "Saving…" : "Save draft"}</button>
            {editing && <button className="button" type="button" onClick={resetEditor}>Cancel edit</button>}</div>
          </fieldset>
        </form>
      </section>}
    </>}
  </div>;
}
