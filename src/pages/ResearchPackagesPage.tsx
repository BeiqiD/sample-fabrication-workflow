import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  checkedResearchExportInput, checkedResearchExportPlanInput, checkedResearchImportInput, checkedResearchUploadInput,
  RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, type ResearchExecutorStatus, type ResearchExportInput, type ResearchExportKind,
  type ResearchImportInput, type ResearchJobControl, type ResearchJobStatus, type ResearchPackagePreview,
  type ResearchRequestReceipt, type ResearchUploadInput,
} from "../../shared/contracts/research-package-api";
import { hashResearchFile } from "../../shared/domain/research-sha256";
import { sourceFromBlob, validateStoreArchive } from "../../shared/domain/research-archive";
import { researchPackagesClient, ResearchPackageRequestError, researchPackageErrorMessage } from "../lib/research-package-client";
import { ReadStatus } from "../components/ReadStatus";
import "./storage-settings.css";
import "./research-packages.css";

const intentKey = "research-package-operation", uploadKey = "research-package-upload", receiptsKey = "research-package-receipts";
type Intent = { action: "export"; input: ResearchExportInput } | { action: "upload"; input: ResearchUploadInput } | { action: "import"; input: ResearchImportInput };
type UploadCheckpoint = { input: ResearchUploadInput; jobId: string };
type ReceiptCheckpoint = { requestId: string; jobId: string; reused: boolean };
class SessionIntentError extends Error {
  constructor() { super("Browser session storage is unavailable. Enable it to save and recover operation identifiers."); }
}
function writeSession(key: string, value: unknown | null) {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); }
  catch { throw new SessionIntentError(); }
}
function savedIntent(): Intent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(intentKey) || "null");
    if (!value || Object.keys(value).length !== 2) return null;
    if (value.action === "export") return { action: "export", input: checkedResearchExportInput(value.input) };
    if (value.action === "upload") return { action: "upload", input: checkedResearchUploadInput(value.input) };
    if (value.action === "import") return { action: "import", input: checkedResearchImportInput(value.input) };
  } catch { /* A malformed local intent does not authorize an operation. */ }
  return null;
}
function savedUpload(): UploadCheckpoint | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(uploadKey) || "null");
    if (!value || Object.keys(value).length !== 2 || typeof value.jobId !== "string") return null;
    researchPackagesClient.downloadUrl(value.jobId);
    return { input: checkedResearchUploadInput(value.input), jobId: value.jobId };
  } catch { return null; }
}
function savedReceipts(): ReceiptCheckpoint[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(receiptsKey) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is ReceiptCheckpoint => {
      if (!item || typeof item !== "object" || Object.keys(item).length !== 3 || typeof item.requestId !== "string"
        || typeof item.jobId !== "string" || typeof item.reused !== "boolean") return false;
      try { researchPackagesClient.downloadUrl(item.requestId); researchPackagesClient.downloadUrl(item.jobId); return true; } catch { return false; }
    }).slice(0, 20);
  } catch { return []; }
}
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const reasonLabels: Record<string, string> = {
  executor_disabled: "The independent executor is paused", executor_reconfigured: "Recovered work requires explicit resume",
  runtime_disabled: "The independent executor is paused", executor_stale: "No recent executor heartbeat",
  unsupported_runtime: "This runtime does not support package jobs", actor_not_authorized: "The initiating actor no longer has application access",
  operator_paused: "Paused by the user", operator_cancelled: "Cancelled by the user",
  source_unavailable: "A source file is unavailable", source_missing: "A required source is missing",
  source_changed: "The source changed before acceptance", target_unavailable: "A required storage destination is unavailable",
  unsupported_size: "The package exceeds supported limits", incomplete_package: "Required package content is unavailable",
  unresolved_reference: "A required reference cannot be reconstructed", mandatory_payload_missing: "A mandatory package member is missing",
  hash_mismatch: "File contents do not match their declared hash", size_mismatch: "File size does not match its declaration",
  verification_failed: "The file did not pass verification", write_settlement_required: "An earlier write awaits confirmation",
  execution_budget_exhausted: "The bounded execution step reached its deadline", restored_archive: "Recovered work requires explicit resume",
  upload_required: "Reselect the original ZIP to finish its upload", retry_limit_exhausted: "The attempt limit was reached",
};
const reasonText = (value: string) => reasonLabels[value] || value.replaceAll("_", " ");
const jobNames = { data_package: "Data package export", report: "Offline report export", upload: "Package validation", import: "Research copy import" };

function Preview({ value, accepted = false }: { value: ResearchPackagePreview; accepted?: boolean }) {
  const omitted = value.dependencies.filter(entry => entry.outcome !== "included");
  const included = value.dependencies.filter(entry => entry.outcome === "included");
  return <div className="research-package-preview">
    <p role="status"><strong>{value.complete ? "Complete scope" : "Incomplete scope"}</strong>: {value.counts.records} records,
      {" "}{value.counts.files} files, {size(value.counts.bytes)} of file content.</p>
    <p className="muted">{value.archiveBytes === null ? "The final ZIP size has not been measured." : `Measured ZIP size: ${size(value.archiveBytes)}.`}
      {" "}Metadata: {size(value.metadataBytes)}. The complete ZIP must fit within 100 MiB, including all entries and ZIP headers.</p>
    {value.warnings.length > 0 && <ul className="warning-card">{value.warnings.map((warning, index) => <li key={`${warning}:${index}`}>{reasonText(warning)}</li>)}</ul>}
    {included.length > 0 && <><h3>Included research context</h3><ul>{included.map((entry, index) => <li key={`${entry.targetType}:${entry.id}:${index}`}>
      {entry.targetType} {entry.label ? <strong>{entry.label}</strong> : <code>{entry.id}</code>}
      {entry.label && <> · <code>{entry.id}</code></>}{entry.reason && ` — ${reasonText(entry.reason)}`}</li>)}</ul></>}
    {omitted.length > 0 && <><h3>Excluded or unresolved dependencies</h3><ul>{omitted.map((entry, index) => <li key={`${entry.targetType}:${entry.id}:${index}`}>
      {entry.targetType} {entry.label && <><strong>{entry.label}</strong> · </>}<code>{entry.id}</code>: {entry.outcome.replaceAll("_", " ")}{entry.reason && ` — ${reasonText(entry.reason)}`}</li>)}</ul></>}
    {value.targets.length > 0 && <><h3>{accepted ? "Accepted destination roles" : "Destination roles"}</h3><div className="research-package-table"><table><thead><tr><th>Purpose</th><th>Role</th><th>Profile</th><th>Availability</th></tr></thead>
      <tbody>{value.targets.map(target => <tr key={target.purpose}><td>{target.purpose.replaceAll("_", " ")}</td><td>{target.role}</td>
        <td><code>{target.profileId}</code> · revision {target.configurationRevision}</td><td>{target.available ? "Available locally" : "Unavailable"}</td></tr>)}</tbody></table></div>
      <p className="muted">Accepted imports keep these purpose destinations through retries. Availability does not guarantee provider connectivity.</p></>}
    {value.rolePolicyRevision !== null && <p className="muted">{accepted ? `Accepted destination policy revision: ${value.rolePolicyRevision}.`
      : `Destination policy revision: ${value.rolePolicyRevision}. Import checks this revision again before acceptance.`}</p>}
    {value.source && <p className="muted">Declared source installation: <code>{value.source.installationId}</code>. Package: <code>{value.source.packageId}</code>.
      {" "}Source identity is preserved as provenance; it does not authenticate the package or create destination accounts.</p>}
    {value.naming && <><h3>{accepted ? "Accepted copy naming" : "Proposed copy naming"}</h3><p>{accepted
      ? "These names were saved when this import was accepted. Changes to current defaults do not retarget the saved copy."
      : "New business identities are created. Existing research is not overwritten. Names shown here are proposals; acceptance records the final names."}</p>
      {value.naming.conflicts.length > 0 ? <ul>{value.naming.conflicts.map(entry => <li key={`${entry.kind}:${entry.sourceId}`}>{entry.sourceName} → <strong>{entry.destinationName}</strong></li>)}</ul>
        : <p className="muted">No naming conflicts were found in this preview.</p>}</>}
  </div>;
}

function Job({ job, busy, reused, onControl, onSelectUpload, onViewScope }: { job: ResearchJobStatus; busy: boolean; reused: boolean;
  onControl: (id: string, action: ResearchJobControl) => void; onSelectUpload: (id: string) => void; onViewScope: (id: string) => void }) {
  const active = ["awaiting_upload", "queued", "running", "paused", "preview"].includes(job.state);
  return <article className="research-package-job">
    <div className="storage-profile-heading"><h3>{jobNames[job.kind]}</h3><span>{job.state.replaceAll("_", " ")}</span></div>
    <p><code>{job.id}</code></p><p>{job.phase.replaceAll("_", " ")} · {job.progress.completedFiles} / {job.progress.totalFiles} files verified · {size(job.progress.bytesDone)} / {size(job.progress.bytesTotal)}.</p>
    {job.reason && <p role="status">{reasonText(job.reason)}.</p>}
    {job.state === "cancel_requested" && <p className="muted">Cancellation is awaiting a safe boundary. Written candidates remain protected until reconciliation; committed results are retained.</p>}
    <div className="storage-candidate-actions">
      {job.kind === "import" && <button className="button" disabled={busy} onClick={() => onViewScope(job.id)}>View accepted scope</button>}
      {job.kind === "upload" && job.state !== "cancelled" && job.state !== "cancel_requested" && <button className="button" disabled={busy}
        onClick={() => onSelectUpload(job.id)}>{job.state === "awaiting_upload" ? "Continue this upload" : "Review uploaded package"}</button>}
      {["queued", "running"].includes(job.state) && <button className="button" disabled={busy} onClick={() => onControl(job.id, "pause")}>Pause</button>}
      {job.state === "paused" && <><button className="button" disabled={busy} onClick={() => onControl(job.id, "resume")}>Resume</button>
        {job.reason && job.reason !== "operator_paused" && <button className="button" disabled={busy} onClick={() => onControl(job.id, "retry")}>Retry failed work</button>}</>}
      {active && <button className="button" disabled={busy} onClick={() => onControl(job.id, "cancel")}>Cancel</button>}
      {["completed", "cancelled"].includes(job.state) && <button className="button" disabled={busy} onClick={() => onControl(job.id, "cleanup")}>Clean temporary job data</button>}
      {job.output?.available && job.state === "completed" && <a className="button primary" href={researchPackagesClient.downloadUrl(job.id)}>Download {job.kind === "report" ? "offline report" : "data package"}</a>}
    </div>
    {job.output && <p className="muted">Output: {size(job.output.byteSize)}. {job.output.available ? "Expires" : "No longer available; expiry"} <time dateTime={job.output.expiresAt}>{job.output.expiresAt}</time>.</p>}
    {reused && !job.result && <p role="status">An earlier accepted copy was returned; this request did not create another copy.
      {job.state === "cancelled" && " This copy is cancelled. Use Import another copy to accept fresh work."}</p>}
    {job.result && <><p role="status">{reused || job.result.reused ? "The existing completed import is available." : "Research copy published."}</p>
      <ul>{job.result.roots.map(root => <li key={`${root.kind}:${root.id}`}><Link to={`/${root.kind === "sample" ? "samples" : "projects"}/${encodeURIComponent(root.id)}`}>Open imported {root.kind}</Link></li>)}</ul></>}
    <small className="muted">Updated <time dateTime={job.updatedAt}>{job.updatedAt}</time>.</small>
  </article>;
}

export function ResearchPackagesPage() {
  const [query] = useSearchParams();
  const [rootText, setRootText] = useState(() => ["sample", "project"].includes(query.get("rootType") || "") && query.get("rootId")
    ? `${query.get("rootType")}:${query.get("rootId")}` : "");
  const [kind, setKind] = useState<ResearchExportKind>(() => query.get("kind") === "report" ? "report" : "data_package");
  const [exportPreview, setExportPreview] = useState<ResearchPackagePreview | null>(null);
  const [pending, setPending] = useState<Intent | null>(savedIntent), pendingRef = useRef(pending);
  const [upload, setUpload] = useState<UploadCheckpoint | null>(savedUpload), uploadRef = useRef(upload);
  const [file, setFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<ResearchPackagePreview | null>(null);
  const [acceptedScope, setAcceptedScope] = useState<{ jobId: string; preview: ResearchPackagePreview } | null>(null);
  const [receipts, setReceipts] = useState(savedReceipts);
  const [suffix, setSuffix] = useState(" (imported)"), suffixRef = useRef(suffix); suffixRef.current = suffix;
  const [jobs, setJobs] = useState<ResearchJobStatus[]>([]), [executor, setExecutor] = useState<ResearchExecutorStatus | null>(null);
  const [readPhase, setReadPhase] = useState<"loading" | "ready" | "error">("loading"), [readError, setReadError] = useState<string | null>(null);
  const [jobsLoaded, setJobsLoaded] = useState(false), [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [denied, setDenied] = useState(false), deniedRef = useRef(false), [message, setMessageText] = useState("");
  const [messageError, setMessageError] = useState(false);
  const lifetime = useRef<AbortController | null>(null), refreshSequence = useRef(0);
  const currentUpload = upload ? jobs.find(job => job.id === upload.jobId) : null;

  function setMessage(value: string) { setMessageText(value); setMessageError(false); }

  function reportFailure(error: unknown) {
    if (error instanceof ResearchPackageRequestError && [401, 403].includes(error.status || 0)) {
      deniedRef.current = true; setDenied(true); setJobs([]); setExportPreview(null); setImportPreview(null); setAcceptedScope(null); setFile(null);
    }
    setMessageText(error instanceof SessionIntentError ? error.message : researchPackageErrorMessage(error)); setMessageError(true);
  }
  function remember(value: Intent | null) {
    writeSession(intentKey, value);
    pendingRef.current = value; setPending(value);
  }
  function saveUpload(value: UploadCheckpoint | null) {
    writeSession(uploadKey, value);
    uploadRef.current = value; setUpload(value);
  }
  function updateJob(job: ResearchJobStatus) { setJobs(current => [job, ...current.filter(item => item.id !== job.id)].slice(0, 100)); }
  function ownsIntent(intent: Intent, signal: AbortSignal) {
    return !signal.aborted && !deniedRef.current && pendingRef.current === intent;
  }
  function acceptReceipt(intent: Intent, receipt: ResearchRequestReceipt, signal: AbortSignal) {
    if (!ownsIntent(intent, signal)) return null;
    if (receipt.requestId !== intent.input.requestId) throw new Error("Invalid operation receipt.");
    const expected = intent.action === "export" ? intent.input.kind : intent.action;
    if (receipt.job.kind !== expected) throw new Error("Invalid operation receipt.");
    updateJob(receipt.job);
    if (intent.action === "upload") saveUpload({ input: intent.input, jobId: receipt.job.id });
    const checkpoint = [{ requestId: receipt.requestId, jobId: receipt.job.id, reused: receipt.reused },
      ...savedReceipts().filter(item => item.requestId !== receipt.requestId)].slice(0, 20);
    writeSession(receiptsKey, checkpoint); setReceipts(checkpoint);
    remember(null);
    if (intent.action === "export") setExportPreview(null);
    setMessage(receipt.reused ? receipt.job.state === "cancelled"
      ? "The earlier accepted copy is cancelled. This request did not create another research copy; use Import another copy for fresh work."
      : "An existing saved import was returned. This request did not create another research copy."
      : "Operation saved. You may leave this page; the independent executor owns its progress.");
    return receipt.job;
  }
  async function submit(intent: Intent, signal: AbortSignal) {
    if (!ownsIntent(intent, signal)) return null;
    let receipt: ResearchRequestReceipt;
    try {
      receipt = intent.action === "export" ? await researchPackagesClient.export(intent.input, signal)
        : intent.action === "upload" ? await researchPackagesClient.acceptUpload(intent.input, signal)
          : await researchPackagesClient.import(intent.input, signal);
    } catch (error) {
      if (!ownsIntent(intent, signal)) return null;
      if (error instanceof ResearchPackageRequestError && error.status === 409) {
        try { receipt = await researchPackagesClient.readRequest(intent.input.requestId, signal); }
        catch (lookupError) {
          if (!ownsIntent(intent, signal)) return null;
          if (lookupError instanceof ResearchPackageRequestError && lookupError.status === 404) {
            remember(null); setExportPreview(null); setImportPreview(null);
            setMessage(error.reason ? researchPackageErrorMessage(error)
              : "The preview or destination policy changed. Refresh the preview before accepting new work."); return null;
          }
          throw lookupError;
        }
      } else throw error;
    }
    return acceptReceipt(intent, receipt, signal);
  }
  async function reconcile(signal: AbortSignal, retryMissing = false) {
    const intent = pendingRef.current; if (!intent) return;
    try {
      const receipt = await researchPackagesClient.readRequest(intent.input.requestId, signal);
      acceptReceipt(intent, receipt, signal);
    } catch (error) {
      if (!ownsIntent(intent, signal)) return;
      if (retryMissing && error instanceof ResearchPackageRequestError && error.status === 404) { await submit(intent, signal); return; }
      if (error instanceof ResearchPackageRequestError && error.status === 404) setMessage("No receipt is recorded yet. An explicit retry will use the original request and identifier.");
      else reportFailure(error);
    }
  }
  async function refresh(signal: AbortSignal, announce = false) {
    if (signal.aborted || deniedRef.current) return;
    const sequence = ++refreshSequence.current;
    if (announce) setReadPhase("loading");
    try {
      const [list, status] = await Promise.all([researchPackagesClient.list(signal), researchPackagesClient.executor(signal)]);
      if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current) return;
      const savedIds = [...new Set(savedReceipts().map(receipt => receipt.jobId))].filter(id => !list.some(job => job.id === id));
      const recovered = await Promise.all(savedIds.map(async id => {
        try { return await researchPackagesClient.status(id, signal); }
        catch (error) {
          if (error instanceof ResearchPackageRequestError && [404, 410].includes(error.status || 0)) return null;
          throw error;
        }
      }));
      if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current) return;
      const visible = [...recovered.filter((job): job is ResearchJobStatus => job !== null), ...list].slice(0, 100);
      setJobs(visible); setExecutor(status); setJobsLoaded(true); setReadError(null); setReadPhase("ready");
      const checkpoint = uploadRef.current;
      if (checkpoint) {
        const uploaded = visible.find(job => job.id === checkpoint.jobId) || await researchPackagesClient.status(checkpoint.jobId, signal);
        if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current || uploadRef.current?.jobId !== checkpoint.jobId) return;
        if (!visible.some(job => job.id === uploaded.id)) updateJob(uploaded);
        if (uploaded?.state === "preview") {
          const previewSuffix = suffixRef.current;
          const preview = await researchPackagesClient.preview(checkpoint.jobId, previewSuffix, signal);
          if (!signal.aborted && !deniedRef.current && sequence === refreshSequence.current && suffixRef.current === previewSuffix
            && uploadRef.current?.jobId === checkpoint.jobId) setImportPreview(preview);
        } else if (uploaded) setImportPreview(null);
      }
    } catch (error) {
      if (signal.aborted || deniedRef.current || sequence !== refreshSequence.current) return;
      if (error instanceof ResearchPackageRequestError && [401, 403].includes(error.status || 0)) reportFailure(error);
      else {
        const helpfulReadFailure = error instanceof ResearchPackageRequestError
          && (error.reason !== null || [400, 410, 413, 422, 503].includes(error.status || 0));
        setReadError(helpfulReadFailure ? researchPackageErrorMessage(error)
          : "Package status could not be read. Retry the status check.");
        setReadPhase("error");
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (controller.signal.aborted || deniedRef.current) return;
      await refresh(controller.signal);
      if (!controller.signal.aborted && !deniedRef.current) timer = setTimeout(() => void poll(), 5000);
    };
    void (async () => {
      if (pendingRef.current) { try { await reconcile(controller.signal); } catch (error) { if (!controller.signal.aborted) reportFailure(error); } }
      if (!controller.signal.aborted && !deniedRef.current) await poll();
    })();
    return () => { controller.abort(); refreshSequence.current++; if (timer) clearTimeout(timer); };
  }, []);
  async function act(operation: (signal: AbortSignal) => Promise<void>, preserveMessage = false) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || deniedRef.current || busyRef.current) return;
    busyRef.current = true; setBusy(true); if (!preserveMessage) setMessage("");
    try { await operation(controller.signal); }
    catch (error) { if (!controller.signal.aborted) reportFailure(error); }
    finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  function exportInput() {
    const roots = rootText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const separator = line.indexOf(":"); return { kind: line.slice(0, separator), id: line.slice(separator + 1) };
    });
    return checkedResearchExportPlanInput({ kind, roots });
  }
  async function startExport(signal: AbortSignal) {
    if (!exportPreview || pendingRef.current) return;
    const capability = kind === "report" ? exportPreview.capabilities.report : exportPreview.capabilities.dataPackage;
    if (!capability.available || kind === "data_package" && !exportPreview.complete) return;
    const intent: Intent = { action: "export", input: checkedResearchExportInput({ requestId: crypto.randomUUID(), ...exportInput() }) };
    remember(intent); await submit(intent, signal);
  }
  async function prepareUpload(signal: AbortSignal) {
    if (!file || pendingRef.current) return;
    if (file.size < 1 || file.size > RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES) { setMessage("Select a native ZIP between 1 byte and 100 MiB."); return; }
    setMessage("Checking the selected file with a bounded streaming hash…");
    const measured = await hashResearchFile(file, { maxBytes: RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, signal });
    if (signal.aborted) return;
    setMessage("Validating bounded ZIP members and checksums before accepting its upload…");
    await validateStoreArchive(sourceFromBlob(file), { expectedSha256: measured.sha256, signal });
    if (signal.aborted) return;
    const checkpoint = uploadRef.current;
    let jobId: string;
    if (checkpoint && currentUpload?.state === "awaiting_upload") {
      if (checkpoint.input.byteSize !== measured.byteSize || checkpoint.input.sha256 !== measured.sha256) {
        setMessage("This file differs from the accepted upload. Reselect the original ZIP or cancel its saved validation job."); return;
      }
      jobId = checkpoint.jobId;
    } else {
      if (checkpoint) { setMessage("Finish or close the current package preview before selecting another upload."); return; }
      const intent: Intent = { action: "upload", input: checkedResearchUploadInput({ requestId: crypto.randomUUID(), ...measured }) };
      remember(intent); const job = await submit(intent, signal); if (!job || signal.aborted) return; jobId = job.id;
    }
    setMessage("Uploading the selected ZIP. Validation continues in the independent executor.");
    const job = await researchPackagesClient.upload(jobId, file, signal);
    if (!signal.aborted) { updateJob(job); setFile(null); setMessage("Package uploaded. Validation is saved independently of this page."); }
  }
  async function startImport(signal: AbortSignal, anotherCopy: boolean) {
    if (!uploadRef.current || !importPreview || importPreview.rolePolicyRevision === null || importPreview.kind !== "data_package" || !importPreview.complete
      || !importPreview.capabilities.dataPackage.available || pendingRef.current) return;
    const intent: Intent = { action: "import", input: checkedResearchImportInput({ requestId: crypto.randomUUID(), uploadJobId: uploadRef.current.jobId,
      anotherCopy, expectedRolePolicyRevision: importPreview.rolePolicyRevision, naming: { suffix } }) };
    remember(intent); await submit(intent, signal);
  }
  const exportCapability = exportPreview && (kind === "report" ? exportPreview.capabilities.report : exportPreview.capabilities.dataPackage);
  const mayImport = importPreview?.kind === "data_package" && importPreview.rolePolicyRevision !== null && importPreview.complete && importPreview.capabilities.dataPackage.available;
  const blocked = busy || !!pending || denied;
  return <div className="page storage-settings-page research-packages-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>Data</h1>
      <p className="lead">Export research packages and offline reports, or import a native package as a new research copy.</p></div>
      <button className="button" disabled={busy || denied} onClick={() => void act(signal => refresh(signal, true), true)}>Refresh status</button></div>
    <nav className="research-package-navigation" aria-label="Data settings"><Link to="/settings/storage">Storage settings</Link><Link to="/export">Full content backup</Link>
      <Link to="/settings/data/system">System backup and recovery</Link>
      <Link to="/imports/fabublox">FabuBlox workbook import</Link></nav>
    {message && (denied || !messageError) && <p role={denied ? "alert" : "status"}>{message}</p>}
    <ReadStatus loading={readPhase === "loading" && !denied} loadingMessage="Reading saved package work…"
      error={!denied ? readError : null} errorTitle="Package status unavailable"
      onRetry={() => void act(signal => refresh(signal, true), true)} retryLabel="Retry reading package status" />
    <ReadStatus loading={false} loadingMessage="" error={!denied && messageError ? message : null} errorTitle="Data operation unavailable"
      onRetry={() => void act(signal => refresh(signal, true), true)} retryLabel="Read current package status" />
    {denied ? <p>Sign in with an account allowed to use the application before continuing. Saved operation identifiers are retained for reconciliation.</p> : <>
      <section className="card storage-settings-section"><h2 className="card-title">Independent executor</h2>
        {executor && <><p>{!executor.supported ? "Package jobs are unavailable on this runtime." : !executor.enabled ? "Execution is paused." : executor.stale ? "Execution is enabled, but no recent heartbeat was recorded." : "Execution is enabled."}</p>
          {executor.reason && <p className="muted">{reasonText(executor.reason)}.</p>}
          {(!executor.enabled || executor.stale) && <p className="muted">Accepted work remains queued or paused until the independently invoked runner is available. Refreshing or polling this page does not execute it.</p>}
          {executor.canManage && <p><Link to="/settings/storage/migrations">Administrator executor controls</Link></p>}
          {executor.lastHeartbeatAt && <p className="muted">Last heartbeat: <time dateTime={executor.lastHeartbeatAt}>{executor.lastHeartbeatAt}</time>.</p>}</>}
        <p className="muted">Supported native ZIP: STORE entries, up to 100 MiB total, 100 files, 96 MiB of file content, 1,200 records and 4 MiB of metadata. Individual ceilings do not guarantee that their combined ZIP fits.</p>
      </section>
      {pending && <section className="card storage-settings-section"><h2 className="card-title">Unconfirmed operation</h2>
        <p>The {pending.action} request <code>{pending.input.requestId}</code> is retained. Check its receipt before starting another operation.</p>
        <button className="button" disabled={busy} onClick={() => void act(signal => reconcile(signal, true))}>Check or retry original request</button></section>}
      <section className="card storage-settings-section"><h2 className="card-title">Export selected research</h2>
        <p className="muted">Choose Data package or Offline report from a <Link to="/samples">Sample</Link> or <Link to="/projects">Project</Link>, or enter up to 20 roots below.</p>
        <form onSubmit={event => { event.preventDefault(); void act(async signal => { const preview = await researchPackagesClient.plan(exportInput(), signal); if (!signal.aborted) setExportPreview(preview); }); }}>
          <fieldset disabled={blocked || executor?.supported === false}><div className="storage-candidate-fields">
            <label>Export format<select value={kind} onChange={event => { setKind(event.target.value as ResearchExportKind); setExportPreview(null); }}>
              <option value="data_package">Native data package</option><option value="report">Offline HTML and Markdown report</option></select></label>
            <label>Sample and Project roots<textarea rows={3} value={rootText} placeholder="sample:record-id or project:record-id, one per line"
              onChange={event => { setRootText(event.target.value); setExportPreview(null); }} required /></label>
          </div><button className="button" type="submit">Preview export</button></fieldset>
        </form>
        {exportPreview && <><Preview value={exportPreview} />
          {!exportCapability?.available && <ul>{exportCapability?.reasons.map(code => <li key={code}>{reasonText(code)}</li>)}</ul>}
          {kind === "data_package" && !exportPreview.complete && <p className="warning-card">This scope cannot produce a complete native package. Export an available report or resolve the missing dependencies.</p>}
          <button className="button primary" disabled={blocked || !exportCapability?.available || kind === "data_package" && !exportPreview.complete}
            onClick={() => void act(startExport)}>Start {kind === "report" ? "report" : "data package"} export</button></>}
      </section>
      <section className="card storage-settings-section"><h2 className="card-title">Import a native data package</h2>
        <p className="muted">Native research packages create fresh business identities and retain source provenance. Existing readable ZIPs, FabuBlox workbooks and whole-installation backups are separate formats.</p>
        <label>Native package ZIP<input type="file" accept=".zip,application/zip" disabled={blocked || executor?.supported === false || !!upload && currentUpload?.state !== "awaiting_upload"}
          onChange={event => setFile(event.target.files?.[0] || null)} /></label>
        {upload && currentUpload?.state === "awaiting_upload" && <p className="muted">The accepted upload is waiting for bytes. After reload or interruption, reselect the original {size(upload.input.byteSize)} ZIP; its streaming hash must match.</p>}
        <div className="storage-candidate-actions"><button className="button" disabled={blocked || !file || executor?.supported === false}
          onClick={() => void act(prepareUpload)}>{upload ? "Resume original upload" : "Upload and validate package"}</button>
          {upload && <button className="button" disabled={busy} onClick={() => void act(signal => refresh(signal, true), true)}>Check uploaded package</button>}</div>
        {upload && <p className="muted">Validation job: <code>{upload.jobId}</code>. Upload interruption does not authorize a new copy or discard accepted work.</p>}
        {upload && currentUpload?.state === "preview" && <><label>Imported name suffix<input maxLength={32} value={suffix} disabled={blocked}
          onChange={event => { setSuffix(event.target.value); setImportPreview(null); }} /></label>
          <button className="button" disabled={blocked} onClick={() => void act(async signal => {
            const value = await researchPackagesClient.preview(upload.jobId, suffix, signal); if (!signal.aborted) setImportPreview(value);
          })}>Refresh import preview</button></>}
        {importPreview && <>
          <Preview value={importPreview} />
          {!mayImport && <><p className="warning-card">Import is blocked. Missing mandatory files, unresolved references and unsupported partial states are not silently published.</p>
            {importPreview.rolePolicyRevision === null && <p className="muted">No destination policy is available. Configure upload destinations in Storage settings and refresh this preview.</p>}
            <ul>{importPreview.capabilities.dataPackage.reasons.map(code => <li key={code}>{reasonText(code)}</li>)}</ul></>}
          {importPreview.existingImportJobId && <p className="muted">This validated package has an earlier accepted copy: <code>{importPreview.existingImportJobId}</code>.
            {" "}The ordinary action returns its saved state, including cancellation. Use Import another copy for fresh work.</p>}
          <div className="storage-candidate-actions"><button className="button primary" disabled={blocked || !mayImport} onClick={() => void act(signal => startImport(signal, false))}>
            {importPreview.existingImportJobId ? "Open existing import" : "Import research copy"}</button>
            {importPreview.existingImportJobId && <button className="button" disabled={blocked || !mayImport} onClick={() => void act(signal => startImport(signal, true))}>Import another copy</button>}</div>
        </>}
        {upload && <p><button className="text-button" disabled={blocked}
          onClick={() => { try { saveUpload(null); setImportPreview(null); setFile(null); } catch (error) { reportFailure(error); } }}>Select another package</button>
          <small className="muted"> Changing this selection does not cancel saved jobs.</small></p>}
      </section>
      <section className="card storage-settings-section"><h2 className="card-title">Saved package work</h2>
        <p className="muted">Work persists when the browser closes. Pause and cancel take effect at a safe boundary; cancellation retains committed copies. Cleanup is separate and does not remove published research.</p>
        {!jobsLoaded && readPhase === "error" && <p className="muted">Saved package work has not been read. Refresh status to check it.</p>}
        {jobsLoaded && readPhase !== "ready" && jobs.length > 0 && <p className="muted">{readPhase === "error"
          ? "Showing previously read package work. Its current status could not be refreshed."
          : "Showing previously read package work while status is refreshed."}</p>}
        {!jobs.length && readPhase === "ready" && <p className="muted">No package jobs are recorded for your account.</p>}
        {acceptedScope && <div className="research-package-accepted-scope"><h3>Accepted import scope</h3><p><code>{acceptedScope.jobId}</code></p>
          <Preview value={acceptedScope.preview} accepted /><button className="text-button" onClick={() => setAcceptedScope(null)}>Close accepted scope</button></div>}
        {jobs.map(job => <Job key={job.id} job={job} busy={blocked} reused={receipts.some(receipt => receipt.jobId === job.id && receipt.reused)}
          onViewScope={id => void act(async signal => {
            const preview = await researchPackagesClient.preview(id, undefined, signal);
            if (!signal.aborted) setAcceptedScope({ jobId: id, preview });
          })} onSelectUpload={id => void act(async signal => {
          const [input, value] = await Promise.all([researchPackagesClient.uploadIntent(id, signal), researchPackagesClient.status(id, signal)]);
          if (signal.aborted) return;
          if (value.kind !== "upload" || value.requestId !== input.requestId) throw new Error("Invalid saved upload.");
          saveUpload({ input, jobId: id }); updateJob(value); setFile(null); setImportPreview(null);
          if (value.state === "preview") {
            const preview = await researchPackagesClient.preview(id, suffix, signal); if (!signal.aborted) setImportPreview(preview);
          }
          setMessage(value.state === "awaiting_upload" ? "Saved upload selected. Reselect the original ZIP to verify and continue it." : "Saved package selected. Its validated preview is available when validation finishes.");
        })} onControl={(id, action) => void act(async signal => {
          const value = await researchPackagesClient.control(id, action, signal); if (!signal.aborted) { updateJob(value); setMessage("Saved job state updated. Check status to follow its independent progress."); }
        })} />)}
      </section>
    </>}
  </div>;
}
