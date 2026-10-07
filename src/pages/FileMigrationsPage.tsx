import { useEffect, useRef, useState } from "react";
import { checkedAcceptFileMigration, type AcceptFileMigrationInput, type FileJobExecutorStatus, type FileJobStatus, type FileMigrationPlan, type FileMigrationItems } from "../../shared/contracts/file-jobs";
import type { StorageSettingsProfile } from "../../shared/contracts/storage-settings";
import { api } from "../lib/api";
import { fileJobsClient, FileMigrationRequestError, fileMigrationErrorMessage, type MigrationInventory } from "../lib/file-jobs-client";
import { storageConfigurationClient } from "../lib/storage-configuration-client";
import "./storage-settings.css";

const intentKey = "file-migration-acceptance";
function remembered(): AcceptFileMigrationInput | null {
  try { const saved = sessionStorage.getItem(intentKey); return saved ? checkedAcceptFileMigration(JSON.parse(saved)) : null; } catch { return null; }
}
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const jobReasons: Record<string, string> = {
  administrator_revoked: "Administrator access was revoked", actor_not_authorized: "Administrator access is unavailable",
  operator_paused: "Paused by an administrator", operator_cancelled: "Cancelled by an administrator",
  source_changed: "The source location changed", source_namespace_unavailable: "The source profile is unavailable",
  source_unavailable: "The source file is unavailable", target_unavailable: "The destination is unavailable",
  execution_budget_exhausted: "The step reached its time limit", write_settlement_required: "The previous write is awaiting confirmation",
  verification_or_storage_unavailable: "File verification or storage is unavailable", restored_archive: "Recovered job awaiting explicit resume",
  retry_limit_exhausted: "This job reached its five-attempt limit. Review the files before planning another migration",
};
const jobReason = (reason: string) => jobReasons[reason] ?? "Job needs attention; refresh its details";
export function FileMigrationsPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null), [profiles, setProfiles] = useState<StorageSettingsProfile[]>([]);
  const [inventory, setInventory] = useState<MigrationInventory>({ items: [], nextCursor: null });
  const [selection, setSelection] = useState<string[]>([]), [target, setTarget] = useState("");
  const [jobs, setJobs] = useState<FileJobStatus[]>([]), [executor, setExecutor] = useState<FileJobExecutorStatus | null>(null);
  const [plan, setPlan] = useState<FileMigrationPlan | null>(null), [pending, setPending] = useState(remembered);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [details, setDetails] = useState<FileMigrationItems | null>(null), [detailId, setDetailId] = useState<string | null>(null);
  const detailJob = useRef<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), busyRef = useRef(false), sequence = useRef(0);
  const canManage = useRef(false), refreshSequence = useRef(0);
  function reportError(error: unknown) {
    if (error instanceof FileMigrationRequestError && error.status === 403) {
      canManage.current = false; setAuthorized(false);
    }
    setMessage(fileMigrationErrorMessage(error));
  }
  async function refresh(signal: AbortSignal) {
    if (!canManage.current || signal.aborted) return;
    const currentRefresh = ++refreshSequence.current;
    const [list, current] = await Promise.all([fileJobsClient.list(signal), fileJobsClient.executor(signal)]);
    if (signal.aborted || !canManage.current || currentRefresh !== refreshSequence.current) return;
    setJobs(list); setExecutor(current);
    const detail = detailJob.current;
    if (detail) { const value = await fileJobsClient.items(detail, signal);
      if (!signal.aborted && canManage.current && detailJob.current === detail && currentRefresh === refreshSequence.current) setDetails(value); }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try { await refresh(controller.signal); } catch (error) { if (!controller.signal.aborted) reportError(error); }
      if (!controller.signal.aborted && canManage.current) timer = setTimeout(() => void poll(), 5000);
    };
    void (async () => {
      try {
        const capability = await storageConfigurationClient.capability(controller.signal);
        if (controller.signal.aborted) return;
        setAuthorized(capability.canManage);
        canManage.current = capability.canManage;
        if (!capability.canManage) return;
        const [settings, files] = await Promise.all([api.getCurrentStorageSettings(controller.signal), fileJobsClient.inventory(undefined, controller.signal)]);
        if (controller.signal.aborted) return;
        setProfiles(settings.version === 3 ? settings.profiles.items.filter(profile => profile.runtimeAccess === "read_write" && profile.availability === "available")
          : settings.profiles.items.filter(profile => profile.runtimeAccess === "read_write" && profile.bindingMatch === "matched")); setInventory(files);
        await poll();
      } catch (error) { if (!controller.signal.aborted) reportError(error); }
    })();
    return () => { controller.abort(); if (timer) clearTimeout(timer); sequence.current++; };
  }, []);
  async function act(operation: (signal: AbortSignal) => Promise<unknown>) {
    if (!canManage.current || busyRef.current || !lifetime.current || lifetime.current.signal.aborted) return;
    const signal = lifetime.current.signal, current = ++sequence.current; busyRef.current = true; setBusy(true); setMessage("");
    try { await operation(signal); if (!signal.aborted) await refresh(signal); }
    catch (error) { if (!signal.aborted && current === sequence.current) reportError(error); }
    finally { if (!signal.aborted && current === sequence.current) { busyRef.current = false; setBusy(false); } }
  }
  function changeSelection(ids: string[]) { setSelection(ids); setPlan(null); }
  function input(): AcceptFileMigrationInput { return checkedAcceptFileMigration({ requestId: crypto.randomUUID(), fileIds: selection,
    target: { profileId: target, configurationRevision: profiles.find(profile => profile.id === target)?.configurationRevision } }); }
  async function accept(signal: AbortSignal) {
    const acceptedInput = pending ?? input();
    sessionStorage.setItem(intentKey, JSON.stringify(acceptedInput)); setPending(acceptedInput);
    const value = await fileJobsClient.accept(acceptedInput, signal);
    if (signal.aborted) return;
    sessionStorage.removeItem(intentKey); setPending(null); setPlan(null); setSelection([]);
    setMessage(`Migration ${value.id} accepted. You can leave this page while the executor continues.`);
  }
  return <div className="page storage-settings-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>File migrations</h1>
      <p className="lead">Copy selected files, verify their contents, then switch their recorded location.</p></div>
      {authorized && <button className="button" type="button" disabled={busy} onClick={() => void act(async signal => {
        const [settings, files] = await Promise.all([api.getCurrentStorageSettings(signal), fileJobsClient.inventory(undefined, signal)]);
        if (signal.aborted) return;
        setProfiles(settings.version === 3 ? settings.profiles.items.filter(profile => profile.runtimeAccess === "read_write" && profile.availability === "available")
          : settings.profiles.items.filter(profile => profile.runtimeAccess === "read_write" && profile.bindingMatch === "matched"));
        setInventory(files); setPlan(null);
      })}>Refresh</button>}</div>
    <p><a href="/settings/storage">Storage settings</a></p>
    {authorized === null && !message && <p role="status">Reading administrator access…</p>}
    {authorized === false && <p role="status">System administrator access is required to manage File migrations.</p>}
    {message && <p role="status">{message}</p>}
    {authorized && <>
      <section className="card storage-settings-section"><h2 className="card-title">Independent executor</h2>
        {executor && <><p>{executor.enabled ? executor.stale ? "Enabled, but no recent heartbeat" : "Enabled" : "Paused"}.
          {executor.lastHeartbeatAt && <> Last heartbeat: <time>{executor.lastHeartbeatAt}</time>.</>}</p>
          {executor.enabled && executor.stale && <p className="muted">The independent runner has not reported recently. Check the configured runner; refreshing this page does not execute a job.</p>}
          <button type="button" className="button" disabled={busy} onClick={() => void act(signal => fileJobsClient.setExecutor(!executor.enabled, signal))}>{executor.enabled ? "Pause executor" : "Enable executor"}</button></>}
        <p className="muted">Accepted work is saved on the server. Closing your browser does not cancel it. Recovered jobs remain paused until explicitly resumed.</p>
      </section>
      <section className="card storage-settings-section"><h2 className="card-title">Plan a migration</h2>
        <p className="muted">Select up to 100 files, each no larger than 100 MiB. Source copies remain retained until a separate cleanup request.</p>
        <label>Destination <select aria-label="Migration destination" value={target} disabled={busy || !!pending} onChange={event => { setTarget(event.target.value); setPlan(null); }}>
          <option value="">Choose a writable profile</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.adapterType}: {profile.id}</option>)}</select></label>
        {!profiles.length && <p className="muted">No writable destination is available. Activate and bind a storage profile in Storage settings.</p>}
        <ul className="storage-profile-list">{inventory.items.map(file => <li key={file.fileId}><label className="storage-candidate-checkbox">
          <input type="checkbox" checked={selection.includes(file.fileId)} disabled={busy || !!pending || selection.length >= 100 && !selection.includes(file.fileId)}
            onChange={event => changeSelection(event.target.checked ? [...selection, file.fileId] : selection.filter(id => id !== file.fileId))} />
          <span><code>{file.fileId}</code> · {file.purpose} · {size(file.byteSize)}<br /><small>Current profile: {file.profileId}</small></span></label></li>)}</ul>
        {!inventory.items.length && <p className="muted">No published Files are available for migration.</p>}
        {inventory.nextCursor && <button type="button" className="button" disabled={busy || !!pending} onClick={() => void act(async signal => {
          const next = await fileJobsClient.inventory(inventory.nextCursor!, signal); if (!signal.aborted) setInventory(current => ({ items: [...current.items, ...next.items], nextCursor: next.nextCursor }));
        })}>Load more files</button>}
        <div className="storage-candidate-actions"><button type="button" className="button" disabled={busy || !!pending || !target || !selection.length}
          onClick={() => void act(async signal => { const value = await fileJobsClient.plan(input(), signal); if (!signal.aborted) setPlan(value); })}>Preview migration</button>
          {(plan || pending) && <button type="button" className="button primary" disabled={busy || !pending && plan!.items.some(item => item.status !== "eligible")}
            onClick={() => void act(accept)}>{pending ? "Check or retry accepted request" : "Start migration"}</button>}</div>
        {pending && <p className="muted">An acceptance result is awaiting confirmation for {pending.fileIds.length} files to <code>{pending.target.profileId}</code>.
          Retry keeps the original files, destination and request identity.</p>}
        {plan && <><p>{plan.items.length} files · {size(plan.bytes)} total · up to {size(plan.stagingBytes)} staging.</p>
          <p className="muted">One pass transfers and verifies {size(plan.transferAndVerificationBytes)}.
            Up to {plan.maxAttemptsPerFile} attempts per file may use {size(plan.maxTransferAndVerificationBytes)} in total.</p>
          <p className="muted">This preview reads metadata. The executor verifies every byte before switching a File.</p>
          {plan.items.filter(item => item.status !== "eligible").map(item => <p key={item.fileId}>{item.fileId}: {item.status === "same_profile" ? "Already on the destination profile" : "Exceeds the per-file limit"}</p>)}</>}
      </section>
      <section className="card storage-settings-section"><h2 className="card-title">Saved jobs</h2>
        {!jobs.length && <p className="muted">No migrations have been accepted.</p>}
        <ul className="storage-profile-list">{jobs.map(job => <li key={job.id}><h3><code>{job.id}</code></h3><p>{job.state} · {job.moved} moved · {job.remaining} remaining · {job.failed} failed · {job.cleanupPending} cleanup pending</p>
          <p className="muted">Destination: {job.target.profileId}{job.reason && <> · {jobReason(job.reason)}</>}</p>
          <div className="storage-candidate-actions">{(job.state === "running" || job.state === "queued") && <button type="button" className="button" disabled={busy} onClick={() => void act(signal => fileJobsClient.control(job.id, "pause", signal))}>Pause job</button>}
            {job.state === "paused" && <button type="button" className="button" disabled={busy} onClick={() => void act(signal => fileJobsClient.control(job.id, job.failed ? "retry" : "resume", signal))}>{job.failed ? "Retry failed files" : "Resume job"}</button>}
            {!["completed", "cancelled", "cancel_requested"].includes(job.state) && <button type="button" className="button" disabled={busy} onClick={() => void act(signal => fileJobsClient.control(job.id, "cancel", signal))}>Cancel remaining files</button>}
            {job.cleanupPending > 0 && <button type="button" className="button" disabled={busy} onClick={() => void act(signal => fileJobsClient.control(job.id, "cleanup", signal))}>Request source cleanup</button>}</div>
          <button type="button" className="button" disabled={busy} onClick={() => void act(async signal => {
            detailJob.current = job.id; setDetailId(job.id); setDetails(null);
            const value = await fileJobsClient.items(job.id, signal); if (!signal.aborted && detailJob.current === job.id) setDetails(value);
          })}>View files in {job.id}</button>
          {detailId === job.id && details && <ul>{details.items.map(item => <li key={item.fileId}><code>{item.fileId}</code>: {item.state}
            {item.reason && <> · {jobReason(item.reason)}</>} · {item.attemptCount}/{item.maxAttempts} attempts · cleanup {item.cleanupState.replaceAll("_", " ")}
            {(item.artifactCleanupPending > 0 || item.sourceCleanupPending) && <p className="muted">
              {item.sourceCleanupPending ? "Source copy cleanup is pending. " : ""}
              {item.artifactCleanupPending > 0 && <>{item.artifactCleanupPending} temporary {item.artifactCleanupPending === 1 ? "copy is" : "copies are"} awaiting physical cleanup.</>}</p>}
            {item.attemptState === "unknown" && <p className="muted">The previous write has not been confirmed. Its candidate remains retained while the executor reconciles it.</p>}</li>)}</ul>}
        </li>)}</ul>
      </section>
    </>}
  </div>;
}
