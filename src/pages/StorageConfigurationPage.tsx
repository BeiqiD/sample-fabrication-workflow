import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SaveStorageCandidateInput, StorageCandidate, StorageConfigurationStatus } from "../../shared/contracts/storage-configuration";
import { checkedStartStorageCandidateCheckInput, MAX_STORAGE_CANDIDATE_CHECKS, type StartStorageCandidateCheckInput, type StorageCandidateCheck,
  type StorageCandidateCheckList, type StorageCandidateCheckStage } from "../../shared/contracts/storage-candidate-check";
import { storageConfigurationClient, StorageConfigurationRequestError, type StorageConfigurationCapability } from "../lib/storage-configuration-client";
import { StorageCredentialEncryption } from "./StorageCredentialEncryption";
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
  function accessDenied() {
    sequence.current += 1; controller.current?.abort(); resetEditor(); setStatus(null);
    setCapability({ canManage: false, credentialEditingAvailable: false }); setLoading(false); setSaving(false);
    setError("System administrator access is required. Refresh to check your access.");
  }
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
    } catch (failure) {
      if (current === sequence.current && failure instanceof StorageConfigurationRequestError && failure.status === 403) { accessDenied(); return; }
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
    const current = sequence.current, signal = controller.current?.signal;
    setSaving(true); setError(""); setNotice("");
    try {
      await storageConfigurationClient.save(input, signal);
      if (current !== sequence.current || signal?.aborted) return;
      resetEditor();
      // A successful commit is shown even if the subsequent metadata read fails.
      setNotice("Candidate saved as a draft. Current upload destinations are unchanged.");
      try {
        const latest = await storageConfigurationClient.read(signal);
        if (current === sequence.current && !signal?.aborted) setStatus(latest);
      } catch (failure) {
        if (current !== sequence.current || signal?.aborted) return;
        if (failure instanceof StorageConfigurationRequestError && failure.status === 403) { accessDenied(); return; }
        setError("Draft saved. Refresh to read the latest candidates."); setUncertainSave(true);
      }
    } catch (failure) {
      if (current !== sequence.current || signal?.aborted) return;
      // Clear entered credentials after every attempt; never echo server details.
      setForm(current => ({ ...current, accessKeyId: "", secretAccessKey: "", sessionToken: "", username: "", password: "" }));
      if (failure instanceof StorageConfigurationRequestError && failure.status === 400) setError("The candidate is invalid. Check its storage address and configuration, then enter credentials again.");
      else if (failure instanceof StorageConfigurationRequestError && failure.status === 409) {
        setError("This candidate changed. Refresh before saving a new revision."); setUncertainSave(true);
      } else if (failure instanceof StorageConfigurationRequestError && failure.status === 403) {
        accessDenied(); setUncertainSave(true);
      } else {
        setError("The save result is unavailable. Refresh saved candidates before trying again."); setUncertainSave(true);
      }
    } finally { if (current === sequence.current) setSaving(false); }
  }
  const set = (name: keyof typeof blank, value: string | boolean) => setForm(current => ({ ...current, [name]: value }));
  const externalEditing = capability?.credentialEditingAvailable && status?.credentialEditingAvailable;
  return <div className="page storage-settings-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>Storage configuration</h1>
      <p className="lead">Save storage candidates, test S3 connections and maintain credential encryption.</p></div>
      <button className="button" type="button" disabled={loading || saving} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    <p><a href="/settings/storage">Current storage settings</a></p>
    {loading && <p role="status">Reading configuration access…</p>}
    {error && <div className="error-banner" role="alert"><p>{error}</p></div>}
    {notice && <p role="status">{notice}</p>}
    {capability && !capability.canManage && <section className="card storage-settings-section"><h2 className="card-title">Read only</h2>
      <p>Only system administrators can manage storage candidates. Current Cloudflare R2 storage does not require external credentials.</p></section>}
    {capability?.canManage && status && <>
      <div className="storage-settings-observation"><strong>Candidate storage</strong>
        <p className="muted">Saving does not test the connection, activate a provider or change upload destinations. Current Cloudflare R2 storage does not require external credentials.</p></div>
      {!externalEditing && <p className="muted">External credential editing is unavailable. An administrator must configure the installation encryption key before saving external candidates.</p>}
      <section className="card storage-settings-section" aria-labelledby="storage-candidates-title"><h2 className="card-title" id="storage-candidates-title">Saved candidates</h2>
        {status.candidates.items.length === 0 ? <p className="muted">No external storage candidates have been saved.</p> : <ul className="storage-profile-list">
          {status.candidates.items.map(candidate => <li key={candidate.profileId}>
            <div className="storage-profile-heading"><h3>{candidate.label}</h3><span>{names[candidate.namespace.kind]} · Draft · Revision {candidate.revision}</span></div>
            <dl><div><dt>Storage address</dt><dd>{candidate.namespace.endpoint}{candidate.namespace.kind === "s3" ? ` / ${candidate.namespace.bucket}` : ""}</dd></div>
              <div><dt>Root folder</dt><dd>{candidate.namespace.root || "/"}</dd></div><div><dt>Credentials</dt><dd>{candidate.credentials.status === "configured" ? "Configured" : "Unavailable"}</dd></div></dl>
            {externalEditing && <button className="button" type="button" disabled={saving || uncertainSave} onClick={() => edit(candidate)}>Edit {candidate.label}</button>}
            <CandidateChecks candidate={candidate} canTest={!!externalEditing && candidate.credentials.status === "configured" && !saving && !uncertainSave}
              canCleanup={!saving && !uncertainSave}
              onForbidden={accessDenied} />
            <StorageCredentialEncryption candidate={candidate} canUpdate={!!externalEditing && !saving && !uncertainSave} onForbidden={accessDenied} />
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

const stepNames: Record<StorageCandidateCheckStage, string> = { pending: "Waiting", passed: "Passed", failed: "Failed", unknown: "Unconfirmed", not_run: "Not run" };
const resultNames: Record<StorageCandidateCheck["status"], string> = { running: "Running", succeeded: "Passed", failed: "Failed", interrupted: "Interrupted" };
const cleanupNames: Record<StorageCandidateCheck["cleanup"], string> = { pending: "Waiting", running: "Cleaning up", required: "Needs cleanup",
  confirmed_absent: "Removal confirmed", absence_observed: "Not found; removal unconfirmed" };
const codeNames: Record<NonNullable<StorageCandidateCheck["code"]>, string> = {
  credential_unavailable: "The stored credentials are unavailable.", provider_unavailable: "The storage provider could not complete the request.",
  read_verification_failed: "The downloaded bytes did not match the test object.", metadata_verification_failed: "The object metadata could not be verified.",
  cleanup_unconfirmed: "Removal of the temporary object is not confirmed.", execution_interrupted: "The test was interrupted. Its recorded result is preserved.",
};
const activeCheck = (check: StorageCandidateCheck) => check.status === "running" || check.cleanup === "running";
const intentKey = (profileId: string) => `storage-candidate-check:${profileId}`;
function rememberedIntent(profileId: string): StartStorageCandidateCheckInput | null {
  try {
    const raw = sessionStorage.getItem(intentKey(profileId));
    if (!raw) return null;
    const input = checkedStartStorageCandidateCheckInput(JSON.parse(raw));
    return input.profileId === profileId ? input : null;
  } catch { return null; }
}

/** A remembered identifier permits GET reconciliation after a lost response.
 * Neither credentials nor form inputs are written to browser storage. */
function CandidateChecks({ candidate, canTest, canCleanup, onForbidden }: { candidate: StorageCandidate; canTest: boolean; canCleanup: boolean; onForbidden: () => void }) {
  const [history, setHistory] = useState<StorageCandidateCheckList>({ items: [], hasMore: false });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [pending, setPending] = useState<StartStorageCandidateCheckInput | null>(() => rememberedIntent(candidate.profileId));
  const pendingRef = useRef(pending), generation = useRef(0), requests = useRef(new Set<AbortController>());
  const pollCount = useRef({ id: "", count: 0 });
  function remember(input: StartStorageCandidateCheckInput | null) {
    try {
      if (input) sessionStorage.setItem(intentKey(candidate.profileId), JSON.stringify(input));
      else sessionStorage.removeItem(intentKey(candidate.profileId));
    } catch { if (input) return false; }
    pendingRef.current = input; setPending(input); return true;
  }
  async function request<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController(); requests.current.add(controller);
    try { return await operation(controller.signal); } finally { requests.current.delete(controller); }
  }
  function denied(failure: unknown) {
    if (!(failure instanceof StorageConfigurationRequestError) || failure.status !== 403) return false;
    for (const controller of requests.current) controller.abort();
    onForbidden(); return true;
  }
  function accept(check: StorageCandidateCheck) {
    if (check.profileId !== candidate.profileId || pendingRef.current?.checkId === check.id && pendingRef.current.expectedRevision !== check.revision)
      throw new Error("Invalid storage test response.");
    setHistory(current => {
      const items = [current.items.find(item => item.id === check.id && item.updatedAt > check.updatedAt) ?? check, ...current.items.filter(item => item.id !== check.id)]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { items: items.slice(0, MAX_STORAGE_CANDIDATE_CHECKS), hasMore: current.hasMore || items.length > MAX_STORAGE_CANDIDATE_CHECKS };
    });
    if (pendingRef.current?.checkId === check.id && !activeCheck(check)) remember(null);
  }
  async function reconcile(id: string, current: number) {
    try {
      const check = await request(signal => storageConfigurationClient.readCheck(id, signal));
      if (current !== generation.current) return;
      accept(check); setMessage("");
    } catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      setMessage("The test result is not available yet. Check its status before starting another test.");
    }
  }
  async function load() {
    const current = generation.current;
    setLoading(true); setMessage("");
    try {
      const list = await request(signal => storageConfigurationClient.listChecks(candidate.profileId, signal));
      if (current !== generation.current) return;
      const intent = pendingRef.current, known = intent && list.items.find(item => item.id === intent.checkId);
      if (known && known.revision !== intent.expectedRevision) throw new Error("Invalid storage test response.");
      setHistory(previous => ({ ...list, items: list.items.map(check => previous.items.find(item => item.id === check.id && item.updatedAt > check.updatedAt) ?? check) }));
      if (known && !activeCheck(known)) remember(null);
      else if (intent && !known) await reconcile(intent.checkId, current);
    } catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      setMessage("Test history is unavailable. Check its status before starting a test.");
    } finally { if (current === generation.current) setLoading(false); }
  }
  useEffect(() => {
    generation.current += 1; setBusy(false); pollCount.current = { id: "", count: 0 }; void load();
    return () => { generation.current += 1; for (const controller of requests.current) controller.abort(); };
  }, [candidate.profileId, candidate.revision]);
  const running = history.items.find(activeCheck);
  useEffect(() => {
    if (!running || loading || busy) return;
    if (pollCount.current.id !== running.id) pollCount.current = { id: running.id, count: 0 };
    if (pollCount.current.count >= 10) { setMessage("The test is still running. Check its status for the latest result."); return; }
    const current = generation.current;
    const timer = setTimeout(() => { pollCount.current.count += 1; void reconcile(running.id, current); }, 3000);
    return () => clearTimeout(timer);
  }, [running, loading, busy]);
  const unresolved = !!pending || history.items.some(activeCheck);
  async function start() {
    if (!canTest || candidate.namespace.kind !== "s3" || loading || busy || unresolved || message) return;
    const input = { checkId: crypto.randomUUID(), profileId: candidate.profileId, expectedRevision: candidate.revision };
    if (!remember(input)) { setMessage("This browser cannot retain the test identifier. Enable session storage before starting a test."); return; }
    const current = generation.current; setBusy(true); setMessage("");
    try {
      const check = await request(signal => storageConfigurationClient.startCheck(input, signal));
      if (current === generation.current) accept(check);
    } catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      if (failure instanceof StorageConfigurationRequestError && [400, 409].includes(failure.status)) {
        remember(null); setMessage("This candidate changed or another test is active. Check its status before testing again.");
      } else {
        setMessage("The test response was lost. Reading its recorded result…");
        await reconcile(input.checkId, current);
      }
    } finally { if (current === generation.current) setBusy(false); }
  }
  async function clean(check: StorageCandidateCheck) {
    if (!canCleanup || loading || busy || activeCheck(check) || check.cleanup === "confirmed_absent") return;
    const current = generation.current; setBusy(true); setMessage("");
    try {
      const result = await request(signal => storageConfigurationClient.cleanupCheck(check.id, signal));
      if (current === generation.current) accept(result);
    } catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      setMessage("The cleanup response was lost. Reading its recorded result…");
      await reconcile(check.id, current);
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <div className="storage-candidate-checks">
    <h4>Connection tests</h4>
    {candidate.namespace.kind === "s3" ? <>
      <p className="muted">A test writes a small temporary object, verifies its contents and metadata, then removes it. Current Cloudflare R2 upload destinations remain unchanged.</p>
      {canTest && <button className="button" type="button" disabled={loading || busy || unresolved || !!message} onClick={() => void start()}>Test {candidate.label}</button>}
    </> : <p className="muted">Connection tests are currently available for S3 candidates.</p>}
    {loading && <p role="status">Reading test history…</p>}
    {message && <p role="status">{message}</p>}
    {history.items.some(check => !activeCheck(check) && check.cleanup !== "confirmed_absent") && <p className="muted">Cleanup from an earlier test remains unresolved; its recorded result is retained. A new test uses a separate temporary object.</p>}
    {pending && !history.items.some(check => check.id === pending.checkId) && <p className="muted">Test for revision {pending.expectedRevision}: result unconfirmed. No new test will be started until its result is known.</p>}
    {!loading && <button className="button" type="button" disabled={busy} onClick={() => { pollCount.current.count = 0; void load(); }}>Check test status for {candidate.label}</button>}
    {!loading && history.items.length === 0 && !pending && <p className="muted">This candidate has no recorded tests.</p>}
    {history.items.length > 0 && <ol className="storage-check-history" aria-label={`Test history for ${candidate.label}`}>
      {history.items.map(check => <li key={check.id}>
        <div className="storage-check-heading"><strong>{resultNames[check.status]}</strong><span>{check.revision === candidate.revision ? `Current revision ${check.revision}` : `Historical revision ${check.revision}`}</span>
          <time dateTime={check.createdAt}>{new Date(check.createdAt).toLocaleString()}</time></div>
        {check.revision !== candidate.revision && <p className="muted">This result does not test the current candidate revision.</p>}
        <dl className="storage-check-stages"><div><dt>Write</dt><dd>{stepNames[check.write]}</dd></div><div><dt>Read back</dt><dd>{stepNames[check.read]}</dd></div>
          <div><dt>Metadata</dt><dd>{stepNames[check.metadata]}</dd></div><div><dt>Delete</dt><dd>{stepNames[check.delete]}</dd></div><div><dt>Cleanup</dt><dd>{cleanupNames[check.cleanup]}</dd></div></dl>
        {check.code && <p className="muted">{codeNames[check.code]}</p>}
        {check.cleanup === "absence_observed" && <p className="muted">{check.write === "unknown"
          ? "An interrupted write may still finish later. Removal remains unconfirmed."
          : "The object was absent when checked, but removal is not confirmed."}</p>}
        {canCleanup && !activeCheck(check) && check.cleanup !== "confirmed_absent" && <button className="button" type="button" disabled={loading || busy}
          onClick={() => void clean(check)}>Clean up test object for revision {check.revision}</button>}
      </li>)}
    </ol>}
    {history.hasMore && <p className="muted">Only the latest tests are shown.</p>}
  </div>;
}
