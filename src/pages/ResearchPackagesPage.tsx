import { createReadCoordinator, isReadCancellation, ReadTimeoutError, startVisibleReadPolling, type ReadRound } from "../lib/read-coordinator";
import { checkpointStorage, type CheckpointStorage } from "../lib/browser-checkpoints";
import { captureApplicationOwner } from "../lib/authentication-client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  checkedResearchExportInput, checkedResearchExportPlanInput, checkedResearchImportInput, checkedResearchRequestReceipt, checkedResearchUploadInput,
  RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, type ResearchExecutorStatus, type ResearchExportInput, type ResearchExportKind,
  type ResearchImportInput, type ResearchJobControl, type ResearchJobStatus, type ResearchPackagePreview,
  type ResearchRequestReceipt, type ResearchUploadInput,
} from "../../shared/contracts/research-package-api";
import { hashResearchFile } from "../../shared/domain/research-sha256";
import { sourceFromBlob, validateStoreArchive } from "../../shared/domain/research-archive";
import { researchPackagesClient, ResearchPackageRequestError, ResearchPackageRequestMissingError, researchPackageErrorMessage } from "../lib/research-package-client";
import { ReadStatus } from "../components/ReadStatus";
import { SettingsTaskNavigation } from "../components/SettingsTaskNavigation";
import "./storage-settings.css";
import "./research-packages.css";

const intentKey = "research-package-operation", uploadKey = "research-package-upload", receiptsKey = "research-package-receipts";
const rejectionKey = "research-package-operation-rejection", historyKey = "research-package-earlier-requests";
type Intent = { action: "export"; input: ResearchExportInput } | { action: "upload"; input: ResearchUploadInput } | { action: "import"; input: ResearchImportInput };
type EarlierRequest = { intent: Intent; receipt: ResearchRequestReceipt | null };
const sameIntent = (left: Intent, right: Intent) => JSON.stringify(left) === JSON.stringify(right);
type UploadCheckpoint = { input: ResearchUploadInput; jobId: string };
type ReceiptCheckpoint = { requestId: string; jobId: string; reused: boolean };
class SessionIntentError extends Error {
  constructor() { super("Browser session storage is unavailable. Enable it to save and recover operation identifiers."); }
}
function writeSession(storage: CheckpointStorage, key: string, value: unknown | null) {
  try { if (value === null) storage.removeItem(key); else storage.setItem(key, JSON.stringify(value)); }
  catch { throw new SessionIntentError(); }
}
function checkedIntent(value: unknown): Intent {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) throw new Error("Invalid package intent.");
  const row = value as { action?: unknown; input?: unknown };
  if (row.action === "export") return { action: "export", input: checkedResearchExportInput(row.input) };
  if (row.action === "upload") return { action: "upload", input: checkedResearchUploadInput(row.input) };
  if (row.action === "import") return { action: "import", input: checkedResearchImportInput(row.input) };
  throw new Error("Invalid package intent.");
}
function savedIntent(storage: CheckpointStorage): Intent | null {
  try {
    const value = JSON.parse(storage.getItem(intentKey) || "null");
    return value ? checkedIntent(value) : null;
  } catch { /* A malformed local intent does not authorize an operation. */ }
  return null;
}
function savedRejection(storage: CheckpointStorage): Intent | null {
  try {
    const row = JSON.parse(storage.getItem(rejectionKey) || "null"), pending = savedIntent(storage);
    if (!row || Object.keys(row).length !== 2 || row.schema !== "research-package-rejection/1") return null;
    const intent = checkedIntent(row.intent);
    return pending && sameIntent(pending, intent) ? intent : null;
  } catch { return null; }
}
function checkedReceiptKind(intent: Intent, receipt: ResearchRequestReceipt) {
  if (receipt.requestId !== intent.input.requestId || receipt.job.kind !== (intent.action === "export" ? intent.input.kind : intent.action)) throw new Error("Invalid operation receipt.");
}
function savedHistory(storage: CheckpointStorage): EarlierRequest[] | null {
  try {
    const rows: unknown = JSON.parse(storage.getItem(historyKey) || "[]");
    if (!Array.isArray(rows)) return null;
    const seen = new Set<string>();
    return rows.map(row => {
      if (!row || Object.keys(row).length !== 2) throw new Error("Invalid package history.");
      const intent = checkedIntent(row.intent), receipt = row.receipt === null ? null : checkedResearchRequestReceipt(row.receipt);
      if (seen.has(intent.input.requestId)) throw new Error("Invalid package history.");
      seen.add(intent.input.requestId); if (receipt) checkedReceiptKind(intent, receipt);
      return { intent, receipt };
    });
  } catch { return null; }
}
function savedUpload(storage: CheckpointStorage): UploadCheckpoint | null {
  try {
    const value = JSON.parse(storage.getItem(uploadKey) || "null");
    if (!value || Object.keys(value).length !== 2 || typeof value.jobId !== "string") return null;
    researchPackagesClient.downloadUrl(value.jobId);
    return { input: checkedResearchUploadInput(value.input), jobId: value.jobId };
  } catch { return null; }
}
function savedReceipts(storage: CheckpointStorage): ReceiptCheckpoint[] {
  try {
    const raw = JSON.parse(storage.getItem(receiptsKey) || "[]");
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
  actor_paused: "Paused by the user", operator_paused: "Paused by the user", operator_cancelled: "Cancelled by the user",
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

function Job({ job, busy, allowed, currentSignal, reused, onControl, onSelectUpload, onViewScope, onPauseTarget, onStatusTarget }: {
  job: ResearchJobStatus; busy: boolean; allowed: boolean; currentSignal: AbortSignal | null; reused: boolean;
  onControl: (id: string, action: ResearchJobControl, onStarting: (signal: AbortSignal) => void,
    onReceipt: (receipt: ResearchJobStatus) => void) => void;
  onSelectUpload: (id: string) => void; onViewScope: (id: string) => void;
  onPauseTarget: (job: ResearchJobStatus, button: HTMLButtonElement | null) => void;
  onStatusTarget: (job: ResearchJobStatus, element: HTMLParagraphElement | null) => void;
}) {
  const buttons = useRef(new Map<ResearchJobControl, HTMLButtonElement>());
  const status = useRef<HTMLParagraphElement>(null);
  type FocusIntent = { action: ResearchJobControl; origin: HTMLButtonElement; source: ResearchJobStatus; signal: AbortSignal;
    receipt: ResearchJobStatus | null; movedAway: boolean; stopObserving: () => void };
  const returnFocus = useRef<FocusIntent | null>(null);
  function clearFocusIntent() { returnFocus.current?.stopObserving(); returnFocus.current = null; }
  useLayoutEffect(() => () => clearFocusIntent(), []);
  useLayoutEffect(() => {
    if (busy) return;
    const intent = returnFocus.current; clearFocusIntent();
    if (!intent || !allowed || intent.signal.aborted || intent.signal !== currentSignal || intent.movedAway
      || job.id !== intent.source.id || job.requestId !== intent.source.requestId || job.kind !== intent.source.kind
      || job.acceptedAt !== intent.source.acceptedAt
      || document.activeElement !== document.body && document.activeElement !== intent.origin) return;
    if (buttons.current.get(intent.action) === intent.origin && intent.origin.isConnected && !intent.origin.disabled
      && job.state === intent.source.state && job.reason === intent.source.reason && job.updatedAt === intent.source.updatedAt) {
      intent.origin.focus(); return;
    }
    const receipt = intent.receipt;
    if (!receipt || receipt.id !== job.id || receipt.requestId !== job.requestId || receipt.kind !== job.kind
      || receipt.acceptedAt !== job.acceptedAt || receipt.state !== job.state || receipt.reason !== job.reason
      || receipt.updatedAt !== job.updatedAt) return;
    const next = intent.action === "pause" && job.state === "paused" ? buttons.current.get("resume")
      : (intent.action === "resume" || intent.action === "retry") && (job.state === "queued" || job.state === "running") ? buttons.current.get("pause")
        : intent.action === "cancel" && (job.state === "cancel_requested" || job.state === "cancelled") ? status.current : null;
    if (next?.isConnected && (!(next instanceof HTMLButtonElement) || !next.disabled)) next.focus();
  }, [busy, allowed, currentSignal, job]);
  function controlButton(action: ResearchJobControl, label: string) {
    return <button key={action} className="button" disabled={busy}
      ref={button => { if (button) buttons.current.set(action, button); else buttons.current.delete(action);
        if (action === "pause") onPauseTarget(job, button); }}
      onClick={event => {
        const origin = event.currentTarget; const admitted: { current: FocusIntent | null } = { current: null };
        onControl(job.id, action, signal => {
          clearFocusIntent();
          if (document.activeElement !== origin || buttons.current.get(action) !== origin || !origin.isConnected) return;
          const moved = (event: FocusEvent) => { if (admitted.current && event.target !== origin && event.target !== document.body) admitted.current.movedAway = true; };
          const blurred = () => { if (admitted.current) admitted.current.movedAway = true; };
          admitted.current = { action, origin, source: job, signal, receipt: null, movedAway: false,
            stopObserving: () => { document.removeEventListener("focusin", moved, true); window.removeEventListener("blur", blurred); } };
          returnFocus.current = admitted.current;
          document.addEventListener("focusin", moved, true); window.addEventListener("blur", blurred);
        }, receipt => { if (admitted.current && returnFocus.current === admitted.current) admitted.current.receipt = receipt; });
      }}>{label}</button>;
  }
  const active = ["awaiting_upload", "queued", "running", "paused", "preview"].includes(job.state);
  return <article className="research-package-job">
    <div className="storage-profile-heading"><h3>{jobNames[job.kind]}</h3><span>{job.state.replaceAll("_", " ")}</span></div>
    <p><code>{job.id}</code></p><p ref={element => { status.current = element; onStatusTarget(job, element); }} role="status" tabIndex={-1}>{job.phase.replaceAll("_", " ")} · {job.progress.completedFiles} / {job.progress.totalFiles} files verified · {size(job.progress.bytesDone)} / {size(job.progress.bytesTotal)}.</p>
    {job.reason && <p role="status">{reasonText(job.reason)}.</p>}
    {job.state === "cancel_requested" && <p className="muted">Cancellation is awaiting a safe boundary. Written candidates remain protected until reconciliation; committed results are retained.</p>}
    <div className="storage-candidate-actions">
      {job.kind === "import" && <button className="button" disabled={busy} onClick={() => onViewScope(job.id)}>View accepted scope</button>}
      {job.kind === "upload" && job.state !== "cancelled" && job.state !== "cancel_requested" && <button className="button" disabled={busy}
        onClick={() => onSelectUpload(job.id)}>{job.state === "awaiting_upload" ? "Continue this upload" : "Review uploaded package"}</button>}
      {["queued", "running"].includes(job.state) && controlButton("pause", "Pause")}
      {job.state === "paused" && <>{controlButton("resume", "Resume")}
        {job.reason && job.reason !== "actor_paused" && job.reason !== "operator_paused" && controlButton("retry", "Retry failed work")}</>}
      {active && controlButton("cancel", "Cancel")}
      {["completed", "cancelled"].includes(job.state) && controlButton("cleanup", "Clean temporary job data")}
      {job.output?.available && job.state === "completed" && <a className="button primary" href={researchPackagesClient.downloadUrl(job.id)}>Download {job.kind === "report" ? "offline report" : "data package"}</a>}
    </div>
    {job.output && <p className="muted">Output: {size(job.output.byteSize)}. {job.output.available ? "Expires" : "No longer available; expiry"} <time dateTime={job.output.expiresAt}>{job.output.expiresAt}</time>.</p>}
    {job.kind === "import" && reused && !job.result && <p role="status">An earlier accepted copy was returned; this request did not create another copy.
      {job.state === "cancelled" && " This copy is cancelled. Use Import another copy to accept fresh work."}</p>}
    {job.kind === "import" && job.result && <><p role="status">{reused || job.result.reused ? "The existing completed import is available." : "Research copy published."}</p>
      <ul>{job.result.roots.map(root => <li key={`${root.kind}:${root.id}`}><Link to={`/${root.kind === "sample" ? "samples" : "projects"}/${encodeURIComponent(root.id)}`}>Open imported {root.kind}</Link></li>)}</ul></>}
    {(job.kind === "data_package" || job.kind === "report") && job.result && <><p role="status">Export source research.</p>
      <ul>{job.result.roots.map(root => <li key={`${root.kind}:${root.id}`}><Link to={`/${root.kind === "sample" ? "samples" : "projects"}/${encodeURIComponent(root.id)}`}>Open source {root.kind}</Link></li>)}</ul></>}
    <small className="muted">Updated <time dateTime={job.updatedAt}>{job.updatedAt}</time>.</small>
  </article>;
}

export function ResearchPackagesPage() {
  const [owner] = useState(captureApplicationOwner);
  const [storage] = useState(() => checkpointStorage(owner));
  const [query] = useSearchParams();
  const [rootText, setRootText] = useState(() => ["sample", "project"].includes(query.get("rootType") || "") && query.get("rootId")
    ? `${query.get("rootType")}:${query.get("rootId")}` : "");
  const [kind, setKind] = useState<ResearchExportKind>(() => query.get("kind") === "report" ? "report" : "data_package");
  const [exportPreview, setExportPreview] = useState<ResearchPackagePreview | null>(null);
  const [pending, setPending] = useState<Intent | null>(() => savedIntent(storage)), pendingRef = useRef(pending);
  const [rejected, setRejected] = useState(() => savedRejection(storage)), rejectedRef = useRef(rejected);
  const [receiptMissing, setReceiptMissing] = useState(false);
  const [earlier, setEarlier] = useState(() => savedHistory(storage)), earlierRef = useRef(earlier);
  const [upload, setUpload] = useState<UploadCheckpoint | null>(() => savedUpload(storage)), uploadRef = useRef(upload);
  const [file, setFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<ResearchPackagePreview | null>(null);
  const [acceptedScope, setAcceptedScope] = useState<{ jobId: string; preview: ResearchPackagePreview } | null>(null);
  const [receipts, setReceipts] = useState(() => savedReceipts(storage));
  const [suffix, setSuffix] = useState(" (imported)"), suffixRef = useRef(suffix); suffixRef.current = suffix;
  const [jobs, setJobs] = useState<ResearchJobStatus[]>([]), [executor, setExecutor] = useState<ResearchExecutorStatus | null>(null);
  const [readPhase, setReadPhase] = useState<"loading" | "ready" | "error">("loading"), [readError, setReadError] = useState<string | null>(null);
  const [jobsLoaded, setJobsLoaded] = useState(false), [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [denied, setDenied] = useState(false), deniedRef = useRef(false), [message, setMessageText] = useState("");
  const [messageError, setMessageError] = useState(false);
  const lifetime = useRef<AbortController | null>(null), refreshSequence = useRef(0);
  const reads = useRef(createReadCoordinator()), polling = useRef<ReturnType<typeof startVisibleReadPolling> | null>(null);
  const pollActive = useRef(true), needsFreshRead = useRef(false);
  const exportPreviewButton = useRef<HTMLButtonElement>(null);
  const returnExportPreviewFocus = useRef<{ button: HTMLButtonElement; signal: AbortSignal } | null>(null);
  const currentUpload = upload ? jobs.find(job => job.id === upload.jobId) : null;
  const refreshButton = useRef<HTMLButtonElement>(null), startButton = useRef<HTMLButtonElement>(null), actionSequence = useRef(0);
  const checkButton = useRef<HTMLButtonElement>(null), retryButton = useRef<HTMLButtonElement>(null), reviewButton = useRef<HTMLButtonElement>(null);
  const importReviewButton = useRef<HTMLButtonElement>(null), packageFileInput = useRef<HTMLInputElement>(null);
  const pauseTargets = useRef(new Map<string, { job: ResearchJobStatus; button: HTMLButtonElement }>());
  const statusTargets = useRef(new Map<string, { job: ResearchJobStatus; element: HTMLParagraphElement }>());
  type PageFocusIntent = { action: "refresh" | "start" | "check" | "retry" | "review"; origin: HTMLButtonElement; signal: AbortSignal; sequence: number;
    refreshSequence: number; requestAction: Intent["action"] | null; receipt: ResearchJobStatus | null; movedAway: boolean; stopObserving: () => void };
  const returnPageFocus = useRef<PageFocusIntent | null>(null);
  function clearPageFocus() { returnPageFocus.current?.stopObserving(); returnPageFocus.current = null; }
  function beginPageFocus(action: PageFocusIntent["action"], origin: HTMLButtonElement, signal: AbortSignal) {
    const expected = action === "refresh" ? refreshButton.current : action === "check" ? checkButton.current : action === "retry" ? retryButton.current : action === "review" ? reviewButton.current : startButton.current;
    if (document.activeElement !== origin || origin !== expected || !origin.isConnected) return null;
    const intent: PageFocusIntent = { action, origin, signal, sequence: actionSequence.current,
      refreshSequence: refreshSequence.current + (action === "refresh" ? 1 : 0), requestAction: pendingRef.current?.action ?? null, receipt: null, movedAway: false,
      stopObserving: () => { document.removeEventListener("focusin", moved, true); window.removeEventListener("blur", blurred); } };
    const moved = (event: FocusEvent) => { if (event.target !== origin && event.target !== document.body) intent.movedAway = true; };
    const blurred = () => { intent.movedAway = true; };
    returnPageFocus.current = intent;
    document.addEventListener("focusin", moved, true); window.addEventListener("blur", blurred);
    return intent;
  }
  useLayoutEffect(() => () => clearPageFocus(), []);
  useLayoutEffect(() => {
    if (busy) return;
    const intent = returnPageFocus.current; clearPageFocus();
    if (!intent || intent.signal !== lifetime.current?.signal || !currentOperation(intent.signal) || denied
      || intent.sequence !== actionSequence.current || intent.movedAway
      || document.activeElement !== document.body && document.activeElement !== intent.origin) return;
    if (intent.action === "refresh") {
      if (intent.refreshSequence === refreshSequence.current && intent.origin === refreshButton.current
        && intent.origin.isConnected && !intent.origin.disabled) intent.origin.focus();
      return;
    }
    const receipt = intent.receipt;
    if (!receipt) {
      if (intent.action === "review" && !pendingRef.current) {
        const target = intent.requestAction === "export" ? exportPreviewButton.current : importReviewButton.current ?? packageFileInput.current;
        if (target?.isConnected && !target.matches(":disabled")) target.focus();
      } else if (intent.origin.isConnected && !intent.origin.disabled && (intent.action !== "start" || !pendingRef.current)) intent.origin.focus();
      return;
    }
    const target = pauseTargets.current.get(receipt.id), savedStatus = statusTargets.current.get(receipt.id), presented = jobs.find(job => job.id === receipt.id);
    if (!presented || pendingRef.current || presented.requestId !== receipt.requestId || presented.kind !== receipt.kind
      || presented.acceptedAt !== receipt.acceptedAt || presented.state !== receipt.state || presented.updatedAt !== receipt.updatedAt) return;
    if (target?.job === presented && ["queued", "running"].includes(presented.state) && target.button.isConnected && !target.button.disabled) target.button.focus();
    else if (savedStatus?.job === presented && savedStatus.element.isConnected) savedStatus.element.focus();
  }, [busy, denied, jobs]);

  function setMessage(value: string) { setMessageText(value); setMessageError(false); }

  function reportFailure(error: unknown) {
    if (!owner.isCurrent()) return;
    if (error instanceof ResearchPackageRequestError && [401, 403].includes(error.status || 0)) {
      deniedRef.current = true; reads.current.cancel(); setDenied(true); setJobs([]); setExportPreview(null); setImportPreview(null); setAcceptedScope(null); setFile(null);
    }
    setMessageText(error instanceof SessionIntentError ? error.message : researchPackageErrorMessage(error)); setMessageError(true);
  }
  function remember(value: Intent | null) {
    writeSession(storage, intentKey, value);
    pendingRef.current = value; setPending(value); setReceiptMissing(false);
  }
  function rememberRejection(value: Intent | null) {
    writeSession(storage, rejectionKey, value ? { schema: "research-package-rejection/1", intent: value } : null);
    rejectedRef.current = value; setRejected(value);
  }
  function retainEarlier(intent: Intent, receipt: ResearchRequestReceipt | null) {
    const current = earlierRef.current;
    if (!current) throw new SessionIntentError();
    const previous = current.find(row => row.intent.input.requestId === intent.input.requestId);
    if (receipt) checkedReceiptKind(intent, receipt);
    if (previous && (!sameIntent(previous.intent, intent) || previous.receipt && receipt && previous.receipt.job.id !== receipt.job.id)) throw new Error("Invalid earlier package receipt.");
    const row = { intent, receipt: receipt ?? previous?.receipt ?? null };
    const next = [...current.filter(row => row.intent.input.requestId !== intent.input.requestId), row];
    writeSession(storage, historyKey, next); earlierRef.current = next; setEarlier(next);
  }
  function rememberReceipt(receipt: ResearchRequestReceipt) {
    const checkpoint = [{ requestId: receipt.requestId, jobId: receipt.job.id, reused: receipt.reused },
      ...savedReceipts(storage).filter(item => item.requestId !== receipt.requestId)].slice(0, 20);
    writeSession(storage, receiptsKey, checkpoint); setReceipts(checkpoint);
  }
  function saveUpload(value: UploadCheckpoint | null) {
    writeSession(storage, uploadKey, value);
    uploadRef.current = value; setUpload(value);
  }
  function updateJob(job: ResearchJobStatus, refreshAfter = true) {
    if (refreshAfter) { refreshSequence.current++; needsFreshRead.current = true; pollActive.current = true; }
    setJobs(current => [job, ...current.filter(item => item.id !== job.id)].slice(0, 100));
  }
  function currentOperation(signal: AbortSignal) { return owner.isCurrent() && !signal.aborted && !deniedRef.current; }
  function ownsIntent(intent: Intent, signal: AbortSignal) {
    return currentOperation(signal) && pendingRef.current === intent;
  }
  function acceptReceipt(intent: Intent, receipt: ResearchRequestReceipt, signal: AbortSignal) {
    if (!ownsIntent(intent, signal)) return null;
    checkedReceiptKind(intent, receipt); refreshSequence.current++; retainEarlier(intent, receipt);
    updateJob(receipt.job);
    if (intent.action === "upload") saveUpload({ input: intent.input, jobId: receipt.job.id });
    rememberReceipt(receipt); rememberRejection(null);
    remember(null);
    if (intent.action === "export") setExportPreview(null);
    setMessage(receipt.reused ? receipt.job.state === "cancelled"
      ? "The earlier accepted copy is cancelled. This request did not create another research copy; use Import another copy for fresh work."
      : "An existing saved import was returned. This request did not create another research copy."
      : "Operation saved. You may leave this page; the independent executor owns its progress.");
    return receipt.job;
  }
  async function submit(intent: Intent, signal: AbortSignal, fresh = false) {
    if (!ownsIntent(intent, signal)) return null;
    // Only the live first POST can establish a rejection. A retry cannot erase
    // uncertainty left by an older delivery, even if this later POST conflicts.
    rememberRejection(null); setReceiptMissing(false);
    let receipt: ResearchRequestReceipt;
    try {
      receipt = intent.action === "export" ? await researchPackagesClient.export(intent.input, signal)
        : intent.action === "upload" ? await researchPackagesClient.acceptUpload(intent.input, signal)
          : await researchPackagesClient.import(intent.input, signal);
    } catch (error) {
      if (!ownsIntent(intent, signal)) return null;
      if (error instanceof ResearchPackageRequestError && error.status === 409) {
        if (fresh) rememberRejection(intent);
        try { receipt = await researchPackagesClient.readRequest(intent.input.requestId, signal); }
        catch (lookupError) {
          if (!ownsIntent(intent, signal)) return null;
          if (lookupError instanceof ResearchPackageRequestMissingError) {
            setReceiptMissing(true);
            setMessage(error.reason ? researchPackageErrorMessage(error)
              : fresh ? "No saved receipt was found for this rejected package request. Review a new request explicitly; this check does not cancel work in another tab."
                : "The earlier package request remains unconfirmed. A later rejected retry does not settle its original result."); return null;
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
      return acceptReceipt(intent, receipt, signal);
    } catch (error) {
      if (!ownsIntent(intent, signal)) return;
      if (error instanceof ResearchPackageRequestMissingError) {
        if (retryMissing) return submit(intent, signal);
        setReceiptMissing(true); setMessage("No receipt is recorded yet. An explicit retry will use the original request and identifier.");
      } else { setReceiptMissing(false); reportFailure(error); }
    }
    return null;
  }
  async function reviewOriginal(signal: AbortSignal) {
    const intent = pendingRef.current;
    if (!intent || !rejectedRef.current || !sameIntent(intent, rejectedRef.current)) return null;
    try {
      const receipt = await researchPackagesClient.readRequest(intent.input.requestId, signal);
      return acceptReceipt(intent, receipt, signal);
    } catch (error) {
      if (!ownsIntent(intent, signal)) return null;
      if (!(error instanceof ResearchPackageRequestMissingError)) { setReceiptMissing(false); throw error; }
      refreshSequence.current++; retainEarlier(intent, null); rememberRejection(null); remember(null);
      setExportPreview(null); setImportPreview(null); setFile(null);
      setMessage("Review a fresh package preview before accepting new work. The earlier request identifier remains available below.");
    }
    return null;
  }
  async function checkEarlier(row: EarlierRequest, signal: AbortSignal) {
    try {
      const receipt = await researchPackagesClient.readRequest(row.intent.input.requestId, signal);
      if (!currentOperation(signal)) return;
      checkedReceiptKind(row.intent, receipt); refreshSequence.current++; retainEarlier(row.intent, receipt); rememberReceipt(receipt); updateJob(receipt.job);
      setMessage(`Earlier package request ${row.intent.input.requestId} has saved job ${receipt.job.id}. No new operation was started.`);
    } catch (error) {
      if (!currentOperation(signal)) return;
      if (!(error instanceof ResearchPackageRequestMissingError)) throw error;
      setMessage("No saved receipt was found for that earlier package request at this check. Its original identifier is retained.");
    }
  }
  function refresh(signal: AbortSignal, announce = false, fresh = announce) {
    let sequence = 0;
    return reads.current.run(signal, round => {
      sequence = refreshSequence.current + 1;
      return readStatus(round, signal, announce);
    }, { fresh, onTimeout(error) {
      if (currentOperation(signal) && sequence === refreshSequence.current) { pollActive.current = true; setReadError(error.message); setReadPhase("error"); }
    } });
  }
  async function readStatus(round: ReadRound, ownerSignal: AbortSignal, announce = false) {
    const signal = round.signal;
    if (!currentOperation(signal)) return;
    const sequence = ++refreshSequence.current;
    if (announce) setReadPhase("loading");
    try {
      const [list, status] = await round.all([researchPackagesClient.list(signal), researchPackagesClient.executor(signal)]);
      if (!currentOperation(signal) || sequence !== refreshSequence.current) return;
      const savedIds = [...new Set(savedReceipts(storage).map(receipt => receipt.jobId))].filter(id => !list.some(job => job.id === id));
      const recovered = await round.all(savedIds.map(async id => {
        try { return await researchPackagesClient.status(id, signal); }
        catch (error) {
          if (error instanceof ResearchPackageRequestError && [404, 410].includes(error.status || 0)) return null;
          throw error;
        }
      }));
      if (!currentOperation(signal) || sequence !== refreshSequence.current) return;
      const visible = [...recovered.filter((job): job is ResearchJobStatus => job !== null), ...list].slice(0, 100);
      pollActive.current = visible.some(job => ["queued", "running", "cancel_requested"].includes(job.state)) || !!pendingRef.current;
      needsFreshRead.current = false;
      setJobs(visible); setExecutor(status); setJobsLoaded(true); setReadError(null); setReadPhase("ready");
      const checkpoint = uploadRef.current;
      if (checkpoint) {
        const uploaded = visible.find(job => job.id === checkpoint.jobId) || await researchPackagesClient.status(checkpoint.jobId, signal);
        if (!currentOperation(signal) || sequence !== refreshSequence.current || uploadRef.current?.jobId !== checkpoint.jobId) return;
        if (["queued", "running", "cancel_requested"].includes(uploaded.state)) pollActive.current = true;
        if (!visible.some(job => job.id === uploaded.id)) updateJob(uploaded, false);
        if (uploaded?.state === "preview") {
          const previewSuffix = suffixRef.current;
          const preview = await researchPackagesClient.preview(checkpoint.jobId, previewSuffix, signal);
          if (currentOperation(signal) && sequence === refreshSequence.current && suffixRef.current === previewSuffix
            && uploadRef.current?.jobId === checkpoint.jobId) setImportPreview(preview);
        } else if (uploaded) setImportPreview(null);
      }
    } catch (error) {
      if (!currentOperation(ownerSignal) || sequence !== refreshSequence.current || isReadCancellation(signal)) return;
      pollActive.current = true;
      if (error instanceof ResearchPackageRequestError && [401, 403].includes(error.status || 0)) reportFailure(error);
      else {
        const helpfulReadFailure = error instanceof ResearchPackageRequestError
          && (error.reason !== null || [400, 410, 413, 422, 503].includes(error.status || 0));
        setReadError(signal.reason instanceof ReadTimeoutError ? signal.reason.message : helpfulReadFailure ? researchPackageErrorMessage(error)
          : "Package status could not be read. Retry the status check.");
        setReadPhase("error");
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let stopped = false;
    void (async () => {
      if (pendingRef.current) { try { await reconcile(controller.signal); } catch (error) { if (currentOperation(controller.signal)) reportFailure(error); } }
      if (!stopped && currentOperation(controller.signal)) polling.current = startVisibleReadPolling({
        read: () => refresh(controller.signal), current: () => currentOperation(controller.signal),
        active: () => pollActive.current || !!pendingRef.current,
        cancel: () => reads.current.cancel(),
      });
    })();
    return () => { stopped = true; controller.abort(); reads.current.cancel(); polling.current?.stop(); polling.current = null; refreshSequence.current++; };
  }, []);
  useEffect(() => {
    if (busy || !returnExportPreviewFocus.current) return;
    const { button, signal } = returnExportPreviewFocus.current;
    returnExportPreviewFocus.current = null;
    if (signal !== lifetime.current?.signal || !currentOperation(signal)) return;
    if (button === exportPreviewButton.current && button.isConnected && !button.matches(":disabled")
      && (document.activeElement === document.body || document.activeElement === button)) button.focus();
  }, [busy]);
  async function act(operation: (signal: AbortSignal) => Promise<void>, preserveMessage = false) {
    const controller = lifetime.current;
    if (!controller || !currentOperation(controller.signal) || busyRef.current) return;
    actionSequence.current++; clearPageFocus(); busyRef.current = true; setBusy(true); if (!preserveMessage) setMessage("");
    try { await operation(controller.signal); }
    catch (error) { if (currentOperation(controller.signal)) reportFailure(error); }
    finally { if (currentOperation(controller.signal)) { busyRef.current = false; setBusy(false);
      if (needsFreshRead.current) { needsFreshRead.current = false; polling.current?.refresh(); }
    } }
  }
  function exportInput() {
    const roots = rootText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const separator = line.indexOf(":"); return { kind: line.slice(0, separator), id: line.slice(separator + 1) };
    });
    return checkedResearchExportPlanInput({ kind, roots });
  }
  async function startExport(signal: AbortSignal) {
    if (!exportPreview || pendingRef.current || !currentOperation(signal) || earlierRef.current === null) return;
    const capability = kind === "report" ? exportPreview.capabilities.report : exportPreview.capabilities.dataPackage;
    if (!capability.available || kind === "data_package" && !exportPreview.complete) return;
    const intent: Intent = { action: "export", input: checkedResearchExportInput({ requestId: crypto.randomUUID(), ...exportInput() }) };
    remember(intent); return submit(intent, signal, true);
  }
  async function prepareUpload(signal: AbortSignal) {
    const selectedFile = file, originalUpload = uploadRef.current, sequence = actionSequence.current;
    const ownsPreparation = (checkpoint: UploadCheckpoint | null) => currentOperation(signal)
      && signal === lifetime.current?.signal && sequence === actionSequence.current && !pendingRef.current
      && uploadRef.current === checkpoint && earlierRef.current !== null;
    if (!selectedFile || !ownsPreparation(originalUpload)) return;
    if (selectedFile.size < 1 || selectedFile.size > RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES) { setMessage("Select a native ZIP between 1 byte and 100 MiB."); return; }
    setMessage("Checking the selected file with a bounded streaming hash…");
    const measured = await hashResearchFile(selectedFile, { maxBytes: RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, signal });
    if (!ownsPreparation(originalUpload)) return;
    setMessage("Validating bounded ZIP members and checksums before accepting its upload…");
    await validateStoreArchive(sourceFromBlob(selectedFile), { expectedSha256: measured.sha256, signal });
    if (!ownsPreparation(originalUpload)) return;
    let checkpoint = originalUpload;
    let jobId: string;
    if (checkpoint && currentUpload?.state === "awaiting_upload") {
      if (checkpoint.input.byteSize !== measured.byteSize || checkpoint.input.sha256 !== measured.sha256) {
        setMessage("This file differs from the accepted upload. Reselect the original ZIP or cancel its saved validation job."); return;
      }
      jobId = checkpoint.jobId;
    } else {
      if (checkpoint) { setMessage("Finish or close the current package preview before selecting another upload."); return; }
      const intent: Intent = { action: "upload", input: checkedResearchUploadInput({ requestId: crypto.randomUUID(), ...measured }) };
      remember(intent); const job = await submit(intent, signal, true); if (!job) return;
      checkpoint = uploadRef.current;
      if (!checkpoint || checkpoint.jobId !== job.id || checkpoint.input.requestId !== intent.input.requestId) return;
      jobId = job.id;
    }
    if (!ownsPreparation(checkpoint)) return;
    setMessage("Uploading the selected ZIP. Validation continues in the independent executor.");
    const job = await researchPackagesClient.upload(jobId, selectedFile, signal);
    if (ownsPreparation(checkpoint)) { refreshSequence.current++; updateJob(job); setFile(null); setMessage("Package uploaded. Validation is saved independently of this page."); }
  }
  async function startImport(signal: AbortSignal, anotherCopy: boolean) {
    if (!uploadRef.current || !importPreview || importPreview.rolePolicyRevision === null || importPreview.kind !== "data_package" || !importPreview.complete
      || !importPreview.capabilities.dataPackage.available || pendingRef.current) return;
    if (!currentOperation(signal) || earlierRef.current === null) return;
    const intent: Intent = { action: "import", input: checkedResearchImportInput({ requestId: crypto.randomUUID(), uploadJobId: uploadRef.current.jobId,
      anotherCopy, expectedRolePolicyRevision: importPreview.rolePolicyRevision, naming: { suffix } }) };
    remember(intent); await submit(intent, signal, true);
  }
  const exportCapability = exportPreview && (kind === "report" ? exportPreview.capabilities.report : exportPreview.capabilities.dataPackage);
  const mayImport = importPreview?.kind === "data_package" && importPreview.rolePolicyRevision !== null && importPreview.complete && importPreview.capabilities.dataPackage.available;
  const blocked = busy || earlier === null || !!pending || denied;
  return <div className="page storage-settings-page research-packages-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>Data</h1>
      <p className="lead">Export research packages and offline reports, or import a native package as a new research copy.</p></div>
      <button ref={refreshButton} className="button" disabled={busy || denied} onClick={event => {
        const origin = event.currentTarget; void act(async signal => { beginPageFocus("refresh", origin, signal); await refresh(signal, true); }, true);
      }}>Refresh status</button></div>
    {message && (denied || !messageError) && <p role={denied ? "alert" : "status"}>{message}</p>}
    <ReadStatus loading={readPhase === "loading" && !denied} loadingMessage="Reading saved package work…"
      error={!denied ? readError : null} errorTitle="Package status unavailable"
      onRetry={() => void act(signal => refresh(signal, true), true)} retryLabel="Retry reading package status" />
    <ReadStatus loading={false} loadingMessage="" error={!denied && messageError ? message : null} errorTitle="Data operation unavailable"
      onRetry={() => void act(signal => refresh(signal, true), true)} retryLabel="Read current package status" />
    {denied ? <p>Sign in with an account allowed to use the application before continuing. Saved operation identifiers are retained for reconciliation.</p> : <>
      <section className="card storage-settings-section research-package-execution" aria-labelledby="research-package-execution-title">
        <div className="research-package-execution-heading"><h2 className="card-title" id="research-package-execution-title">Independent executor</h2>
          {executor && <p>{!executor.supported ? "Package jobs are unavailable on this runtime." : !executor.enabled ? "Execution is paused." : executor.stale ? "Execution is enabled, but no recent heartbeat was recorded." : "Execution is enabled."}</p>}</div>
        {executor && <>
          {executor.reason && (executor.enabled || executor.reason !== "disabled") && <p className="muted">{reasonText(executor.reason)}.</p>}
          {(!executor.enabled || executor.stale) && <p className="muted">Accepted work remains queued or paused until the independently invoked runner is available. Refreshing or polling this page does not execute it.</p>}
          {executor.canManage && <p><Link to="/settings/storage/migrations">Administrator executor controls</Link></p>}</>}
      </section>
      {earlier === null && <p role="alert">Saved package request history could not be read. Restore its browser checkpoints before starting new work.</p>}
      {pending && <section className="card storage-settings-section"><h2 className="card-title">Unconfirmed operation</h2>
        <p>The {pending.action} request <code>{pending.input.requestId}</code> is retained. Check its receipt before starting another operation.</p>
        <div className="storage-candidate-actions">
          <button ref={checkButton} className="button" aria-label="Check original package request" disabled={busy} onClick={event => {
            const origin = event.currentTarget; void act(async signal => {
              const intent = beginPageFocus("check", origin, signal), receipt = await reconcile(signal);
              if (intent && returnPageFocus.current === intent && receipt) intent.receipt = receipt;
            });
          }}>Check original request</button>
          {receiptMissing && <button ref={retryButton} className="button" aria-label="Retry original package request" disabled={busy} onClick={event => {
            const origin = event.currentTarget; void act(async signal => {
              const intent = beginPageFocus("retry", origin, signal), receipt = await reconcile(signal, true);
              if (intent && returnPageFocus.current === intent && receipt) intent.receipt = receipt;
            });
          }}>Retry original request</button>}
          {receiptMissing && rejected && sameIntent(rejected, pending) && <button ref={reviewButton} className="button" aria-label="Review a new package request" disabled={busy} onClick={event => {
            const origin = event.currentTarget; void act(async signal => {
              const intent = beginPageFocus("review", origin, signal), receipt = await reviewOriginal(signal);
              if (intent && returnPageFocus.current === intent && receipt) intent.receipt = receipt;
            });
          }}>Review a new request</button>}
        </div></section>}
      <SettingsTaskNavigation label="Data tasks" items={[
        { id: "research-package-export", label: "Export" },
        { id: "research-package-import", label: "Import" },
        { id: "research-package-work", label: "Saved work" },
      ]} />
      <section id="research-package-export" className="card storage-settings-section settings-task-section" aria-labelledby="research-package-export-title" tabIndex={-1}><h2 className="card-title" id="research-package-export-title">Export selected research</h2>
        <p className="muted">Choose Data package or Offline report from a <Link to="/samples">Sample</Link> or <Link to="/projects">Project</Link>, or enter up to 20 roots below.</p>
        <form onSubmit={event => { event.preventDefault(); void act(async signal => {
          const button = exportPreviewButton.current;
          returnExportPreviewFocus.current = button && document.activeElement === button ? { button, signal } : null;
          const preview = await researchPackagesClient.plan(exportInput(), signal); if (currentOperation(signal)) setExportPreview(preview);
        }); }}>
          <fieldset disabled={blocked || executor?.supported === false}><div className="storage-candidate-fields">
            <label>Export format<select value={kind} onChange={event => { setKind(event.target.value as ResearchExportKind); setExportPreview(null); }}>
              <option value="data_package">Native data package</option><option value="report">Offline HTML and Markdown report</option></select></label>
            <label>Sample and Project roots<textarea rows={3} value={rootText} placeholder="sample:record-id or project:record-id, one per line"
              onChange={event => { setRootText(event.target.value); setExportPreview(null); }} required /></label>
          </div><button ref={exportPreviewButton} className="button" type="submit">Preview export</button></fieldset>
        </form>
        {exportPreview && <><Preview value={exportPreview} />
          {!exportCapability?.available && <ul>{exportCapability?.reasons.map(code => <li key={code}>{reasonText(code)}</li>)}</ul>}
          {kind === "data_package" && !exportPreview.complete && <p className="warning-card">This scope cannot produce a complete native package. Export an available report or resolve the missing dependencies.</p>}
          <button ref={startButton} className="button primary" disabled={blocked || !exportCapability?.available || kind === "data_package" && !exportPreview.complete}
            onClick={event => { const origin = event.currentTarget; void act(async signal => {
              const intent = beginPageFocus("start", origin, signal), receipt = await startExport(signal);
              if (intent && returnPageFocus.current === intent && receipt) intent.receipt = receipt;
            }); }}>Start {kind === "report" ? "report" : "data package"} export</button></>}
      </section>
      <section id="research-package-import" className="card storage-settings-section settings-task-section" aria-labelledby="research-package-import-title" tabIndex={-1}><h2 className="card-title" id="research-package-import-title">Import a native data package</h2>
        <p className="muted">Native research packages create fresh business identities and retain source provenance. Existing readable ZIPs, FabuBlox workbooks and whole-installation backups are separate formats.</p>
        <p className="muted">Select a native ZIP up to 100 MiB. Full format and size limits are in Package limits and execution details below.</p>
        <label>Native package ZIP<input ref={packageFileInput} type="file" accept=".zip,application/zip" disabled={blocked || executor?.supported === false || !!upload && currentUpload?.state !== "awaiting_upload"}
          onChange={event => setFile(event.target.files?.[0] || null)} /></label>
        {upload && currentUpload?.state === "awaiting_upload" && <p className="muted">The accepted upload is waiting for bytes. After reload or interruption, reselect the original {size(upload.input.byteSize)} ZIP; its streaming hash must match.</p>}
        <div className="storage-candidate-actions"><button className="button" disabled={blocked || !file || executor?.supported === false}
          onClick={() => void act(prepareUpload)}>{upload ? "Resume original upload" : "Upload and validate package"}</button>
          {upload && <button className="button" disabled={busy} onClick={() => void act(signal => refresh(signal, true), true)}>Check uploaded package</button>}</div>
        {upload && <p className="muted">Validation job: <code>{upload.jobId}</code>. Upload interruption does not authorize a new copy or discard accepted work.</p>}
        {upload && currentUpload?.state === "preview" && <><label>Imported name suffix<input maxLength={32} value={suffix} disabled={blocked}
          onChange={event => { setSuffix(event.target.value); setImportPreview(null); }} /></label>
          <button ref={importReviewButton} className="button" disabled={blocked} onClick={() => void act(async signal => {
            const value = await researchPackagesClient.preview(upload.jobId, suffix, signal); if (currentOperation(signal)) setImportPreview(value);
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
      <section id="research-package-work" className="card storage-settings-section settings-task-section" aria-labelledby="research-package-work-title" tabIndex={-1}><h2 className="card-title" id="research-package-work-title">Saved package work</h2>
        <p className="muted">Work persists when the browser closes. Pause and cancel take effect at a safe boundary; cancellation retains committed copies. Cleanup is separate and does not remove published research.</p>
        {!jobsLoaded && readPhase === "error" && <p className="muted">Saved package work has not been read. Refresh status to check it.</p>}
        {jobsLoaded && readPhase !== "ready" && jobs.length > 0 && <p className="muted">{readPhase === "error"
          ? "Showing previously read package work. Its current status could not be refreshed."
          : "Showing previously read package work while status is refreshed."}</p>}
        {!jobs.length && readPhase === "ready" && <p className="muted">No package jobs are recorded for your account.</p>}
        {acceptedScope && <div className="research-package-accepted-scope"><h3>Accepted import scope</h3><p><code>{acceptedScope.jobId}</code></p>
          <Preview value={acceptedScope.preview} accepted /><button className="text-button" onClick={() => setAcceptedScope(null)}>Close accepted scope</button></div>}
        {jobs.map(job => <Job key={job.id} job={job} onPauseTarget={(presented, button) => {
          if (button) pauseTargets.current.set(presented.id, { job: presented, button }); else pauseTargets.current.delete(presented.id);
        }} onStatusTarget={(presented, element) => {
          if (element) statusTargets.current.set(presented.id, { job: presented, element }); else statusTargets.current.delete(presented.id);
        }} busy={blocked} allowed={!denied && !pending} currentSignal={lifetime.current?.signal ?? null}
          reused={receipts.some(receipt => receipt.jobId === job.id && receipt.reused)}
          onViewScope={id => void act(async signal => {
            const preview = await researchPackagesClient.preview(id, undefined, signal);
            if (currentOperation(signal)) setAcceptedScope({ jobId: id, preview });
          })} onSelectUpload={id => void act(async signal => {
          const [input, value] = await Promise.all([researchPackagesClient.uploadIntent(id, signal), researchPackagesClient.status(id, signal)]);
          if (!currentOperation(signal)) return;
          if (value.kind !== "upload" || value.requestId !== input.requestId) throw new Error("Invalid saved upload.");
          saveUpload({ input, jobId: id }); updateJob(value); setFile(null); setImportPreview(null);
          if (value.state === "preview") {
            const preview = await researchPackagesClient.preview(id, suffix, signal); if (currentOperation(signal)) setImportPreview(preview);
          }
          setMessage(value.state === "awaiting_upload" ? "Saved upload selected. Reselect the original ZIP to verify and continue it." : "Saved package selected. Its validated preview is available when validation finishes.");
        })} onControl={(id, action, onStarting, onReceipt) => void act(async signal => {
          onStarting(signal);
          const value = await researchPackagesClient.control(id, action, signal); if (currentOperation(signal)) {
            refreshSequence.current++; updateJob(value); onReceipt(value); setMessage("Saved job state updated. Check status to follow its independent progress.");
          }
        })} />)}
        {earlier?.length ? <section className="research-package-history" aria-labelledby="research-package-earlier-title"><h3 id="research-package-earlier-title">Earlier package requests</h3>
          <p className="muted">Original requests remain available after acceptance or explicit fresh review. Checking a saved receipt does not start another operation.</p>
          <ul className="storage-profile-list">{earlier.map(row => <li key={row.intent.input.requestId}><code>{row.intent.input.requestId}</code>
            {row.receipt && <p>{jobNames[row.receipt.job.kind]} receipt retained.</p>}
            <button className="button" aria-label={`Check earlier package request ${row.intent.input.requestId}`} disabled={busy}
              onClick={() => void act(signal => checkEarlier(row, signal))}>Check saved receipt</button></li>)}</ul>
        </section> : null}
      </section>
      <details className="research-package-technical-details">
        <summary>Package limits and execution details</summary>
        <p className="muted">Supported native ZIP: STORE entries, up to 100 MiB total, 100 files, 96 MiB of file content, 1,200 records and 4 MiB of metadata. Individual ceilings do not guarantee that their combined ZIP fits.</p>
        {executor?.lastHeartbeatAt && <p className="muted">Last heartbeat: <time dateTime={executor.lastHeartbeatAt}>{executor.lastHeartbeatAt}</time>.</p>}
      </details>
    </>}
    <div className="settings-related-tools"><p>Related tools</p>
      <nav className="research-package-navigation" aria-label="Related data tools"><Link to="/settings/storage">Storage settings</Link><Link to="/export">Content archive</Link>
        <Link to="/settings/data/system">System backup and recovery</Link>
        <Link to="/imports/fabublox">FabuBlox workbook import</Link></nav>
    </div>
  </div>;
}
