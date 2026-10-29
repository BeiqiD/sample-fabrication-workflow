import { checkpointStorage, type CheckpointStorage } from "../lib/browser-checkpoints";
import { captureApplicationOwner, subscribeAuthentication } from "../lib/authentication-client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { supportsExpectedS3BucketOwner, type SaveStorageCandidateInput, type StorageCandidate, type StorageConfigurationStatus } from "../../shared/contracts/storage-configuration";
import { awsS3NativeNamespace } from "../../shared/contracts/storage-profile-admission";
import { checkedStartStorageCandidateCheckInput, MAX_STORAGE_CANDIDATE_CHECKS, type StartStorageCandidateCheckInput, type StorageCandidateCheck,
  type StorageCandidateCheckList, type StorageCandidateCheckStage } from "../../shared/contracts/storage-candidate-check";
import { storageConfigurationClient, StorageConfigurationRequestError, type StorageConfigurationCapability } from "../lib/storage-configuration-client";
import { StorageCandidateReadiness, type StorageCandidateSetupProgress } from "./StorageCandidateReadiness";
import { StorageCredentialEncryption } from "./StorageCredentialEncryption";
import { StorageCredentialSetup } from "./StorageCredentialSetup";
import { ActionIcon } from "../components/ActionIcon";
import "./storage-settings.css";

type Provider = "s3" | "webdav" | "switchdrive";
const names: Record<Provider, string> = { s3: "S3 compatible", webdav: "WebDAV", switchdrive: "SWITCHdrive" };
const blank = { label: "", provider: "s3" as Provider, endpoint: "", bucket: "", region: "", root: "", forcePathStyle: true, expectedBucketOwner: "",
  accessKeyId: "", secretAccessKey: "", sessionToken: "", username: "", password: "" };
function nativeCandidate(candidate: StorageCandidate): boolean {
  try { awsS3NativeNamespace(candidate.namespace); return true; } catch { return false; }
}
interface WizardSelection {
  profileId: string; revision: number; flow: number; testPassed: boolean;
  evidenceStage: StorageCandidateSetupProgress["stage"]; evidence: StorageCandidateSetupProgress["evidence"];
}

export function StorageConfigurationPage() {
  const [owner] = useState(captureApplicationOwner);
  const [capability, setCapability] = useState<StorageConfigurationCapability | null>(null);
  const [status, setStatus] = useState<StorageConfigurationStatus | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [form, setForm] = useState(blank), [editing, setEditing] = useState<StorageCandidate | null>(null);
  const [replaceCredentials, setReplaceCredentials] = useState(true), [uncertainSave, setUncertainSave] = useState(false);
  const [setupRequested, setSetupRequested] = useState(false), [awsFlow, setAwsFlow] = useState(false);
  const [wizardStage, setWizardStage] = useState<1 | 2 | 3>(1);
  const [selection, setSelection] = useState<WizardSelection | null>(null);
  const flowGeneration = useRef(0);
  const [evidenceState, setEvidenceState] = useState<Record<string, { generation: number; pending: number }>>({});
  function beginEvidenceChange(profileId: string) {
    setEvidenceState(current => ({ ...current, [profileId]: { generation: (current[profileId]?.generation ?? 0) + 1, pending: (current[profileId]?.pending ?? 0) + 1 } }));
    let finished = false;
    return () => {
      if (finished || !owner.isCurrent()) return; finished = true;
      setEvidenceState(current => ({ ...current, [profileId]: { generation: current[profileId]?.generation ?? 0, pending: Math.max(0, (current[profileId]?.pending ?? 0) - 1) } }));
    };
  }
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null), returnRefreshFocus = useRef(false);
  const candidateName = useRef<HTMLInputElement>(null), returnSetupFocus = useRef(false);
  function resetEditor() { setForm(blank); setEditing(null); setReplaceCredentials(true); }
  function clearSelection() { flowGeneration.current += 1; setSelection(null); }
  function selectCandidate(candidate: StorageCandidate) {
    if (!owner.isCurrent() || !nativeCandidate(candidate)) return;
    const flow = ++flowGeneration.current;
    setSelection({ profileId: candidate.profileId, revision: candidate.revision, flow, testPassed: false, evidenceStage: 3, evidence: "unobserved" });
    setAwsFlow(true); setWizardStage(3);
  }
  function progress(value: StorageCandidateSetupProgress, flow: number) {
    if (!owner.isCurrent()) return;
    setSelection(current => !current || current.flow !== flow || current.profileId !== value.profileId || current.revision !== value.revision
      || current.evidenceStage === value.stage && current.evidence === value.evidence ? current : { ...current, evidenceStage: value.stage, evidence: value.evidence });
  }
  function testProgress(value: { profileId: string; revision: number; passed: boolean }, flow: number) {
    if (!owner.isCurrent()) return;
    setSelection(current => !current || current.flow !== flow || current.profileId !== value.profileId || current.revision !== value.revision
      || current.testPassed === value.passed ? current : { ...current, testPassed: value.passed });
  }
  function accessDenied() {
    sequence.current += 1; controller.current?.abort(); resetEditor(); setStatus(null);
    setSetupRequested(false); setAwsFlow(false);
    clearSelection();
    returnSetupFocus.current = false;
    setCapability({ canManage: false, credentialEditingAvailable: false }); setLoading(false); setSaving(false);
    setError("System administrator access is required. Refresh to check your access.");
  }
  async function refresh() {
    if (!owner.isCurrent()) return;
    const current = ++sequence.current;
    controller.current?.abort(); const pending = new AbortController(); controller.current = pending;
    setLoading(true); setError(""); setCapability(null); setStatus(null);
    setSetupRequested(false); setAwsFlow(false);
    clearSelection();
    returnSetupFocus.current = false;
    // Credentials are intentionally never retained across refreshes.
    resetEditor();
    try {
      const permission = await storageConfigurationClient.capability(pending.signal);
      if (!owner.isCurrent() || current !== sequence.current || pending.signal.aborted) return;
      const result = permission.canManage ? await storageConfigurationClient.read(pending.signal) : null;
      if (!owner.isCurrent() || current !== sequence.current || pending.signal.aborted) return;
      setCapability(permission); setStatus(result); setUncertainSave(false);
    } catch (failure) {
      if (owner.isCurrent() && current === sequence.current && failure instanceof StorageConfigurationRequestError && failure.status === 403) { accessDenied(); return; }
      if (owner.isCurrent() && current === sequence.current && !pending.signal.aborted) setError("Storage configuration is unavailable. Refresh to try again.");
    } finally {
      if (owner.isCurrent() && current === sequence.current && !pending.signal.aborted) setLoading(false);
    }
  }
  // Consume focus intent with the committed enabled button, before a later
  // interaction can queue another refresh ahead of a deferred passive effect.
  useLayoutEffect(() => {
    if (loading || !returnRefreshFocus.current) return;
    returnRefreshFocus.current = false;
    const button = refreshButton.current;
    if (button?.isConnected && !button.disabled && (document.activeElement === document.body || document.activeElement === button)) button.focus();
  }, [loading]);
  useLayoutEffect(() => {
    if (setupRequested || !returnSetupFocus.current) return;
    returnSetupFocus.current = false;
    if (owner.isCurrent() && document.activeElement === document.body && candidateName.current?.isConnected) candidateName.current.focus();
  }, [setupRequested, capability, status]);
  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeAuthentication(() => { if (!owner.isCurrent()) accessDenied(); });
    return () => { unsubscribe(); sequence.current += 1; controller.current?.abort(); };
  }, []);
  function beginAwsStorage() {
    if (!owner.isCurrent() || !capability?.canManage || !status || loading || saving || uncertainSave) return;
    resetEditor(); setError(""); setNotice(""); setAwsFlow(true);
    clearSelection();
    returnSetupFocus.current = false;
    setForm({ ...blank, endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", forcePathStyle: false });
    const ready = capability.credentialEditingAvailable && status.credentialEditingAvailable;
    setSetupRequested(!ready); setWizardStage(ready ? 2 : 1);
  }
  async function continueAfterSetup(signal: AbortSignal) {
    owner.assertCurrent();
    const current = sequence.current;
    const permission = await storageConfigurationClient.capability(signal);
    if (!owner.isCurrent() || signal.aborted || current !== sequence.current) return;
    if (!permission.canManage) { accessDenied(); return; }
    const latest = await storageConfigurationClient.read(signal);
    if (!owner.isCurrent() || signal.aborted || current !== sequence.current) return;
    if (!permission.credentialEditingAvailable || !latest.credentialEditingAvailable) throw new Error("Credential setup remains unavailable");
    // Recheck observes configuration only. No seed or provider credential is
    // delivered, persisted or replayed while the operator applies the Secret.
    returnSetupFocus.current = document.activeElement === document.body || !!document.activeElement?.closest(".storage-credential-setup");
    setCapability(permission); setStatus(latest); setSetupRequested(false); setWizardStage(2);
  }
  function edit(candidate: StorageCandidate) {
    const namespace = candidate.namespace;
    setSetupRequested(false); setAwsFlow(false);
    clearSelection();
    returnSetupFocus.current = false;
    setEditing(candidate); setReplaceCredentials(false); setNotice(""); setError("");
    setForm({ ...blank, label: candidate.label, provider: namespace.kind, endpoint: namespace.endpoint, root: namespace.root,
      ...(namespace.kind === "s3" ? { bucket: namespace.bucket, region: namespace.region, forcePathStyle: namespace.forcePathStyle,
        expectedBucketOwner: namespace.expectedBucketOwner ?? "" } : {}) });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!owner.isCurrent() || saving || uncertainSave || !capability?.credentialEditingAvailable) return;
    if (form.provider === "s3" && form.expectedBucketOwner && !supportsExpectedS3BucketOwner(form.endpoint, form.region)) {
      setError("Expected AWS bucket owner requires a matching AWS S3 endpoint and region. Correct them or clear the owner."); return;
    }
    const namespace = form.provider === "s3" ? { kind: "s3" as const, endpoint: form.endpoint, bucket: form.bucket, region: form.region,
      root: form.root, forcePathStyle: form.forcePathStyle, ...(form.expectedBucketOwner ? { expectedBucketOwner: form.expectedBucketOwner } : {}) }
      : { kind: form.provider, endpoint: form.endpoint, root: form.root };
    const credentials: SaveStorageCandidateInput["credentials"] = replaceCredentials ? { mode: "replace", value: form.provider === "s3"
      ? { accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey, ...(form.sessionToken ? { sessionToken: form.sessionToken } : {}) }
      : { username: form.username, password: form.password } } : { mode: "retain" };
    const input: SaveStorageCandidateInput = { ...(editing ? { profileId: editing.profileId } : {}), expectedRevision: editing?.revision ?? null,
      label: form.label, namespace, credentials };
    const current = sequence.current, signal = controller.current?.signal;
    const finishEvidenceChange = editing ? beginEvidenceChange(editing.profileId) : () => {};
    if (awsFlow) { clearSelection(); setWizardStage(2); }
    setSaving(true); setError(""); setNotice("");
    try {
      let saved: StorageCandidate | null = null;
      if (awsFlow) saved = await storageConfigurationClient.saveForOnboarding(input, signal);
      else await storageConfigurationClient.save(input, signal);
      if (!owner.isCurrent() || current !== sequence.current || signal?.aborted) return;
      if (saved && input.expectedRevision === null && status?.candidates.items.some(item => item.profileId === saved.profileId))
        throw new Error("New storage candidate identity was not new");
      resetEditor();
      if (awsFlow && saved) {
        if (nativeCandidate(saved)) selectCandidate(saved);
        else { setAwsFlow(false); setWizardStage(3); }
      }
      // A successful commit is shown even if the subsequent metadata read fails.
      setNotice("Candidate saved as a draft. Current upload destinations are unchanged.");
      try {
        const latest = await storageConfigurationClient.read(signal);
        if (owner.isCurrent() && current === sequence.current && !signal?.aborted) setStatus(latest);
      } catch (failure) {
        if (!owner.isCurrent() || current !== sequence.current || signal?.aborted) return;
        if (failure instanceof StorageConfigurationRequestError && failure.status === 403) { accessDenied(); return; }
        setError("Draft saved. Refresh to read the latest candidates."); setUncertainSave(true);
      }
    } catch (failure) {
      if (!owner.isCurrent() || current !== sequence.current || signal?.aborted) return;
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
    } finally { finishEvidenceChange(); if (owner.isCurrent() && current === sequence.current) setSaving(false); }
  }
  const set = (name: keyof typeof blank, value: string | boolean) => setForm(current => ({ ...current, [name]: value }));
  const externalEditing = capability?.credentialEditingAvailable && status?.credentialEditingAvailable;
  const selectedCandidate = selection && status?.candidates.items.find(item => item.profileId === selection.profileId && item.revision === selection.revision && nativeCandidate(item));
  const selected = selectedCandidate ? selection : null;
  const currentWizardStage = selected ? selected.evidence === "current" ? selected.evidenceStage
    : selected.evidence === "pending" || selected.evidence === "unavailable" ? 3 : selected.testPassed ? 4 : 3 : wizardStage;
  const standardAwsEndpoint = form.provider === "s3" && supportsExpectedS3BucketOwner(form.endpoint, form.region)
    && !/^(?:cn-|us-gov-)|(?:^|-)iso[a-z]*-/.test(form.region);
  return <div className="page storage-settings-page">
    <div className="page-heading"><div><h1>Storage configuration</h1><p className="page-context">Settings</p>
      <p className="lead">Save storage candidates, test S3 connections and maintain credential encryption.</p></div>
      <button ref={refreshButton} className="button core-toolbar-action core-toolbar-icon" type="button" aria-label={loading ? "Refreshing…" : "Refresh"} title="Refresh" disabled={loading || saving} onClick={() => {
        returnRefreshFocus.current = document.activeElement === refreshButton.current;
        void refresh();
      }}><ActionIcon name="refresh" /><span className="core-action-label">{loading ? "Refreshing…" : "Refresh"}</span></button></div>
    <p><a href="/settings/storage">Current storage settings</a></p>
    {loading && <p role="status">Reading configuration access…</p>}
    {error && <div className="error-banner" role="alert"><p>{error}</p></div>}
    {notice && <p role="status">{notice}</p>}
    {capability && !capability.canManage && <section className="card storage-settings-section"><h2 className="card-title">Read only</h2>
      <p>Only system administrators can manage storage candidates. Cloudflare R2 storage does not require external credentials.</p></section>}
    {capability?.canManage && status && <>
      <div className="storage-settings-observation"><strong>Candidate storage</strong>
        <p className="muted">Saving does not test the connection, activate a provider or change upload destinations. Cloudflare R2 storage does not require external credentials.</p></div>
      <section className="card storage-settings-section storage-add-section" aria-labelledby="storage-add-title">
        <h2 className="card-title" id="storage-add-title">Add storage</h2>
        <p>Connect AWS S3 for new upload destinations. Set up encrypted credentials only when you first add external storage; built-in R2 needs no seed.</p>
        <button className="button primary" type="button" disabled={loading || saving || uncertainSave || setupRequested} onClick={beginAwsStorage}>Add AWS S3 storage</button>
        <p className="muted">An additional R2 bucket needs an operator-provisioned bucket binding. Other S3-compatible, WebDAV and SWITCHdrive connections remain saved candidates until their native support is separately qualified.</p>
        {awsFlow && <nav className="storage-onboarding-stages" aria-label="Add AWS S3 stages"><ol>
          <li aria-current={currentWizardStage === 1 ? "step" : undefined}>Secure credentials</li>
          <li aria-current={currentWizardStage === 2 ? "step" : undefined}>Save connection</li>
          <li aria-current={currentWizardStage === 3 ? "step" : undefined}><a href={selected ? "#storage-wizard-candidate" : "#storage-candidates-title"}>Test connection</a></li>
          <li aria-current={currentWizardStage === 4 ? "step" : undefined}><a href={selected ? "#storage-wizard-candidate" : "#storage-candidates-title"}>Review evidence and register</a></li>
          <li aria-current={currentWizardStage === 5 ? "step" : undefined}>Confirm profile activation</li>
          <li aria-current={currentWizardStage === 6 ? "step" : undefined}><a href="/settings/storage">Choose upload destinations</a></li>
        </ol></nav>}
        {setupRequested && <StorageCredentialSetup onReady={continueAfterSetup} onForbidden={accessDenied} onCancel={() => {
          returnSetupFocus.current = false; setSetupRequested(false); setAwsFlow(false); clearSelection(); resetEditor();
        }} />}
        {selectedCandidate && <p className="storage-wizard-selection">Setup selected: <strong>{selectedCandidate.label}</strong>, revision {selectedCandidate.revision}.</p>}
        {awsFlow && currentWizardStage === 3 && <p role="status">Run or reconcile a connection test for the selected saved connection, then review its evidence. Each later step needs its own confirmation.</p>}
        {awsFlow && currentWizardStage === 4 && <p role="status">Review the selected connection’s current evidence and register the matching tested configuration.</p>}
        {awsFlow && currentWizardStage === 5 && <p role="status">The profile is registered. Confirm or update its activation using this exact saved connection and current test evidence.</p>}
        {awsFlow && currentWizardStage === 6 && <p role="status">Activation and current availability are confirmed for this connection. Choose upload destinations separately; no defaults have changed.</p>}
      </section>
      <section className="card storage-settings-section" aria-labelledby="storage-candidates-title"><h2 className="card-title" id="storage-candidates-title">Saved candidates</h2>
        {status.candidates.items.length === 0 ? <p className="muted">No external storage candidates have been saved.</p> : <ul className="storage-profile-list">
          {status.candidates.items.map(candidate => <li key={candidate.profileId}
            id={selected?.profileId === candidate.profileId && selected.revision === candidate.revision ? "storage-wizard-candidate" : undefined}>
            <div className="storage-profile-heading"><h3>{candidate.label}</h3><span>{nativeCandidate(candidate) ? "AWS S3" : candidate.namespace.kind === "s3" ? "S3 compatible — candidate only" : names[candidate.namespace.kind]} · Draft · Revision {candidate.revision}</span></div>
            <dl><div><dt>Storage address</dt><dd>{candidate.namespace.endpoint}{candidate.namespace.kind === "s3" ? ` / ${candidate.namespace.bucket}` : ""}</dd></div>
              <div><dt>Root folder</dt><dd>{candidate.namespace.root || "/"}</dd></div><div><dt>Credentials</dt><dd>{candidate.credentials.status === "configured" ? "Configured" : "Unavailable"}</dd></div></dl>
            {externalEditing && <div className="button-row">
              <button className="button" type="button" disabled={saving || uncertainSave} onClick={() => edit(candidate)}>Edit {candidate.label}</button>
              {nativeCandidate(candidate) && <button className="button" type="button"
                disabled={saving || uncertainSave || selected?.profileId === candidate.profileId && selected.revision === candidate.revision}
                onClick={() => selectCandidate(candidate)}>Continue setup for {candidate.label}</button>}
            </div>}
            <CandidateChecks candidate={candidate} canTest={!!externalEditing && candidate.credentials.status === "configured" && !saving && !uncertainSave}
              canCleanup={!saving && !uncertainSave}
              onProgress={selected?.profileId === candidate.profileId && selected.revision === candidate.revision
                ? value => testProgress(value, selected.flow) : undefined}
              onForbidden={accessDenied} onEvidenceChange={() => beginEvidenceChange(candidate.profileId)} />
            <StorageCandidateReadiness candidate={candidate} evidenceGeneration={evidenceState[candidate.profileId]?.generation ?? 0}
              blocked={saving || uncertainSave || !!evidenceState[candidate.profileId]?.pending} onForbidden={accessDenied}
              onProgress={selected?.profileId === candidate.profileId && selected.revision === candidate.revision
                ? value => progress(value, selected.flow) : undefined} />
            <StorageCredentialEncryption candidate={candidate} canUpdate={!!externalEditing && !saving && !uncertainSave}
              onForbidden={accessDenied} onEvidenceChange={() => beginEvidenceChange(candidate.profileId)} />
          </li>)}
        </ul>}
        {status.candidates.hasMore && <p className="muted">Additional saved candidates are not shown.</p>}
      </section>
      {externalEditing && (!awsFlow || wizardStage < 3) && <section className="card storage-settings-section" aria-labelledby="storage-editor-title"><h2 className="card-title" id="storage-editor-title">{editing ? "New candidate revision" : "New candidate"}</h2>
        {awsFlow && <p className="muted">{standardAwsEndpoint ? "AWS S3 connection." : "S3-compatible candidate only: this endpoint is outside the supported AWS native path."} Saving is separate from testing, activation and choosing upload destinations.</p>}
        <form className="storage-candidate-form" onSubmit={event => void save(event)} autoComplete="off">
          <fieldset disabled={saving || uncertainSave}><div className="storage-candidate-fields">
            <label>Name<input ref={candidateName} required maxLength={120} value={form.label} onChange={event => set("label", event.target.value)} /></label>
            <label>Provider<select value={form.provider} disabled={!!editing} onChange={event => {
              setAwsFlow(false); clearSelection(); setForm({ ...blank, label: form.label, provider: event.target.value as Provider });
            }}>
              <option value="s3">{awsFlow && standardAwsEndpoint ? "AWS S3" : "S3 compatible — candidate only"}</option><option value="webdav">WebDAV</option><option value="switchdrive">SWITCHdrive</option></select></label>
            <label>HTTPS endpoint<input required type="url" disabled={!!editing} value={form.endpoint} onChange={event => set("endpoint", event.target.value)} placeholder="https://storage.example.org" /></label>
            <label>Root folder<input disabled={!!editing} value={form.root} onChange={event => set("root", event.target.value)} /></label>
            {form.provider === "s3" && <><label>Bucket<input required disabled={!!editing} value={form.bucket} onChange={event => set("bucket", event.target.value)} /></label>
              <label>Region<input required value={form.region} onChange={event => set("region", event.target.value)} /></label>
              {(supportsExpectedS3BucketOwner(form.endpoint, form.region) || form.expectedBucketOwner) && <div>
                <label>{awsFlow && standardAwsEndpoint ? "AWS bucket owner account ID" : "Expected AWS bucket owner (optional)"}<input required={awsFlow && standardAwsEndpoint} inputMode="numeric" pattern="[0-9]{12}" maxLength={12}
                  title="Enter the bucket owner's 12-digit AWS account ID." aria-describedby="storage-expected-owner-help"
                  value={form.expectedBucketOwner} onChange={event => set("expectedBucketOwner", event.target.value)} /></label>
                <small id="storage-expected-owner-help" className="muted">For standard AWS S3 endpoints only. Enter the bucket owner's 12-digit AWS account ID, or leave blank. Changing this value requires a new connection test.</small>
              </div>}
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
function rememberedIntent(storage: CheckpointStorage, profileId: string): StartStorageCandidateCheckInput | null {
  try {
    const raw = storage.getItem(intentKey(profileId));
    if (!raw) return null;
    const input = checkedStartStorageCandidateCheckInput(JSON.parse(raw));
    return input.profileId === profileId ? input : null;
  } catch { return null; }
}

/** A remembered identifier permits GET reconciliation after a lost response.
 * Neither credentials nor form inputs are written to browser storage. */
function CandidateChecks({ candidate, canTest, canCleanup, onForbidden, onEvidenceChange, onProgress }: {
  candidate: StorageCandidate; canTest: boolean; canCleanup: boolean; onForbidden: () => void; onEvidenceChange: () => () => void;
  onProgress?: (value: { profileId: string; revision: number; passed: boolean }) => void;
}) {
  const [owner] = useState(captureApplicationOwner);
  const [storage] = useState(() => checkpointStorage(owner));
  const [history, setHistory] = useState<StorageCandidateCheckList>({ items: [], hasMore: false });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [pending, setPending] = useState<StartStorageCandidateCheckInput | null>(() => rememberedIntent(storage, candidate.profileId));
  const pendingRef = useRef(pending), generation = useRef(0), requests = useRef(new Set<AbortController>());
  const pollCount = useRef({ id: "", count: 0 });
  const passed = !loading && !busy && !pending && !message && !history.items.some(activeCheck)
    && history.items.some(check => check.profileId === candidate.profileId && check.revision === candidate.revision && check.status === "succeeded"
      && check.write === "passed" && check.read === "passed" && check.metadata === "passed" && check.delete === "passed" && check.cleanup === "confirmed_absent");
  useEffect(() => {
    if (owner.isCurrent()) onProgress?.({ profileId: candidate.profileId, revision: candidate.revision, passed });
  }, [candidate.profileId, candidate.revision, passed, onProgress]);
  function remember(input: StartStorageCandidateCheckInput | null) {
    try {
      if (input) storage.setItem(intentKey(candidate.profileId), JSON.stringify(input));
      else storage.removeItem(intentKey(candidate.profileId));
    } catch { if (input) return false; }
    pendingRef.current = input; setPending(input); return true;
  }
  async function request<T>(operation: (signal: AbortSignal) => Promise<T>) {
    owner.assertCurrent();
    const controller = new AbortController(); requests.current.add(controller);
    try { const value = await operation(controller.signal); owner.assertCurrent(); return value; } finally { requests.current.delete(controller); }
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
    const finishEvidenceChange = onEvidenceChange();
    try {
      const check = await request(signal => storageConfigurationClient.readCheck(id, signal));
      if (!owner.isCurrent() || current !== generation.current) return;
      accept(check); setMessage("");
    } catch (failure) {
      if (!owner.isCurrent() || current !== generation.current || denied(failure)) return;
      setMessage("The test result is not available yet. Check its status before starting another test.");
    } finally { finishEvidenceChange(); }
  }
  async function load() {
    const finishEvidenceChange = onEvidenceChange();
    const current = generation.current;
    setLoading(true); setMessage("");
    try {
      const list = await request(signal => storageConfigurationClient.listChecks(candidate.profileId, signal));
      if (!owner.isCurrent() || current !== generation.current) return;
      const intent = pendingRef.current, known = intent && list.items.find(item => item.id === intent.checkId);
      if (known && known.revision !== intent.expectedRevision) throw new Error("Invalid storage test response.");
      setHistory(previous => ({ ...list, items: list.items.map(check => previous.items.find(item => item.id === check.id && item.updatedAt > check.updatedAt) ?? check) }));
      if (known && !activeCheck(known)) remember(null);
      else if (intent && !known) await reconcile(intent.checkId, current);
    } catch (failure) {
      if (!owner.isCurrent() || current !== generation.current || denied(failure)) return;
      setMessage("Test history is unavailable. Check its status before starting a test.");
    } finally { finishEvidenceChange(); if (owner.isCurrent() && current === generation.current) setLoading(false); }
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
    const finishEvidenceChange = onEvidenceChange();
    const current = generation.current; setBusy(true); setMessage("");
    try {
      const check = await request(signal => storageConfigurationClient.startCheck(input, signal));
      if (owner.isCurrent() && current === generation.current) accept(check);
    } catch (failure) {
      if (!owner.isCurrent() || current !== generation.current || denied(failure)) return;
      if (failure instanceof StorageConfigurationRequestError && [400, 409].includes(failure.status)) {
        remember(null); setMessage("This candidate changed or another test is active. Check its status before testing again.");
      } else {
        setMessage("The test response was lost. Reading its recorded result…");
        await reconcile(input.checkId, current);
      }
    } finally { finishEvidenceChange(); if (owner.isCurrent() && current === generation.current) setBusy(false); }
  }
  async function clean(check: StorageCandidateCheck) {
    if (!canCleanup || loading || busy || activeCheck(check) || check.cleanup === "confirmed_absent") return;
    const finishEvidenceChange = onEvidenceChange();
    const current = generation.current; setBusy(true); setMessage("");
    try {
      const result = await request(signal => storageConfigurationClient.cleanupCheck(check.id, signal));
      if (owner.isCurrent() && current === generation.current) accept(result);
    } catch (failure) {
      if (!owner.isCurrent() || current !== generation.current || denied(failure)) return;
      setMessage("The cleanup response was lost. Reading its recorded result…");
      await reconcile(check.id, current);
    } finally { finishEvidenceChange(); if (owner.isCurrent() && current === generation.current) setBusy(false); }
  }
  return <div className="storage-candidate-checks">
    <h4>Connection tests</h4>
    <p className="muted">Revision labels describe the saved configuration. Check evidence separately to see whether a recorded success matches the credentials stored now.</p>
    {candidate.namespace.kind === "s3" ? <>
      <p className="muted">A test writes a small temporary object, verifies its contents and metadata, then removes it. Saved upload destinations remain unchanged.</p>
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
        <div className="storage-check-heading"><strong>{resultNames[check.status]}</strong><span>{check.revision === candidate.revision ? `Current configuration revision ${check.revision}` : `Historical revision ${check.revision}`}</span>
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
