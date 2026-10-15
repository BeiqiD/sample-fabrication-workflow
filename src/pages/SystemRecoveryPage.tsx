import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  checkedSystemRecoveryBackupInput, checkedSystemRecoveryCutoverInput, checkedSystemRecoveryImportInput,
  checkedSystemRecoveryMaintenanceInput,
  checkedSystemRecoveryMaintenanceReceipt, checkedSystemRecoverySourceResumeInput,
  checkedSystemRecoveryUploadInput, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES,
  type SystemRecoveryBackupInput, type SystemRecoveryBackupPreview, type SystemRecoveryCapabilities,
  type SystemRecoveryCutoverInput, type SystemRecoveryImportInput, type SystemRecoveryJobControl,
  type SystemRecoveryJobStatus, type SystemRecoveryPreview, type SystemRecoveryReceipt,
  type SystemRecoveryStorageMapping, type SystemRecoveryUploadInput,
  type SystemRecoveryMaintenanceInput, type SystemRecoveryMaintenanceStatus,
  type SystemRecoveryMaintenanceReceipt,
  type SystemRecoverySourceResumeInput, type SystemRecoverySourceResumeReceipt,
} from "../../shared/contracts/system-recovery";
import { hashResearchFile } from "../../shared/domain/research-sha256";
import { systemRecoveryClient, systemRecoveryErrorMessage, SystemRecoveryRequestError } from "../lib/system-recovery-client";
import { ReadStatus } from "../components/ReadStatus";
import "./storage-settings.css";
import "./system-recovery.css";

const intentKey = "system-recovery-operation", uploadKey = "system-recovery-upload", receiptsKey = "system-recovery-receipts";
const maintenanceKey = "system-recovery-maintenance";
const sourceResumeKey = "system-recovery-source-resume", sourceReleaseKey = "system-recovery-source-release";
const sourceBackupKey = "system-recovery-source-backup";
type SourceRelease = { release: SystemRecoveryMaintenanceReceipt; backupJobId: string };
type Intent = { action: "backup"; input: SystemRecoveryBackupInput } | { action: "upload"; input: SystemRecoveryUploadInput }
  | { action: "recovery"; input: SystemRecoveryImportInput } | { action: "cutover"; jobId: string; input: SystemRecoveryCutoverInput };
type UploadCheckpoint = { input: SystemRecoveryUploadInput; jobId: string };
type ReceiptCheckpoint = { requestId: string; jobId: string };
class SessionIntentError extends Error {
  constructor() { super("Browser session storage is unavailable. Enable it to retain and reconcile recovery operation identifiers."); }
}
function storeSession(key: string, value: unknown | null) {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); }
  catch { throw new SessionIntentError(); }
}
function localIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "." && value !== ".."
    && !/\s|[\x00-\x1f\x7f/\\]/.test(value);
}
function savedIntent(): Intent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(intentKey) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.action === "cutover" && Object.keys(value).length === 3 && localIdentity(value.jobId)) {
      return { action: "cutover", jobId: value.jobId, input: checkedSystemRecoveryCutoverInput(value.input) };
    }
    if (Object.keys(value).length !== 2) return null;
    if (value.action === "backup") return { action: "backup", input: checkedSystemRecoveryBackupInput(value.input) };
    if (value.action === "upload") return { action: "upload", input: checkedSystemRecoveryUploadInput(value.input) };
    if (value.action === "recovery") return { action: "recovery", input: checkedSystemRecoveryImportInput(value.input) };
  } catch { /* A browser checkpoint does not authorize unsupported work. */ }
  return null;
}
function savedUpload(): UploadCheckpoint | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(uploadKey) || "null");
    if (value && Object.keys(value).length === 2 && localIdentity(value.jobId)) return { input: checkedSystemRecoveryUploadInput(value.input), jobId: value.jobId };
  } catch { /* Server receipts remain authoritative. */ }
  return null;
}
function savedReceipts(): ReceiptCheckpoint[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(receiptsKey) || "[]");
    if (!Array.isArray(value) || value.length > 20) return [];
    return value.filter(row => row && Object.keys(row).length === 2 && localIdentity(row.requestId) && localIdentity(row.jobId));
  } catch { return []; }
}
function savedMaintenance(): SystemRecoveryMaintenanceInput | null {
  try { const value = JSON.parse(sessionStorage.getItem(maintenanceKey) || "null"); return value ? checkedSystemRecoveryMaintenanceInput(value) : null; }
  catch { return null; }
}
function savedSourceResume(): SystemRecoverySourceResumeInput | null {
  try { const value = JSON.parse(sessionStorage.getItem(sourceResumeKey) || "null"); return value ? checkedSystemRecoverySourceResumeInput(value) : null; }
  catch { return null; }
}
function savedSourceRelease(): SourceRelease | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(sourceReleaseKey) || "null");
    if (!value || Object.keys(value).length !== 2 || !localIdentity(value.backupJobId)) return null;
    const release = checkedSystemRecoveryMaintenanceReceipt(value.release);
    return release.action === "release" && release.status.state === "open" ? { release, backupJobId: value.backupJobId } : null;
  } catch { return null; }
}
const reasons: Record<string, string> = {
  executor_disabled: "Independent execution is paused", runtime_unsupported: "This runtime does not support system recovery",
  administrator_required: "Current system administrator authority is required", administrator_revoked: "Administrator authority changed",
  recovery_target_missing: "An isolated recovery target has not been configured", target_unavailable: "The recovery target is unavailable",
  target_not_fresh: "The target contains state from another installation", target_claim_conflict: "Another recovery owns the target",
  maintenance_required: "Fence and drain source writes before planned recovery", source_not_fenced: "The source is still open for writes",
  source_checkpoint_changed: "The source changed after the accepted checkpoint", partial_archive: "Required files are missing from this backup",
  missing: "Source bytes are missing", provider_unavailable: "The source provider is unavailable", download_failed: "Source bytes could not be read",
  size_mismatch: "Bytes do not match their recorded size", hash_mismatch: "Bytes do not match their recorded hash",
  metadata_not_ready: "File metadata is incomplete", credential_key_unavailable: "The destination recovery key is unavailable",
  credential_quarantined: "Encrypted credentials require recovery review", operator_paused: "Paused by an administrator",
  operator_cancelled: "Cancelled by an administrator", restored_archive: "Recovered work requires explicit review before resuming",
  execution_budget_exhausted: "The bounded step reached its deadline", archive_limit: "The backup exceeds supported archive limits",
  mapping_required: "Every required source profile needs a destination mapping", destination_unavailable: "A mapped destination is unavailable",
};
function reasonText(code: string): string { return reasons[code] || code.replaceAll("_", " "); }
function size(bytes: number): string { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${bytes} bytes`; }
const credentialText = {
  excluded: "External credentials are excluded from this archive.",
  quarantined: "Encrypted credentials are quarantined. Provision the recovery key and review destination configuration before enabling them.",
  key_available: "A recovery key is available. Recovered credentials and integrations still require explicit destination review.",
};
function Report({ value }: { value: SystemRecoveryPreview }) {
  return <div className="system-recovery-report">
    <h3>{value.archive.complete ? "Complete backup" : "Partial backup"}</h3>
    <p>Recovery point: <time dateTime={value.archive.recoveryPoint}>{value.archive.recoveryPoint}</time>.</p>
    {value.archive.legacy && <p className="muted">This historical content archive uses an explicitly supported conversion path. Its original identity and missing-file evidence remain visible.</p>}
    {!value.archive.complete && <p className="warning-card">{value.counts.unavailableFiles} required file{value.counts.unavailableFiles === 1 ? " is" : "s are"} unavailable. Partial recovery does not satisfy complete-backup or complete-cutover verification.</p>}
    <dl><div><dt>Canonical tables</dt><dd>{value.counts.tables}</dd></div><div><dt>Canonical rows</dt><dd>{value.counts.rows}</dd></div>
      <div><dt>Available files</dt><dd>{value.counts.availableFiles} / {value.counts.files}</dd></div><div><dt>Required bytes</dt><dd>{size(value.counts.bytes)}</dd></div></dl>
    <h3>Protected settings and old work</h3>
    <p>{value.protectedSettings.included ? "Eligible system settings are included." : "This archive does not contain system settings."} {credentialText[value.protectedSettings.credentialRecovery]}</p>
    {value.protectedSettings.warnings.length > 0 && <ul>{value.protectedSettings.warnings.map((warning, index) => <li key={index}>{reasonText(warning)}</li>)}</ul>}
    <p>{value.oldJobs.paused} saved operation{value.oldJobs.paused === 1 ? " is" : "s are"} retained as history or paused work. Old uploads, deletion, migration, integrations and cleanup are never replayed automatically.</p>
    <h3>File outcomes</h3>
    {!value.files.length ? <p className="muted">No required file bytes are recorded.</p> : <div className="system-recovery-table"><table><thead><tr>
      <th>File identity</th><th>Purpose</th><th>Bytes</th><th>Outcome</th><th>Source profile</th></tr></thead><tbody>
      {value.files.map(file => <tr key={file.id}><td><code>{file.id}</code></td><td>{reasonText(file.purpose)}</td><td>{size(file.byteSize)}</td>
        <td>{reasonText(file.status)}{file.reason && <> · {reasonText(file.reason)}</>}</td><td>{file.sourceProfileId ? <code>{file.sourceProfileId}</code> : "Historical locator"}</td></tr>)}
    </tbody></table></div>}
    {value.reasons.length > 0 && <ul>{value.reasons.map(code => <li key={code}>{reasonText(code)}</li>)}</ul>}
    <p className="muted">Archive SHA-256: <code>{value.archive.sha256}</code>.</p>
  </div>;
}
function Job({ value, busy, recoveryCleanup, currentSignal, onControl, onReport, onSelectUpload, onCutover }: {
  value: SystemRecoveryJobStatus; busy: boolean; currentSignal: AbortSignal | null;
  recoveryCleanup: boolean;
  onControl: (action: SystemRecoveryJobControl, onStarting: (signal: AbortSignal) => void) => void;
  onReport: () => void; onSelectUpload: () => void; onCutover: () => void;
}) {
  const controlButtons = useRef(new Map<SystemRecoveryJobControl, HTMLButtonElement>());
  const status = useRef<HTMLParagraphElement | null>(null);
  const returnFocus = useRef<{ action: SystemRecoveryJobControl; origin: HTMLButtonElement; signal: AbortSignal } | null>(null);
  useEffect(() => {
    if (busy) return;
    const intent = returnFocus.current; returnFocus.current = null;
    if (!intent || intent.signal.aborted || intent.signal !== currentSignal
      || document.activeElement !== document.body && document.activeElement !== intent.origin) return;
    if (intent.origin.isConnected && !intent.origin.disabled) { intent.origin.focus(); return; }
    const next = intent.action === "pause" ? controlButtons.current.get("resume")
      : intent.action === "resume" || intent.action === "retry" ? controlButtons.current.get("pause")
        : intent.action === "cancel" && value.state === "cancelled" ? status.current : null;
    if (next?.isConnected && (!(next instanceof HTMLButtonElement) || !next.disabled)) next.focus();
  }, [busy, currentSignal, value.state]);
  const controls: SystemRecoveryJobControl[] = [];
  if (["queued", "running"].includes(value.state)) controls.push("pause");
  if (value.state === "paused") controls.push("resume", "retry");
  if (!["completed", "cancelled"].includes(value.state)) controls.push("cancel");
  if (["completed", "cancelled", "preview"].includes(value.state) && (value.kind !== "recovery" || recoveryCleanup)) controls.push("cleanup");
  return <article className="system-recovery-job"><h3>{value.kind === "backup" ? "System backup" : value.kind === "upload" ? "Archive validation" : "Isolated system recovery"}</h3>
    <p ref={status} role="status" tabIndex={-1}><code>{value.id}</code> · {reasonText(value.state)} · {reasonText(value.phase)}</p>
    <p>Files: {value.progress.completedFiles} / {value.progress.totalFiles}. Bytes: {size(value.progress.bytesDone)} / {size(value.progress.bytesTotal)}.</p>
    {value.reason && <p className="warning-card">{reasonText(value.reason)}.</p>}
    <div className="storage-candidate-actions">{controls.map(action => <button key={action} className="button" disabled={busy}
      ref={button => { if (button) controlButtons.current.set(action, button); else controlButtons.current.delete(action); }}
      onClick={event => { const origin = event.currentTarget, hadFocus = document.activeElement === origin; onControl(action, signal => {
        if (hadFocus && (document.activeElement === origin || document.activeElement === document.body)) returnFocus.current = { action, origin, signal };
      }); }}>
      {action === "cleanup" ? "Clean up job artifacts" : action[0].toUpperCase() + action.slice(1)}</button>)}
      {value.kind === "upload" && <button className="button" disabled={busy} onClick={onSelectUpload}>Select saved upload</button>}
      {(value.state === "preview" || value.state === "completed" || value.result) && <button className="button" disabled={busy} onClick={onReport}>View recovery report</button>}
      {value.output?.available && <a className="button" href={systemRecoveryClient.downloadUrl(value.id)} download>Download system backup</a>}
      {value.kind === "recovery" && value.result?.ready && !value.result.cutover && <button className="button" disabled={busy} onClick={onCutover}>Review cutover preparation</button>}
    </div>
    {value.output && <p className="muted">Output: {size(value.output.byteSize)}. Expires <time dateTime={value.output.expiresAt}>{value.output.expiresAt}</time>.</p>}
    {value.result && <p role="status">Target <code>{value.result.targetId}</code>: {value.result.cutover ? "cutover handoff prepared" : value.result.ready ? "verified and ready for cutover review" : "staged; verification is incomplete"}.</p>}
    <small className="muted">Updated <time dateTime={value.updatedAt}>{value.updatedAt}</time>.</small>
  </article>;
}

export function SystemRecoveryPage() {
  const [capability, setCapability] = useState<SystemRecoveryCapabilities | null>(null);
  const capabilityRef = useRef(capability);
  const [backupPreview, setBackupPreview] = useState<SystemRecoveryBackupPreview | null>(null);
  const [backupMode, setBackupMode] = useState<"historical" | "planned">("historical");
  const [maintenance, setMaintenance] = useState<SystemRecoveryMaintenanceStatus | null>(null);
  const [pendingMaintenance, setPendingMaintenance] = useState<SystemRecoveryMaintenanceInput | null>(savedMaintenance);
  const pendingMaintenanceRef = useRef(pendingMaintenance);
  const [sourceRelease, setSourceRelease] = useState<SourceRelease | null>(savedSourceRelease);
  const sourceReleaseRef = useRef(sourceRelease);
  const [pendingSourceResume, setPendingSourceResume] = useState<SystemRecoverySourceResumeInput | null>(savedSourceResume);
  const pendingSourceResumeRef = useRef(pendingSourceResume);
  const [executorUncertain, setExecutorUncertain] = useState(false);
  const [jobs, setJobs] = useState<SystemRecoveryJobStatus[]>([]);
  const [pending, setPending] = useState<Intent | null>(savedIntent), pendingRef = useRef(pending);
  const [upload, setUpload] = useState<UploadCheckpoint | null>(savedUpload), uploadRef = useRef(upload);
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<SystemRecoveryPreview | null>(null);
  const [reportJobId, setReportJobId] = useState<string | null>(null), reportJobRef = useRef<string | null>(null);
  const [mapping, setMapping] = useState<SystemRecoveryStorageMapping[]>([]);
  const [mode, setMode] = useState<"historical" | "planned">("historical");
  const [acknowledgeLaterChanges, setAcknowledgeLaterChanges] = useState(false);
  const [cutoverJob, setCutoverJob] = useState<SystemRecoveryJobStatus | null>(null), [cutoverAcknowledged, setCutoverAcknowledged] = useState(false);
  const cutoverRef = useRef(cutoverJob); cutoverRef.current = cutoverJob;
  const [readPhase, setReadPhase] = useState<"loading" | "ready" | "error">("loading"), [readError, setReadError] = useState<string | null>(null);
  const [jobsLoaded, setJobsLoaded] = useState(false), [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [denied, setDenied] = useState(false), deniedRef = useRef(false), [message, setMessageText] = useState("");
  const [messageError, setMessageError] = useState(false);
  const backupPreviewButton = useRef<HTMLButtonElement>(null);
  const returnBackupPreviewFocus = useRef<{ button: HTMLButtonElement; signal: AbortSignal } | null>(null);
  const lifetime = useRef<AbortController | null>(null), refreshSequence = useRef(0), reportSequence = useRef(0), reportIdentity = useRef("");
  const activeRead = useRef<Promise<void> | null>(null);
  const exclusiveOperation = useRef(false);
  const currentUpload = upload ? jobs.find(job => job.id === upload.jobId) : null;

  function setMessage(value: string) { setMessageText(value); setMessageError(false); }

  function failure(error: unknown) {
    if (error instanceof SystemRecoveryRequestError && [401, 403].includes(error.status || 0)) {
      deniedRef.current = true; setDenied(true); setJobs([]); setPreview(null); setBackupPreview(null); setCutoverJob(null); setFile(null); setMapping([]);
    }
    setMessageText(error instanceof SessionIntentError ? error.message : systemRecoveryErrorMessage(error)); setMessageError(true);
  }
  function remember(value: Intent | null) { storeSession(intentKey, value); pendingRef.current = value; setPending(value); }
  function saveUpload(value: UploadCheckpoint | null) { storeSession(uploadKey, value); uploadRef.current = value; setUpload(value); }
  function rememberMaintenance(value: SystemRecoveryMaintenanceInput | null) {
    storeSession(maintenanceKey, value); pendingMaintenanceRef.current = value; setPendingMaintenance(value);
  }
  function rememberSourceResume(value: SystemRecoverySourceResumeInput | null) {
    storeSession(sourceResumeKey, value); pendingSourceResumeRef.current = value; setPendingSourceResume(value);
  }
  function updateJob(value: SystemRecoveryJobStatus) { setJobs(current => [value, ...current.filter(job => job.id !== value.id)].slice(0, 100)); }
  function accept(intent: Intent, receipt: SystemRecoveryReceipt) {
    const expectedKind = intent.action === "cutover" ? "recovery" : intent.action;
    if (receipt.requestId !== intent.input.requestId || receipt.job.kind !== expectedKind || intent.action === "cutover" && receipt.job.id !== intent.jobId) {
      throw new Error("Invalid system recovery receipt.");
    }
    updateJob(receipt.job);
    if (intent.action === "upload") saveUpload({ input: intent.input, jobId: receipt.job.id });
    storeSession(receiptsKey, [{ requestId: receipt.requestId, jobId: receipt.job.id },
      ...savedReceipts().filter(row => row.requestId !== receipt.requestId)].slice(0, 20));
    remember(null);
    if (intent.action === "backup") setBackupPreview(null);
    if (intent.action === "cutover") { setCutoverJob(receipt.job); setCutoverAcknowledged(false); }
    setMessage(intent.action === "cutover" ? "Cutover handoff saved. A deployment operator must review and activate the isolated target; this page has not changed the running database binding."
      : receipt.reused ? "The original saved operation was returned. No new recovery was started."
        : "Operation saved. You may leave this page; the independently invoked executor owns its progress.");
    return receipt.job;
  }
  async function submit(intent: Intent, signal: AbortSignal) {
    let receipt: SystemRecoveryReceipt;
    try {
      receipt = intent.action === "backup" ? await systemRecoveryClient.backup(intent.input, signal)
        : intent.action === "upload" ? await systemRecoveryClient.acceptUpload(intent.input, signal)
          : intent.action === "recovery" ? await systemRecoveryClient.restore(intent.input, signal)
            : await systemRecoveryClient.cutover(intent.jobId, intent.input, signal);
    } catch (error) {
      if (signal.aborted) return null;
      if (error instanceof SystemRecoveryRequestError && error.status === 409) {
        try { receipt = await systemRecoveryClient.readRequest(intent.input.requestId, signal); }
        catch (lookup) {
          if (signal.aborted) return null;
          if (lookup instanceof SystemRecoveryRequestError && lookup.status === 404) {
            remember(null); setPreview(null); setBackupPreview(null); setCutoverJob(null);
            setMessage("The preview, mapping or target changed before acceptance. Refresh the recovery report before starting new work."); return null;
          }
          throw lookup;
        }
      } else throw error;
    }
    if (signal.aborted || deniedRef.current) return null;
    return accept(intent, receipt);
  }
  async function reconcile(signal: AbortSignal, retryMissing = false) {
    const intent = pendingRef.current; if (!intent) return;
    try { const receipt = await systemRecoveryClient.readRequest(intent.input.requestId, signal); if (!signal.aborted && !deniedRef.current) accept(intent, receipt); }
    catch (error) {
      if (signal.aborted) return;
      if (retryMissing && error instanceof SystemRecoveryRequestError && error.status === 404) { await submit(intent, signal); return; }
      if (error instanceof SystemRecoveryRequestError && error.status === 404) setMessage("No receipt is recorded yet. An explicit retry uses the original request and identifier.");
      else throw error;
    }
  }
  async function loadReport(id: string, signal: AbortSignal) {
    const sequence = ++reportSequence.current;
    if (reportJobRef.current !== id) setPreview(null);
    reportJobRef.current = id; setReportJobId(id);
    const value = await systemRecoveryClient.preview(id, signal);
    if (signal.aborted || deniedRef.current || sequence !== reportSequence.current || reportJobRef.current !== id) return;
    const identity = JSON.stringify([id, value.archive.sha256, value.target.id, value.source.checkpoint]);
    if (identity !== reportIdentity.current) {
      reportIdentity.current = identity; setAcknowledgeLaterChanges(false); setMode(value.source.mode);
      setMapping(value.profiles.map(profile => ({ sourceProfileId: profile.id, destinationProfileId: "", configurationRevision: 1 })));
    }
    setPreview(value);
  }
  async function refresh(signal: AbortSignal, announce = false) {
    if (activeRead.current) { await activeRead.current; return; }
    const reading = readStatus(signal, announce); activeRead.current = reading;
    try { await reading; }
    finally { if (activeRead.current === reading) activeRead.current = null; }
  }
  async function readStatus(signal: AbortSignal, announce = false) {
    if (signal.aborted || deniedRef.current) return;
    const sequence = ++refreshSequence.current;
    if (announce) setReadPhase("loading");
    try {
      const access = await systemRecoveryClient.capabilities(signal);
      if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current) return;
      setCapability(access);
      capabilityRef.current = access;
      if (!access.canManage) {
        deniedRef.current = true; setDenied(true); setJobs([]); setPreview(null); setBackupPreview(null);
        setCutoverJob(null); setFile(null); setMapping([]); return;
      }
      if (pendingMaintenanceRef.current) await reconcileMaintenance(signal);
      if (pendingSourceResumeRef.current) await reconcileSourceResume(signal);
      if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current) return;
      const [list, maintenanceStatus] = await Promise.all([systemRecoveryClient.list(signal), systemRecoveryClient.maintenance(signal)]);
      const resumeContext = sourceReleaseRef.current;
      const ids = [...new Set([...savedReceipts().map(row => row.jobId), ...(resumeContext ? [resumeContext.backupJobId] : [])])]
        .filter(id => !list.some(job => job.id === id));
      const recovered = await Promise.all(ids.map(async id => {
        try { return await systemRecoveryClient.status(id, signal); }
        catch (error) { if (error instanceof SystemRecoveryRequestError && [404, 410].includes(error.status || 0)) return null; throw error; }
      }));
      if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current) return;
      const visible = [...recovered.filter((job): job is SystemRecoveryJobStatus => job !== null), ...list].slice(0, 100);
      setJobs(visible); setMaintenance(maintenanceStatus); setExecutorUncertain(false); setJobsLoaded(true); setReadError(null); setReadPhase("ready");
      const checkpoint = uploadRef.current;
      if (checkpoint) {
        const value = visible.find(job => job.id === checkpoint.jobId) || await systemRecoveryClient.status(checkpoint.jobId, signal);
        if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current || uploadRef.current?.jobId !== checkpoint.jobId) return;
        if (!visible.some(job => job.id === value.id)) updateJob(value);
        if (value.state === "preview" && (!reportJobRef.current || reportJobRef.current === value.id)) await loadReport(value.id, signal);
      }
      if (cutoverRef.current) {
        const latest = visible.find(job => job.id === cutoverRef.current?.id); if (latest) setCutoverJob(latest);
      }
    } catch (error) {
      if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current) return;
      if (error instanceof SystemRecoveryRequestError && [401, 403].includes(error.status || 0)) failure(error);
      else { setReadError("Recovery access or status could not be read. Retry the status check."); setReadPhase("error"); }
    }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (controller.signal.aborted || deniedRef.current) return;
      if (!exclusiveOperation.current) await refresh(controller.signal);
      if (!controller.signal.aborted && !deniedRef.current) timer = setTimeout(() => void poll(), 5000);
    };
    void (async () => {
      if (pendingRef.current) {
        try { await reconcile(controller.signal); } catch (error) { if (!controller.signal.aborted) failure(error); }
      }
      if (!controller.signal.aborted && !deniedRef.current) await poll();
    })();
    return () => { controller.abort(); refreshSequence.current++; reportSequence.current++; if (timer) clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (busy || !returnBackupPreviewFocus.current) return;
    const { button, signal } = returnBackupPreviewFocus.current;
    returnBackupPreviewFocus.current = null;
    if (signal !== lifetime.current?.signal || signal.aborted || deniedRef.current) return;
    if (button === backupPreviewButton.current && button.isConnected && !button.matches(":disabled")
      && (document.activeElement === document.body || document.activeElement === button)) button.focus();
  }, [busy]);
  async function act(operation: (signal: AbortSignal) => Promise<unknown>, preserveMessage = false, exclusive = false) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || deniedRef.current || busyRef.current) return;
    busyRef.current = true; exclusiveOperation.current = exclusive; setBusy(true); if (!preserveMessage) setMessage("");
    try {
      // A source resume validates the original backup under exclusive Recovery
      // ownership. Finish the page's existing reads before issuing a mutation.
      if (exclusive && activeRead.current) await activeRead.current;
      if (!controller.signal.aborted && !deniedRef.current) await operation(controller.signal);
    }
    catch (error) { if (!controller.signal.aborted) failure(error); }
    finally { if (!controller.signal.aborted) { busyRef.current = false; exclusiveOperation.current = false; setBusy(false); } }
  }
  async function prepareUpload(signal: AbortSignal) {
    if (!file || pendingRef.current) return;
    if (file.size < 22 || file.size > SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES) { setMessage("Select a supported ZIP between 22 bytes and 100 MiB."); return; }
    setMessage("Checking the selected archive with a bounded streaming hash…");
    const measured = await hashResearchFile(file, { maxBytes: SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES, signal });
    if (signal.aborted) return;
    const checkpoint = uploadRef.current; let id: string;
    if (checkpoint) {
      if (currentUpload?.state !== "awaiting_upload") { setMessage("Select another archive or finish the saved validation before uploading new bytes."); return; }
      if (checkpoint.input.sha256 !== measured.sha256 || checkpoint.input.byteSize !== measured.byteSize) {
        setMessage("This file differs from the accepted upload. Reselect the original archive or cancel its saved validation job."); return;
      }
      id = checkpoint.jobId;
    } else {
      const intent: Intent = { action: "upload", input: checkedSystemRecoveryUploadInput({ requestId: crypto.randomUUID(), ...measured }) };
      remember(intent); const accepted = await submit(intent, signal); if (!accepted || signal.aborted) return; id = accepted.id;
    }
    const value = await systemRecoveryClient.upload(id, file, signal);
    if (!signal.aborted && !deniedRef.current) { updateJob(value); setFile(null); setPreview(null); setMessage("Archive bytes accepted. The independent executor validates inventory, canonical data and file hashes before recovery can be reviewed."); }
  }
  async function changeMaintenance(input: SystemRecoveryMaintenanceInput, signal: AbortSignal) {
    let receipt: SystemRecoveryMaintenanceReceipt;
    try { receipt = await systemRecoveryClient.changeMaintenance(input, signal); }
    catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof SystemRecoveryRequestError) || error.status !== 409) throw error;
      try { receipt = await systemRecoveryClient.readMaintenanceRequest(input.requestId, signal); }
      catch (lookup) {
        if (signal.aborted) return;
        if (lookup instanceof SystemRecoveryRequestError && lookup.status === 404) {
          // A definitive atomic CAS rejection and absent exact receipt do not
          // authorize replay with a new generation. Refresh before new intent.
          rememberMaintenance(null); await refresh(signal);
          setMessage("The source window changed before this maintenance operation was accepted. Review current state before a new action."); return;
        }
        throw lookup;
      }
    }
    if (signal.aborted || deniedRef.current) return;
    acceptMaintenance(input, receipt); setBackupPreview(null); setPreview(null);
    setMessage(input.action === "enter" ? "The source write window is draining. Existing accepted writers must positively settle before fencing."
      : input.action === "finalize" ? "The source write fence was confirmed. Capture and verify the final planned backup before cutover."
        : "The source maintenance window was released. Earlier planned checkpoints require fresh review.");
    await refresh(signal);
  }
  function acceptMaintenance(input: SystemRecoveryMaintenanceInput, receipt: SystemRecoveryMaintenanceReceipt) {
    if (receipt.requestId !== input.requestId || receipt.action !== input.action || receipt.expectedGeneration !== input.expectedGeneration) {
      throw new Error("Invalid maintenance operation receipt.");
    }
    if (input.action === "release" && capabilityRef.current?.policy.sourceResume) {
      let backupJobId: string | null | undefined;
      try {
        const saved = JSON.parse(sessionStorage.getItem(sourceBackupKey) || "null");
        if (saved?.generation === input.expectedGeneration && localIdentity(saved.jobId)) backupJobId = saved.jobId;
      } catch { /* An absent local checkpoint cannot select a different backup. */ }
      if (!backupJobId && maintenance?.generation === input.expectedGeneration) backupJobId = maintenance.backupJobId;
      if (backupJobId) {
        const context = { release: receipt, backupJobId };
        storeSession(sourceReleaseKey, context); sourceReleaseRef.current = context; setSourceRelease(context);
      }
    }
    setMaintenance(receipt.status); rememberMaintenance(null);
  }
  async function reconcileMaintenance(signal: AbortSignal, retryMissing = false) {
    const input = pendingMaintenanceRef.current; if (!input) return;
    try {
      const receipt = await systemRecoveryClient.readMaintenanceRequest(input.requestId, signal);
      if (!signal.aborted && !deniedRef.current) acceptMaintenance(input, receipt);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof SystemRecoveryRequestError && error.status === 404) {
        if (retryMissing) await changeMaintenance(input, signal);
        else setMessage("No maintenance receipt is recorded yet. Keep its original identifier and explicitly retry after reviewing source state.");
      } else throw error;
    }
  }
  async function beginMaintenance(action: SystemRecoveryMaintenanceInput["action"], signal: AbortSignal) {
    if (!maintenance || pendingMaintenanceRef.current || pendingRef.current || pendingSourceResumeRef.current) return;
    if (action === "release" && capability?.policy.sourceResume && maintenance.backupJobId) {
      storeSession(sourceBackupKey, { jobId: maintenance.backupJobId, generation: maintenance.generation });
    }
    const input = checkedSystemRecoveryMaintenanceInput({ requestId: crypto.randomUUID(), action, expectedGeneration: maintenance.generation });
    rememberMaintenance(input); await changeMaintenance(input, signal);
  }
  function acceptSourceResume(input: SystemRecoverySourceResumeInput, receipt: SystemRecoverySourceResumeReceipt) {
    if (receipt.requestId !== input.requestId || receipt.releaseRequestId !== input.releaseRequestId
      || receipt.backupJobId !== input.backupJobId || receipt.expectedGeneration !== input.expectedGeneration) throw new Error("Invalid source resume receipt.");
    rememberSourceResume(null); storeSession(sourceReleaseKey, null); storeSession(sourceBackupKey, null); sourceReleaseRef.current = null; setSourceRelease(null);
    setMessage("Original source writes are enabled. Shadow conversion and file jobs remain paused; no target binding changed and no old work was replayed.");
  }
  async function submitSourceResume(input: SystemRecoverySourceResumeInput, signal: AbortSignal) {
    let receipt: SystemRecoverySourceResumeReceipt;
    try { receipt = await systemRecoveryClient.resumeSource(input, signal); }
    catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof SystemRecoveryRequestError) || error.status !== 409) throw error;
      try { receipt = await systemRecoveryClient.readSourceResumeRequest(input.requestId, signal); }
      catch (lookup) {
        if (signal.aborted) return;
        if (lookup instanceof SystemRecoveryRequestError && lookup.status === 404) {
          rememberSourceResume(null); await refresh(signal);
          setMessage("Source resume was not accepted. Review the released source window and its completed backup before trying again."); return;
        }
        throw lookup;
      }
    }
    if (!signal.aborted && !deniedRef.current) acceptSourceResume(input, receipt);
  }
  async function reconcileSourceResume(signal: AbortSignal, retryMissing = false) {
    const input = pendingSourceResumeRef.current; if (!input) return;
    try {
      const receipt = await systemRecoveryClient.readSourceResumeRequest(input.requestId, signal);
      if (!signal.aborted && !deniedRef.current) acceptSourceResume(input, receipt);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof SystemRecoveryRequestError && error.status === 404) {
        if (retryMissing && capability?.policy.sourceResume) await submitSourceResume(input, signal);
        else setMessage("Source resume is unconfirmed. Check its original receipt before explicitly retrying the same request.");
      } else throw error;
    }
  }
  const blocked = busy || !!pending || !!pendingMaintenance || !!pendingSourceResume || denied || !capability?.canManage;
  const isSelectedUpload = !!upload && reportJobId === upload.jobId;
  const readyReportJob = jobs.find(job => job.id === reportJobId && job.kind === "recovery" && job.state === "completed"
    && job.phase === "ready" && job.result?.ready);
  const preserveProfiles = capability?.policy.recoveryMapping === "inert-preserve";
  const mappingValid = !!preview && (preserveProfiles || mapping.length === preview.profiles.length && mapping.every(row => localIdentity(row.destinationProfileId)
    && Number.isSafeInteger(row.configurationRevision) && row.configurationRevision >= 1));
  const backupNeedsFence = capability?.policy.backupMaintenance === "always" || backupMode === "planned";
  const sourceResumeBackup = sourceRelease && jobs.find(job => job.id === sourceRelease.backupJobId && job.kind === "backup" && job.state === "completed");
  const mayResumeSource = !!capability?.policy.sourceResume && !capability.enabled && !executorUncertain && !!sourceRelease && !!sourceResumeBackup && maintenance?.state === "open"
    && sourceRelease.release.status.generation === maintenance.generation;
  const plannedReady = capability?.maintenance.state === "fenced" && !!preview?.source.checkpoint
    && capability.maintenance.checkpoint === preview.source.checkpoint;
  const mayRecover = !!preview?.canRecover && preview.target.available && !!preview.target.id && mappingValid
    && preview.archive.complete && (mode === "historical" ? acknowledgeLaterChanges : plannedReady);
  async function startRecovery(signal: AbortSignal) {
    if (!mayRecover || !preview || !upload || !isSelectedUpload || pendingRef.current) return;
    const intent: Intent = { action: "recovery", input: checkedSystemRecoveryImportInput({ requestId: crypto.randomUUID(), uploadJobId: upload.jobId,
      expectedTargetId: preview.target.id, mapping: preserveProfiles ? [] : mapping, mode, acknowledgeLaterChanges: mode === "historical" && acknowledgeLaterChanges, acknowledgePartial: false }) };
    remember(intent); await submit(intent, signal);
  }
  async function prepareCutover(signal: AbortSignal) {
    if (!cutoverJob?.result?.ready || cutoverJob.result.cutover || !cutoverAcknowledged || !preview?.canCutover
      || reportJobId !== cutoverJob.id || !cutoverJob.result.checkpoint || pendingRef.current) return;
    const intent: Intent = { action: "cutover", jobId: cutoverJob.id, input: checkedSystemRecoveryCutoverInput({ requestId: crypto.randomUUID(),
      expectedTargetId: cutoverJob.result.targetId, expectedCheckpoint: cutoverJob.result.checkpoint }) };
    remember(intent); await submit(intent, signal);
  }

  return <div className="page storage-settings-page system-recovery-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>System backup and recovery</h1>
      <p className="lead">Preserve installation identities and history, then verify recovery in an isolated target before an administrator prepares a deployment handoff.</p></div>
      <button className="button" disabled={busy || denied} onClick={() => void act(signal => refresh(signal, true), true)}>Refresh recovery status</button></div>
    <nav className="system-recovery-navigation" aria-label="Data settings"><Link to="/settings/data">Research packages and reports</Link>
      <Link to="/settings/storage">Storage settings</Link><Link to="/export">Legacy content archive</Link></nav>
    {message && (denied || !messageError) && <p role={denied ? "alert" : "status"}>{message}</p>}
    <ReadStatus loading={readPhase === "loading" && !denied} loadingMessage="Reading administrator recovery access…"
      error={!denied ? readError : null} errorTitle="Recovery status unavailable"
      onRetry={() => void act(signal => refresh(signal, true), true)} retryLabel="Retry reading recovery status" />
    <ReadStatus loading={false} loadingMessage="" error={!denied && messageError ? message : null} errorTitle="Recovery operation unavailable"
      onRetry={() => void act(signal => refresh(signal, true), true)} retryLabel="Read current recovery status" />
    {denied ? <section className="card storage-settings-section"><h2 className="card-title">Administrator access required</h2>
      <p>Sign in with a verified system administrator account to create backups or recover an installation. Saved operation identifiers remain available for reconciliation after access is restored.</p></section>
      : capability?.canManage && <>
      <section className="card storage-settings-section"><h2 className="card-title">Recovery runtime</h2>
        <p>{!capability.supported ? "System recovery is unavailable on this runtime." : !capability.enabled ? "Independent execution is paused." : capability.stale ? "Execution is enabled, but no recent heartbeat was recorded." : "Independent execution is enabled."}</p>
        {capability.reason && <p className="muted">{reasonText(capability.reason)}.</p>}
        <p className="muted">Saved work persists after the browser closes. Refreshing and polling only read status. Supported ZIP limits: 100 MiB total, 96 MiB file content, 100 physical files and 4 MiB metadata; each execution step is bounded to 60 seconds.</p>
        <p>Isolated target: {capability.target.configured ? <code>{capability.target.id}</code> : "Not configured"}. Source maintenance: {reasonText(capability.maintenance.state)}.</p>
        <p className="muted">Target provisioning, authentication, encryption roots and database binding activation are deployment responsibilities. {preserveProfiles
          ? "Recovered files are staged in the isolated target's inert local volume; source profile evidence is retained."
          : "Storage mappings allocate isolated recovery keys and never overwrite source objects."}</p>
        <p><Link to="/settings/storage/migrations">Administrator executor controls</Link></p>
        <div className="storage-candidate-actions"><button className="button" disabled={blocked || !capability.supported || executorUncertain} onClick={() => void act(async signal => {
          try {
            const value = await systemRecoveryClient.configureExecutor(!capability.enabled, signal);
            if (!signal.aborted && !deniedRef.current) { setCapability(value); setMessage("Executor configuration saved. Paused jobs require explicit resume; this action did not replay old work."); }
          } catch (error) { if (!signal.aborted) setExecutorUncertain(true); throw error; }
        })}>{capability.enabled ? "Disable system recovery executor" : "Enable system recovery executor"}</button></div>
        {executorUncertain && <p className="warning-card">Executor configuration is unconfirmed. Refresh its saved state before changing it again.</p>}
      </section>
      <section className="card storage-settings-section"><h2 className="card-title">Source maintenance window</h2>
        <p className="muted">{capability.policy.backupMaintenance === "always"
          ? "This runtime requires a fenced and drained source for every system backup, including historical backups. A recovery target is optional for creating a backup."
          : "Ordinary historical backups do not require a maintenance window. Planned migration requires a fenced and drained source before the final snapshot."} Stop new source writes, drain accepted work, then confirm the fence. Reads remain available where safe.</p>
        {maintenance && <><p>State: {reasonText(maintenance.state)}. Active accepted writers: {maintenance.activeWriters}. Generation: {maintenance.generation}.</p>
          {maintenance.checkpoint && <p className="muted">Frozen source checkpoint: <code>{maintenance.checkpoint}</code>.</p>}
          <div className="storage-candidate-actions"><button className="button" disabled={blocked || !capability.target.configured && !capability.policy.maintenanceWithoutTarget || maintenance.state !== "open"} onClick={() => void act(signal => beginMaintenance("enter", signal))}>Stop new source writes</button>
            <button className="button" disabled={blocked || maintenance.state !== "draining" || maintenance.activeWriters !== 0} onClick={() => void act(signal => beginMaintenance("finalize", signal))}>Confirm drained source fence</button>
            <button className="button" disabled={blocked || maintenance.state === "open"} onClick={() => void act(signal => beginMaintenance("release", signal))}>Release source maintenance window</button></div>
          <p className="muted">Unknown provider writes must settle positively. Expired leases never force a writer to be considered drained.</p></>}
        {capability.policy.sourceResume && <div className="system-recovery-handoff">
          <h3>Resume the original source</h3>
          <p>Releasing maintenance does not enable source writes on this runtime. After a completed backup and its accepted release, pause the recovery executor and let accepted work settle before explicitly resuming the unchanged original source. Shadow conversion and file jobs stay paused.</p>
          {sourceRelease && <p>Released window: <code>{sourceRelease.release.requestId}</code>. Backup: <code>{sourceRelease.backupJobId}</code>.</p>}
          <button className="button" disabled={blocked || !mayResumeSource} onClick={() => void act(async signal => {
            if (!sourceRelease || !mayResumeSource) return;
            const input = checkedSystemRecoverySourceResumeInput({ requestId: crypto.randomUUID(), releaseRequestId: sourceRelease.release.requestId,
              backupJobId: sourceRelease.backupJobId, expectedGeneration: sourceRelease.release.status.generation });
            rememberSourceResume(input); await submitSourceResume(input, signal);
          }, false, true)}>Resume source writes after backup</button>
          {!sourceRelease && <p className="muted">Create a backup in this maintenance window, then release the window to retain its source resume identifiers.</p>}
        </div>}
        {pendingSourceResume && <><p className="warning-card">Source resume request <code>{pendingSourceResume.requestId}</code> is unconfirmed. Its original release, backup and generation are retained.</p>
          <button className="button" disabled={busy} onClick={() => void act(signal => reconcileSourceResume(signal, true), false, true)}>Check or retry original source resume request</button></>}
        {pendingMaintenance && <><p className="warning-card">The {pendingMaintenance.action} maintenance request <code>{pendingMaintenance.requestId}</code> is unconfirmed. Review current state before retrying its original identifier.</p>
          <button className="button" disabled={busy} onClick={() => void act(async signal => {
            const value = await systemRecoveryClient.maintenance(signal); if (!signal.aborted && !deniedRef.current) setMaintenance(value);
          })}>Read source maintenance state</button>
          <button className="button" disabled={busy} onClick={() => void act(signal => reconcileMaintenance(signal, true))}>Check or retry original maintenance request</button></>}
      </section>
      {pending && <section className="card storage-settings-section"><h2 className="card-title">Unconfirmed operation</h2>
        <p>The {pending.action} request <code>{pending.input.requestId}</code> is retained. Check its saved receipt before starting another operation.</p>
        <button className="button" disabled={busy} onClick={() => void act(signal => reconcile(signal, true))}>Check or retry original request</button></section>}
      <section className="card storage-settings-section"><h2 className="card-title">Create a system backup</h2>
        <p className="muted">Includes canonical identities, history, recoverable deletion states, promised files and eligible protected settings. Encrypted external credentials require a separately provisioned recovery key. Protect the downloaded archive accordingly.</p>
        <label>System backup mode<select value={backupMode} disabled={blocked} onChange={event => { setBackupMode(event.target.value as "historical" | "planned"); setBackupPreview(null); }}>
          <option value="historical">Ordinary historical backup</option><option value="planned">Final planned migration snapshot</option></select></label>
        <button ref={backupPreviewButton} className="button" disabled={blocked || !capability.supported} onClick={() => {
          const button = backupPreviewButton.current;
          const hadFocus = !!button && document.activeElement === button;
          void act(async signal => {
            returnBackupPreviewFocus.current = button && hadFocus && (document.activeElement === button || document.activeElement === document.body) ? { button, signal } : null;
            const value = await systemRecoveryClient.backupPreview(signal); if (!signal.aborted && !deniedRef.current) setBackupPreview(value);
          });
        }}>Preview system backup</button>
        {backupPreview && <><p>Source maintenance: {reasonText(backupPreview.maintenance.state)}. {backupPreview.available ? "The bounded backup can be accepted." : "Backup acceptance is unavailable."}</p>
          <ul>{backupPreview.reasons.map(code => <li key={code}>{reasonText(code)}</li>)}</ul>
          <p className="muted">Final file outcomes determine whether the archive is complete. Missing bytes remain visible in its recovery report.</p>
          {backupNeedsFence && backupPreview.maintenance.state !== "fenced" && <p className="warning-card">Drain and fence the source before accepting this system backup.</p>}
          <button className="button primary" disabled={blocked || !backupPreview.available || backupNeedsFence && backupPreview.maintenance.state !== "fenced"} onClick={() => void act(async signal => {
            const intent: Intent = { action: "backup", input: checkedSystemRecoveryBackupInput({ requestId: crypto.randomUUID(), kind: "backup", mode: backupMode }) };
            remember(intent); await submit(intent, signal);
          })}>Start durable system backup</button></>}
      </section>
      <section className="card storage-settings-section"><h2 className="card-title">Validate a recovery archive</h2>
        <p className="muted">System backup and supported historical content ZIPs preserve identities. Research-copy packages and reports use their separate import flow. Validation does not replace the live database.</p>
        <label>System recovery ZIP<input type="file" accept=".zip,application/zip" disabled={blocked || !capability.supported || !!upload && currentUpload?.state !== "awaiting_upload"}
          onChange={event => setFile(event.target.files?.[0] || null)} /></label>
        {upload && <p className="muted">Saved validation job: <code>{upload.jobId}</code>. {currentUpload?.state === "awaiting_upload" && <>Reselect the original {size(upload.input.byteSize)} archive to verify and resume its upload.</>}</p>}
        <div className="storage-candidate-actions"><button className="button" disabled={blocked || !file || !capability.supported} onClick={() => void act(prepareUpload)}>
          {upload ? "Resume original recovery upload" : "Upload and validate recovery archive"}</button>
          {upload && <button className="button" disabled={blocked || currentUpload?.state !== "preview"} onClick={() => void act(signal => loadReport(upload.jobId, signal))}>Refresh recovery report</button>}
          {upload && <button className="text-button" disabled={blocked} onClick={() => {
            try { saveUpload(null); setFile(null); setPreview(null); reportJobRef.current = null; setReportJobId(null); reportSequence.current++; }
            catch (error) { failure(error); }
          }}>Select another recovery archive</button>}</div>
        <p className="muted">Selecting another archive retains existing jobs. Raw uploads are validated by the server before any target state is published.</p>
      </section>
      {preview && <section className="card storage-settings-section"><h2 className="card-title">Recovery report</h2><p><code>{reportJobId}</code></p><Report value={preview} />
        {readyReportJob && <p><a className="button" href={systemRecoveryClient.reportDownloadUrl(readyReportJob.id)} download>Download verified recovery report</a>
          <small className="muted"> Includes verified hashes, disabled execution, audited change counts and operator handoff steps.</small></p>}
        {isSelectedUpload && <><h3>Recover into the fresh target</h3><p>Target: {preview.target.id ? <code>{preview.target.id}</code> : "Not configured"}.
          {!preview.target.available && <> {preview.target.reason ? reasonText(preview.target.reason) : "Target staging is unavailable"}.</>}</p>
          <fieldset disabled={blocked}><label>Recovery mode<select value={mode} onChange={event => { setMode(event.target.value as "historical" | "planned"); setAcknowledgeLaterChanges(false); }}>
            <option value="historical">Restore the archive recovery point</option><option value="planned">Planned installation migration</option></select></label>
            {mode === "historical" ? <label><input type="checkbox" checked={acknowledgeLaterChanges} onChange={event => setAcknowledgeLaterChanges(event.target.checked)} />
              <span>I understand that this recovers the archive recovery point and does not include later source changes.</span></label>
              : <p className={plannedReady ? "muted" : "warning-card"}>Planned migration requires fenced and drained source writers, a final snapshot, and an unchanged source checkpoint at cutover. {plannedReady ? "The report matches the current fenced checkpoint." : "The current source has not satisfied that checkpoint requirement."}</p>}
            {!preserveProfiles && preview.profiles.length > 0 && <div className="system-recovery-table"><table><thead><tr><th>Source profile</th><th>Destination profile</th><th>Configuration revision</th></tr></thead><tbody>
              {mapping.map((row, index) => <tr key={row.sourceProfileId}><td><code>{row.sourceProfileId}</code><p className="muted">{preview.profiles[index]?.adapterType}</p></td>
                <td><label>Destination for {row.sourceProfileId}<input value={row.destinationProfileId} maxLength={128} onChange={event => setMapping(current => current.map((value, at) => at === index ? { ...value, destinationProfileId: event.target.value } : value))} /></label></td>
                <td><label>Revision for {row.sourceProfileId}<input type="number" min={1} step={1} value={row.configurationRevision} onChange={event => setMapping(current => current.map((value, at) => at === index ? { ...value, configurationRevision: Number(event.target.value) } : value))} /></label></td></tr>)}
            </tbody></table></div>}
            {preserveProfiles ? <><p className="muted">The isolated target preserves source profile evidence and stages verified files in its inert local volume. Destination mappings are not accepted. Review and configure storage separately before target activation.</p>
              {preview.profiles.length > 0 && <ul>{preview.profiles.map(profile => <li key={profile.id}><code>{profile.id}</code> · {profile.adapterType}</li>)}</ul>}</>
              : <p className="muted">Map every source profile to a verified target profile. Recorded file purposes remain intact; destination profile identities and revisions freeze with the accepted operation.</p>}
            {!preview.archive.complete && <p className="warning-card">Partial archives remain available for inspection. Resolve unavailable required files and create a verified complete backup before staging recovery.</p>}
            <button className="button primary" disabled={!mayRecover} onClick={() => void act(startRecovery)}>Stage isolated recovery</button>
          </fieldset></>}
      </section>}
      {cutoverJob?.result && <section className="card storage-settings-section"><h2 className="card-title">Cutover preparation</h2>
        <div className="system-recovery-handoff"><p>Verified target: <code>{cutoverJob.result.targetId}</code>. Recovery checkpoint: <code>{cutoverJob.result.checkpoint}</code>.</p>
          <p>Review data, file hashes, protected configuration and disabled old jobs in the recovery report. The deployment operator activates the target database and file configuration separately.</p>
          <p className="muted">Keep the source available for reads until handoff acceptance. Once the target accepts new writes, switching back requires reconciliation; automatic rollback is unsafe.</p>
          {cutoverJob.result.cutover ? <p role="status">Cutover handoff prepared. Review deployment activation separately.</p> : <>
            <label><input type="checkbox" disabled={blocked} checked={cutoverAcknowledged} onChange={event => setCutoverAcknowledged(event.target.checked)} />
              <span>I reviewed this verified target and understand that activation is a separate deployment operation.</span></label>
            <button className="button primary" disabled={blocked || !cutoverAcknowledged || !cutoverJob.result.ready || !preview?.canCutover || reportJobId !== cutoverJob.id}
              onClick={() => void act(prepareCutover)}>Prepare reviewed cutover handoff</button></>}</div>
      </section>}
      <section className="card storage-settings-section"><h2 className="card-title">Saved system work</h2>
        <p className="muted">Pause, retry and cancellation act at safe boundaries. Cleanup removes only this job's eligible artifacts; it does not delete source files or published recovery data.
          {!capability.policy.recoveryCleanup && " Recovery targets and their verification ledger are retained; cleanup is available only for backup and upload jobs."}</p>
        {!jobsLoaded && readPhase === "error" && <p className="muted">Saved system work has not been read. Refresh recovery status to check it.</p>}
        {jobsLoaded && readPhase !== "ready" && jobs.length > 0 && <p className="muted">{readPhase === "error"
          ? "Showing previously read system work. Its current status could not be refreshed."
          : "Showing previously read system work while status is refreshed."}</p>}
        {!jobs.length && readPhase === "ready" && <p className="muted">No system backup or recovery jobs are recorded.</p>}
        {jobs.map(job => <Job key={job.id} value={job} busy={blocked} recoveryCleanup={capability.policy.recoveryCleanup} currentSignal={lifetime.current?.signal ?? null}
          onControl={(action, onStarting) => void act(async signal => {
          onStarting(signal);
          const value = await systemRecoveryClient.control(job.id, action, signal); if (!signal.aborted && !deniedRef.current) { refreshSequence.current++; updateJob(value); }
        })} onReport={() => void act(signal => loadReport(job.id, signal))} onSelectUpload={() => void act(async signal => {
          const [input, value] = await Promise.all([systemRecoveryClient.uploadIntent(job.id, signal), systemRecoveryClient.status(job.id, signal)]);
          if (signal.aborted || deniedRef.current) return;
          if (value.kind !== "upload" || value.requestId !== input.requestId) throw new Error("Invalid saved upload.");
          saveUpload({ input, jobId: job.id }); setFile(null); updateJob(value); setPreview(null); reportJobRef.current = job.id; setReportJobId(job.id);
          if (value.state === "preview") await loadReport(job.id, signal);
          else setMessage("Saved upload selected. Reselect the original archive to verify and continue it.");
        })} onCutover={() => void act(async signal => {
          setCutoverAcknowledged(false); setCutoverJob(job); await loadReport(job.id, signal);
        })} />)}
      </section>
    </>}
  </div>;
}
