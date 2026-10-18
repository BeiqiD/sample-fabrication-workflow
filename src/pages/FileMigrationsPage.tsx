import { checkpointStorage, type CheckpointStorage } from "../lib/browser-checkpoints";
import { captureApplicationOwner } from "../lib/authentication-client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { checkedAcceptFileMigration, type AcceptFileMigrationInput, type FileJobExecutorStatus, type FileJobStatus, type FileMigrationPlan, type FileMigrationItems } from "../../shared/contracts/file-jobs";
import type { StorageSettingsProfile } from "../../shared/contracts/storage-settings";
import { ReadStatus } from "../components/ReadStatus";
import { api, StoragePolicyRequestError } from "../lib/api";
import { fileJobsClient, FileMigrationRequestError, FileMigrationRequestMissingError, fileMigrationErrorMessage, type MigrationInventory } from "../lib/file-jobs-client";
import { storageConfigurationClient, StorageConfigurationRequestError } from "../lib/storage-configuration-client";
import "./storage-settings.css";

const intentKey = "file-migration-acceptance";
const rejectionKey = "file-migration-acceptance-rejection", historyKey = "file-migration-earlier-requests";
type EarlierRequest = { input: AcceptFileMigrationInput; jobId: string | null };
const sameInput = (left: AcceptFileMigrationInput, right: AcceptFileMigrationInput) => JSON.stringify(left) === JSON.stringify(right);
function remembered(storage: CheckpointStorage): AcceptFileMigrationInput | null {
  try { const saved = storage.getItem(intentKey); return saved ? checkedAcceptFileMigration(JSON.parse(saved)) : null; } catch { return null; }
}
function rememberedRejection(storage: CheckpointStorage): AcceptFileMigrationInput | null {
  try {
    const row = JSON.parse(storage.getItem(rejectionKey) || "null"), pending = remembered(storage);
    if (!row || Object.keys(row).length !== 2 || row.schema !== "file-migration-rejection/1") return null;
    const input = checkedAcceptFileMigration(row.input);
    return pending && sameInput(input, pending) ? input : null;
  } catch { return null; }
}
function rememberedHistory(storage: CheckpointStorage): EarlierRequest[] | null {
  try {
    const rows: unknown = JSON.parse(storage.getItem(historyKey) || "[]");
    if (!Array.isArray(rows)) return null;
    const seen = new Set<string>();
    return rows.map(row => {
      if (!row || Object.keys(row).length !== 2 || !(row.jobId === null || typeof row.jobId === "string" && row.jobId.length > 0 && row.jobId.length <= 128)) throw new Error();
      const input = checkedAcceptFileMigration(row.input);
      if (seen.has(input.requestId)) throw new Error(); seen.add(input.requestId);
      return { input, jobId: row.jobId };
    });
  } catch { return null; }
}
class MigrationCheckpointError extends Error {
  constructor() { super("Browser request checkpoints could not be retained. Keep the original migration request and restore session storage before continuing."); }
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
type FileJobControl = Parameters<typeof fileJobsClient.control>[1];
function SavedJobControls({ job, busy, allowed, currentSignal, onControl, onPauseTarget, onStatusTarget }: {
  job: FileJobStatus; busy: boolean; allowed: boolean; currentSignal: AbortSignal | null;
  onPauseTarget: (job: FileJobStatus, button: HTMLButtonElement | null) => void;
  onStatusTarget: (job: FileJobStatus, element: HTMLParagraphElement | null) => void;
  onControl: (action: FileJobControl, onStarting: (signal: AbortSignal) => void, onReceipt: (receipt: FileJobStatus) => void) => void;
}) {
  const buttons = useRef(new Map<FileJobControl, HTMLButtonElement>());
  const status = useRef<HTMLParagraphElement>(null);
  type FocusIntent = { action: FileJobControl; origin: HTMLButtonElement; source: FileJobStatus; signal: AbortSignal;
    receipt: FileJobStatus | null; movedAway: boolean; stopObserving: () => void };
  const returnFocus = useRef<FocusIntent | null>(null);
  function clearFocusIntent() { returnFocus.current?.stopObserving(); returnFocus.current = null; }
  useLayoutEffect(() => () => clearFocusIntent(), []);
  useLayoutEffect(() => {
    if (busy) return;
    const intent = returnFocus.current; clearFocusIntent();
    if (!intent || !allowed || intent.signal.aborted || intent.signal !== currentSignal || intent.movedAway
      || job.id !== intent.source.id || job.target.profileId !== intent.source.target.profileId
      || job.target.configurationRevision !== intent.source.target.configurationRevision
      || document.activeElement !== document.body && document.activeElement !== intent.origin) return;
    if (buttons.current.get(intent.action) === intent.origin && intent.origin.isConnected && !intent.origin.disabled
      && job.state === intent.source.state && job.updatedAt === intent.source.updatedAt) { intent.origin.focus(); return; }
    const receipt = intent.receipt;
    if (!receipt || receipt.id !== job.id || receipt.state !== job.state || receipt.updatedAt !== job.updatedAt
      || receipt.target.profileId !== job.target.profileId || receipt.target.configurationRevision !== job.target.configurationRevision) return;
    const next = intent.action === "pause" && job.state === "paused" ? buttons.current.get(job.failed ? "retry" : "resume")
      : (intent.action === "resume" || intent.action === "retry") && (job.state === "queued" || job.state === "running") ? buttons.current.get("pause")
        : intent.action === "cancel" && (job.state === "cancelled" || job.state === "cancel_requested") ? status.current : null;
    if (next?.isConnected && (!(next instanceof HTMLButtonElement) || !next.disabled)) next.focus();
  }, [busy, allowed, currentSignal, job]);
  const controls: FileJobControl[] = [];
  if (job.state === "running" || job.state === "queued") controls.push("pause");
  if (job.state === "paused") controls.push(job.failed ? "retry" : "resume");
  if (!["completed", "cancelled", "cancel_requested"].includes(job.state)) controls.push("cancel");
  if (job.cleanupPending > 0) controls.push("cleanup");
  return <>
    <p ref={element => { status.current = element; onStatusTarget(job, element); }} role="status" tabIndex={-1}>{job.state} · {job.moved} moved · {job.remaining} remaining · {job.failed} failed · {job.cleanupPending} cleanup pending</p>
    <p className="muted">Destination: {job.target.profileId}{job.reason && <> · {jobReason(job.reason)}</>}</p>
    <div className="storage-candidate-actions">{controls.map(action => <button key={action} type="button" className="button" disabled={busy}
      ref={button => { if (button) buttons.current.set(action, button); else buttons.current.delete(action);
        if (action === "pause") onPauseTarget(job, button); }}
      onClick={event => {
        const origin = event.currentTarget; const admitted: { current: FocusIntent | null } = { current: null };
        onControl(action, signal => {
          clearFocusIntent();
          if (document.activeElement !== origin || buttons.current.get(action) !== origin || !origin.isConnected) return;
          const moved = (event: FocusEvent) => { if (admitted.current && event.target !== origin && event.target !== document.body) admitted.current.movedAway = true; };
          const blurred = () => { if (admitted.current) admitted.current.movedAway = true; };
          admitted.current = { action, origin, source: job, signal, receipt: null, movedAway: false,
            stopObserving: () => { document.removeEventListener("focusin", moved, true); window.removeEventListener("blur", blurred); } };
          returnFocus.current = admitted.current;
          document.addEventListener("focusin", moved, true); window.addEventListener("blur", blurred);
        }, receipt => { if (admitted.current && returnFocus.current === admitted.current) admitted.current.receipt = receipt; });
      }}>{action === "pause" ? "Pause job" : action === "resume" ? "Resume job" : action === "retry" ? "Retry failed files"
        : action === "cancel" ? "Cancel remaining files" : "Request source cleanup"}</button>)}</div>
  </>;
}
export function FileMigrationsPage() {
  const [owner] = useState(captureApplicationOwner);
  const [storage] = useState(() => checkpointStorage(owner));
  const [authorized, setAuthorized] = useState<boolean | null>(null), [profiles, setProfiles] = useState<StorageSettingsProfile[]>([]);
  const [inventory, setInventory] = useState<MigrationInventory>({ items: [], nextCursor: null });
  const [selection, setSelection] = useState<string[]>([]), [target, setTarget] = useState("");
  const [jobs, setJobs] = useState<FileJobStatus[]>([]), [executor, setExecutor] = useState<FileJobExecutorStatus | null>(null);
  const [plan, setPlan] = useState<FileMigrationPlan | null>(null), [pending, setPending] = useState(() => remembered(storage));
  const pendingRef = useRef(pending);
  const [rejected, setRejected] = useState(() => rememberedRejection(storage)), rejectedRef = useRef(rejected);
  const [receiptMissing, setReceiptMissing] = useState(false);
  const [earlier, setEarlier] = useState(() => rememberedHistory(storage)), earlierRef = useRef(earlier);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [accessLoading, setAccessLoading] = useState(true), [accessError, setAccessError] = useState("");
  const [metadataLoading, setMetadataLoading] = useState(false), [metadataRead, setMetadataRead] = useState(false), [metadataError, setMetadataError] = useState("");
  const [jobsLoading, setJobsLoading] = useState(false), [jobsRead, setJobsRead] = useState(false), [jobsError, setJobsError] = useState("");
  const [details, setDetails] = useState<FileMigrationItems | null>(null), [detailId, setDetailId] = useState<string | null>(null);
  const detailJob = useRef<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), busyRef = useRef(false), sequence = useRef(0);
  const canManage = useRef(false), refreshSequence = useRef(0);
  const metadataSequence = useRef(0), retryInitialRead = useRef<() => void>(() => {});
  const initialIntentRead = useRef(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const returnPreviewFocus = useRef<{ button: HTMLButtonElement; signal: AbortSignal } | null>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const replanButton = useRef<HTMLButtonElement>(null), destination = useRef<HTMLSelectElement>(null);
  const pauseTargets = useRef(new Map<string, { job: FileJobStatus; button: HTMLButtonElement }>());
  const statusTargets = useRef(new Map<string, { job: FileJobStatus; element: HTMLParagraphElement }>());
  type StartFocusIntent = { origin: HTMLButtonElement; signal: AbortSignal; sequence: number; receipt: FileJobStatus | null;
    replan: boolean; movedAway: boolean; stopObserving: () => void };
  const returnStartFocus = useRef<StartFocusIntent | null>(null);
  function clearStartFocus() { returnStartFocus.current?.stopObserving(); returnStartFocus.current = null; }
  function beginStartFocus(origin: HTMLButtonElement, signal: AbortSignal) {
    if (document.activeElement !== origin || origin !== startButton.current && origin !== retryButton.current && origin !== replanButton.current || !origin.isConnected) return null;
    const intent: StartFocusIntent = { origin, signal, sequence: sequence.current, receipt: null, replan: origin === replanButton.current, movedAway: false,
      stopObserving: () => { document.removeEventListener("focusin", moved, true); window.removeEventListener("blur", blurred); } };
    const moved = (event: FocusEvent) => { if (event.target !== origin && event.target !== document.body) intent.movedAway = true; };
    const blurred = () => { intent.movedAway = true; };
    returnStartFocus.current = intent;
    document.addEventListener("focusin", moved, true); window.addEventListener("blur", blurred);
    return intent;
  }
  useLayoutEffect(() => () => clearStartFocus(), []);
  useLayoutEffect(() => {
    if (busy) return;
    const intent = returnStartFocus.current; clearStartFocus();
    if (!intent || intent.signal !== lifetime.current?.signal || intent.signal.aborted || !canManage.current || authorized !== true
      || intent.sequence !== sequence.current || intent.movedAway
      || document.activeElement !== document.body && document.activeElement !== intent.origin) return;
    const receipt = intent.receipt;
    if (!receipt) {
      if (intent.replan && !pendingRef.current && destination.current?.isConnected && !destination.current.disabled) destination.current.focus();
      else if ((intent.origin === startButton.current || intent.origin === retryButton.current || intent.origin === replanButton.current) && intent.origin.isConnected && !intent.origin.disabled) intent.origin.focus();
      return;
    }
    const target = pauseTargets.current.get(receipt.id), savedStatus = statusTargets.current.get(receipt.id), presented = jobs.find(job => job.id === receipt.id);
    if (!presented || presented.actor !== receipt.actor || presented.acceptedAt !== receipt.acceptedAt
      || presented.target.profileId !== receipt.target.profileId || presented.target.configurationRevision !== receipt.target.configurationRevision
      || presented.state !== receipt.state || presented.updatedAt !== receipt.updatedAt) return;
    if (target?.job === presented && ["queued", "running"].includes(presented.state) && target.button.isConnected && !target.button.disabled) target.button.focus();
    else if (savedStatus?.job === presented && savedStatus.element.isConnected) savedStatus.element.focus();
  }, [busy, authorized, jobs]);
  function checkAccessError(error: unknown) {
    if (!owner.isCurrent()) return false;
    if ((error instanceof FileMigrationRequestError || error instanceof StorageConfigurationRequestError || error instanceof StoragePolicyRequestError)
      && (error.status === 401 || error.status === 403)) {
      canManage.current = false; setAuthorized(false);
      return true;
    }
    return false;
  }
  function reportError(error: unknown) {
    checkAccessError(error);
    setMessageIsError(true); setMessage(error instanceof MigrationCheckpointError ? error.message : fileMigrationErrorMessage(error));
  }
  function remember(input: AcceptFileMigrationInput | null) {
    try { if (input) storage.setItem(intentKey, JSON.stringify(input)); else storage.removeItem(intentKey); }
    catch { throw new MigrationCheckpointError(); }
    pendingRef.current = input; setPending(input); setReceiptMissing(false);
  }
  function rememberRejection(input: AcceptFileMigrationInput | null) {
    try { if (input) storage.setItem(rejectionKey, JSON.stringify({ schema: "file-migration-rejection/1", input })); else storage.removeItem(rejectionKey); }
    catch { throw new MigrationCheckpointError(); }
    rejectedRef.current = input; setRejected(input); setReceiptMissing(false);
  }
  function retainEarlier(input: AcceptFileMigrationInput, jobId: string | null) {
    const saved = earlierRef.current;
    if (!saved) throw new MigrationCheckpointError();
    const previous = saved.find(row => row.input.requestId === input.requestId);
    if (previous && (!sameInput(previous.input, input) || previous.jobId && jobId && previous.jobId !== jobId)) throw new Error("Invalid migration request checkpoint.");
    const row = { input, jobId: previous?.jobId ?? jobId }, next = [...saved.filter(row => row.input.requestId !== input.requestId), row];
    try { storage.setItem(historyKey, JSON.stringify(next)); } catch { throw new MigrationCheckpointError(); }
    earlierRef.current = next; setEarlier(next);
  }
  function currentOperation(signal: AbortSignal, current: number) { return owner.isCurrent() && !signal.aborted && canManage.current && current === sequence.current; }
  function acceptReceipt(input: AcceptFileMigrationInput, value: FileJobStatus) {
    retainEarlier(input, value.id);
    rememberRejection(null); remember(null); setPlan(null); setSelection([]);
    setMessageIsError(false); setMessage(`Migration ${value.id} accepted. You can leave this page while the executor continues.`);
    return value;
  }
  async function checkPending(signal: AbortSignal, current: number) {
    const original = pendingRef.current; if (!original) return null;
    try {
      const receipt = await fileJobsClient.readRequest(original, signal);
      if (currentOperation(signal, current) && pendingRef.current && sameInput(pendingRef.current, original)) return acceptReceipt(original, receipt.job);
    } catch (error) {
      if (!currentOperation(signal, current)) return null;
      if (!(error instanceof FileMigrationRequestMissingError)) { setReceiptMissing(false); throw error; }
      setReceiptMissing(true); setMessageIsError(false);
      setMessage(rejectedRef.current && sameInput(rejectedRef.current, original)
        ? "No saved receipt was found for this rejected request. Review a fresh plan or explicitly retry the original request. This status does not cancel work in another tab."
        : "No saved receipt is recorded yet. The original request remains unconfirmed; check again or explicitly retry the same request.");
    }
    return null;
  }
  async function readMetadata(signal: AbortSignal) {
    if (!owner.isCurrent() || !canManage.current || signal.aborted) return;
    const currentRead = ++metadataSequence.current;
    setMetadataLoading(true); setMetadataError("");
    try {
      const [settings, files] = await Promise.all([api.getCurrentStorageSettings(signal), fileJobsClient.inventory(undefined, signal)]);
      if (!owner.isCurrent() || signal.aborted || !canManage.current || currentRead !== metadataSequence.current) return;
      setProfiles(settings.version === 3 ? settings.profiles.items.filter(profile => profile.runtimeAccess === "read_write" && profile.availability === "available")
        : settings.profiles.items.filter(profile => profile.runtimeAccess === "read_write" && profile.bindingMatch === "matched"));
      setInventory(files); setMetadataRead(true);
    } catch (error) {
      if (owner.isCurrent() && !signal.aborted && canManage.current && currentRead === metadataSequence.current) {
        setMetadataError("Storage profiles and File inventory could not be read. Retry only refreshes metadata; it does not start a migration.");
        checkAccessError(error);
      }
      throw error;
    } finally {
      if (owner.isCurrent() && !signal.aborted && currentRead === metadataSequence.current) setMetadataLoading(false);
    }
  }
  async function refresh(signal: AbortSignal) {
    if (!owner.isCurrent() || !canManage.current || signal.aborted) return;
    const currentRefresh = ++refreshSequence.current;
    setJobsLoading(true); setJobsError("");
    try {
      const [list, current] = await Promise.all([fileJobsClient.list(signal), fileJobsClient.executor(signal)]);
      if (!owner.isCurrent() || signal.aborted || !canManage.current || currentRefresh !== refreshSequence.current) return;
      setJobs(list); setExecutor(current); setJobsRead(true);
    } catch (error) {
      if (owner.isCurrent() && !signal.aborted && canManage.current && currentRefresh === refreshSequence.current) {
        setJobsError("Saved migrations and executor status could not be refreshed. Retry only reads their current status.");
        checkAccessError(error);
      }
      return;
    } finally {
      if (owner.isCurrent() && !signal.aborted && currentRefresh === refreshSequence.current) setJobsLoading(false);
    }
    const detail = detailJob.current;
    if (detail) {
      try {
        const value = await fileJobsClient.items(detail, signal);
        if (owner.isCurrent() && !signal.aborted && canManage.current && detailJob.current === detail && currentRefresh === refreshSequence.current) setDetails(value);
      } catch (error) {
        if (owner.isCurrent() && !signal.aborted && canManage.current && detailJob.current === detail && currentRefresh === refreshSequence.current) {
          setJobsError("Saved migration details could not be refreshed. Retry only reads their current status.");
          checkAccessError(error);
        }
        throw error;
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    const poll = async () => {
      try { await refresh(controller.signal); } catch (error) { if (owner.isCurrent() && !controller.signal.aborted) checkAccessError(error); }
      if (owner.isCurrent() && !controller.signal.aborted && canManage.current) timer = setTimeout(() => void poll(), 5000);
    };
    const readInitial = async () => {
      if (!owner.isCurrent() || reading || busyRef.current || controller.signal.aborted) return;
      reading = true; setAccessLoading(true); setAccessError("");
      if (timer) clearTimeout(timer);
      try {
        const capability = await storageConfigurationClient.capability(controller.signal);
        if (!owner.isCurrent() || controller.signal.aborted) return;
        setAuthorized(capability.canManage);
        canManage.current = capability.canManage;
        setAccessLoading(false);
        if (!capability.canManage) return;
      } catch (error) {
        if (owner.isCurrent() && !controller.signal.aborted && !checkAccessError(error)) setAccessError("Administrator access could not be checked. Retry only checks access and reads migration metadata.");
        if (owner.isCurrent() && !controller.signal.aborted) setAccessLoading(false);
        reading = false; return;
      }
      try {
        if (pendingRef.current && !initialIntentRead.current) {
          initialIntentRead.current = true;
          const current = ++sequence.current; busyRef.current = true; setBusy(true);
          try { await checkPending(controller.signal, current); }
          catch (error) { if (currentOperation(controller.signal, current)) reportError(error); }
          finally { if (owner.isCurrent() && !controller.signal.aborted && current === sequence.current) { busyRef.current = false; setBusy(false); } }
        }
        if (owner.isCurrent() && canManage.current && !controller.signal.aborted) { await readMetadata(controller.signal); await poll(); }
      }
      catch (error) { if (owner.isCurrent() && !controller.signal.aborted) checkAccessError(error); }
      finally { reading = false; }
    };
    retryInitialRead.current = () => void readInitial();
    void readInitial();
    return () => { controller.abort(); if (timer) clearTimeout(timer); sequence.current++; metadataSequence.current++; };
  }, []);
  useLayoutEffect(() => {
    if (busy || !returnPreviewFocus.current) return;
    const { button, signal } = returnPreviewFocus.current;
    returnPreviewFocus.current = null;
    if (signal !== lifetime.current?.signal || signal.aborted || !canManage.current) return;
    if (button === previewButton.current && button.isConnected && !button.matches(":disabled")
      && (document.activeElement === document.body || document.activeElement === button)) button.focus();
  }, [busy]);
  async function act(operation: (signal: AbortSignal) => Promise<unknown>, preserveMessage = false) {
    if (!owner.isCurrent() || !canManage.current || busyRef.current || !lifetime.current || lifetime.current.signal.aborted) return;
    const signal = lifetime.current.signal, current = ++sequence.current; clearStartFocus(); busyRef.current = true; setBusy(true);
    if (!preserveMessage) { setMessage(""); setMessageIsError(false); }
    try { await operation(signal); if (owner.isCurrent() && !signal.aborted) await refresh(signal); }
    catch (error) {
      if (owner.isCurrent() && !signal.aborted && current === sequence.current) {
        if (preserveMessage) checkAccessError(error);
        else reportError(error);
      }
    }
    finally { if (owner.isCurrent() && !signal.aborted && current === sequence.current) { busyRef.current = false; setBusy(false); } }
  }
  function changeSelection(ids: string[]) { setSelection(ids); setPlan(null); }
  function input(): AcceptFileMigrationInput { return checkedAcceptFileMigration({ requestId: crypto.randomUUID(), fileIds: selection,
    target: { profileId: target, configurationRevision: profiles.find(profile => profile.id === target)?.configurationRevision } }); }
  async function accept(signal: AbortSignal, retry = false) {
    const current = sequence.current, saved = pendingRef.current;
    const acceptedInput = saved ?? input();
    if (saved) {
      const receipt = await checkPending(signal, current);
      if (receipt || !retry || !currentOperation(signal, current) || !pendingRef.current) return receipt;
    } else remember(acceptedInput);
    // A legacy or unknown ACK stays uncertain even when a later retry rejects.
    const mayRecordRejection = !saved || !!rejectedRef.current && sameInput(rejectedRef.current, acceptedInput);
    rememberRejection(null);
    try {
      const value = await fileJobsClient.accept(acceptedInput, signal);
      if (currentOperation(signal, current)) return acceptReceipt(acceptedInput, value);
    } catch (error) {
      if (!currentOperation(signal, current)) return;
      if (error instanceof FileMigrationRequestError && error.status === 409) {
        if (mayRecordRejection) rememberRejection(acceptedInput);
        return checkPending(signal, current);
      }
      throw error;
    }
  }
  async function reviewNewPlan(signal: AbortSignal) {
    const current = sequence.current, original = pendingRef.current;
    if (!original || !rejectedRef.current || !sameInput(original, rejectedRef.current)) return;
    await readMetadata(signal);
    if (!currentOperation(signal, current)) return;
    const receipt = await checkPending(signal, current);
    if (receipt || !currentOperation(signal, current) || !pendingRef.current || !sameInput(pendingRef.current, original)) return receipt;
    retainEarlier(original, null); rememberRejection(null); remember(null);
    setPlan(null); setSelection([]); setTarget("");
    if (currentOperation(signal, current)) { setMessageIsError(false); setMessage("Review the refreshed files and destination before creating a new migration plan. The earlier request identifier is retained below for later status checks."); }
  }
  async function checkEarlier(row: EarlierRequest, signal: AbortSignal) {
    const current = sequence.current;
    try {
      const receipt = await fileJobsClient.readRequest(row.input, signal);
      if (!currentOperation(signal, current)) return;
      retainEarlier(row.input, receipt.job.id);
      setMessageIsError(false); setMessage(`Earlier request ${row.input.requestId} has saved migration ${receipt.job.id}. Its original work is retained.`);
    } catch (error) {
      if (!currentOperation(signal, current)) return;
      if (!(error instanceof FileMigrationRequestMissingError)) throw error;
      setMessageIsError(false); setMessage("No saved receipt is recorded for that earlier request at this check. Its original identifier remains retained.");
    }
  }
  return <div className="page storage-settings-page">
    <div className="page-heading"><div><p className="eyebrow">Settings</p><h1>File migrations</h1>
      <p className="lead">Copy selected files, verify their contents, then switch their recorded location.</p></div>
      {authorized && <button className="button" type="button" disabled={busy} onClick={() => void act(async signal => {
        await readMetadata(signal); if (owner.isCurrent() && !signal.aborted) setPlan(null);
      }, true)}>Refresh</button>}</div>
    <p><a href="/settings/storage">Storage settings</a></p>
    {authorized !== false && (authorized === null || accessLoading || accessError) && <ReadStatus loading={accessLoading} error={accessError} loadingMessage="Reading administrator access…"
      errorTitle="Administrator access is unavailable" retryLabel="Retry administrator access" onRetry={() => retryInitialRead.current()} />}
    {authorized === false && <p role="status">System administrator access is required to manage File migrations.</p>}
    {message && authorized === true && <p className={messageIsError ? "error-banner" : undefined} role={messageIsError ? "alert" : "status"}>{message}</p>}
    {authorized && <>
      <section className="card storage-settings-section" aria-labelledby="file-migration-executor-title"><h2 className="card-title" id="file-migration-executor-title">Independent executor</h2>
        {!jobsRead && !jobsError && <p role="status">Waiting for saved executor status…</p>}
        {jobsError && <p className="muted">Executor status is unavailable. Refresh saved jobs to read its current status.</p>}
        {executor && <><p>{executor.enabled ? executor.stale ? "Enabled, but no recent heartbeat" : "Enabled" : "Paused"}.
          {executor.lastHeartbeatAt && <> Last heartbeat: <time>{executor.lastHeartbeatAt}</time>.</>}</p>
          {executor.enabled && executor.stale && <p className="muted">The independent runner has not reported recently. Check the configured runner; refreshing this page does not execute a job.</p>}
          <button type="button" className="button" disabled={busy} onClick={() => void act(signal => fileJobsClient.setExecutor(!executor.enabled, signal))}>{executor.enabled ? "Pause executor" : "Enable executor"}</button></>}
        <p className="muted">Accepted work is saved on the server. Closing your browser does not cancel it. Recovered jobs remain paused until explicitly resumed.</p>
      </section>
      <section className="card storage-settings-section" aria-labelledby="file-migration-plan-title"><h2 className="card-title" id="file-migration-plan-title">Plan a migration</h2>
        <p className="muted">Select up to 100 files, each no larger than 100 MiB. Source copies remain retained until a separate cleanup request.</p>
        <ReadStatus loading={metadataLoading} error={metadataError} loadingMessage="Reading storage profiles and File inventory…"
          errorTitle="Migration metadata is unavailable" retryLabel="Retry migration metadata" onRetry={() => retryInitialRead.current()} />
        {metadataRead && metadataError && <p className="muted">Previously read profiles and Files remain listed below.</p>}
        <label>Destination <select ref={destination} aria-label="Migration destination" value={target} disabled={busy || !!pending || metadataLoading || !metadataRead} onChange={event => { setTarget(event.target.value); setPlan(null); }}>
          <option value="">Choose a writable profile</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.adapterType}: {profile.id}</option>)}</select></label>
        {metadataRead && !metadataLoading && !metadataError && !profiles.length && <p className="muted">No writable destination is available. Activate and bind a storage profile in Storage settings.</p>}
        <ul className="storage-profile-list">{inventory.items.map(file => <li key={file.fileId}><label className="storage-candidate-checkbox">
          <input type="checkbox" checked={selection.includes(file.fileId)} disabled={busy || !!pending || selection.length >= 100 && !selection.includes(file.fileId)}
            onChange={event => changeSelection(event.target.checked ? [...selection, file.fileId] : selection.filter(id => id !== file.fileId))} />
          <span><code>{file.fileId}</code> · {file.purpose} · {size(file.byteSize)}<br /><small>Current profile: {file.profileId}</small></span></label></li>)}</ul>
        {metadataRead && !metadataLoading && !metadataError && !inventory.items.length && <p className="muted">No published Files are available for migration.</p>}
        {inventory.nextCursor && <button type="button" className="button" disabled={busy || !!pending} onClick={() => void act(async signal => {
          const next = await fileJobsClient.inventory(inventory.nextCursor!, signal); if (owner.isCurrent() && !signal.aborted) setInventory(current => ({ items: [...current.items, ...next.items], nextCursor: next.nextCursor }));
        })}>Load more files</button>}
        <div className="storage-candidate-actions"><button ref={previewButton} type="button" className="button" disabled={busy || !!pending || !target || !selection.length}
          onClick={() => void act(async signal => {
            const button = previewButton.current;
            returnPreviewFocus.current = button && document.activeElement === button ? { button, signal } : null;
            const value = await fileJobsClient.plan(input(), signal); if (owner.isCurrent() && !signal.aborted) setPlan(value);
          })}>Preview migration</button>
          {(plan || pending) && <button ref={startButton} type="button" className="button primary" disabled={busy || !pending && plan!.items.some(item => item.status !== "eligible")}
            onClick={event => { const origin = event.currentTarget; void act(async signal => {
              const intent = beginStartFocus(origin, signal), receipt = await accept(signal);
              if (intent && returnStartFocus.current === intent && receipt) intent.receipt = receipt;
            }); }}>{pending ? "Check original migration request" : "Start migration"}</button>}
          {pending && receiptMissing && <button ref={retryButton} type="button" className="button" disabled={busy} onClick={event => {
            const origin = event.currentTarget; void act(async signal => {
              const intent = beginStartFocus(origin, signal), receipt = await accept(signal, true);
              if (intent && returnStartFocus.current === intent && receipt) intent.receipt = receipt;
            });
          }}>Retry original migration request</button>}
          {pending && receiptMissing && rejected && sameInput(rejected, pending) && <button ref={replanButton} type="button" className="button" disabled={busy}
            onClick={event => { const origin = event.currentTarget; void act(async signal => {
              const intent = beginStartFocus(origin, signal), receipt = await reviewNewPlan(signal);
              if (intent && returnStartFocus.current === intent && receipt) intent.receipt = receipt;
            }); }}>Review a new migration plan</button>}</div>
        {pending && <p className="muted">An acceptance result is awaiting confirmation for {pending.fileIds.length} files to <code>{pending.target.profileId}</code>.
          Retry keeps the original files, destination and request identity.</p>}
        {plan && <><p>{plan.items.length} files · {size(plan.bytes)} total · up to {size(plan.stagingBytes)} staging.</p>
          <p className="muted">One pass transfers and verifies {size(plan.transferAndVerificationBytes)}.
            Up to {plan.maxAttemptsPerFile} attempts per file may use {size(plan.maxTransferAndVerificationBytes)} in total.</p>
          <p className="muted">This preview reads metadata. The executor verifies every byte before switching a File.</p>
          {plan.items.filter(item => item.status !== "eligible").map(item => <p key={item.fileId}>{item.fileId}: {item.status === "same_profile" ? "Already on the destination profile" : "Exceeds the per-file limit"}</p>)}</>}
      </section>
      {earlier?.length ? <section className="card storage-settings-section"><h2 className="card-title">Earlier migration requests</h2>
        <p className="muted">These original request identifiers remain available after acceptance or explicit replanning. Checking them only reads saved receipts.</p>
        <ul className="storage-profile-list">{earlier.map(row => <li key={row.input.requestId}><code>{row.input.requestId}</code>
          {row.jobId && <p>Saved migration: <code>{row.jobId}</code>.</p>}
          <button type="button" className="button" aria-label={`Check earlier request ${row.input.requestId}`} disabled={busy} onClick={() => void act(signal => checkEarlier(row, signal))}>Check saved receipt</button></li>)}</ul>
      </section> : null}
      <section className="card storage-settings-section" aria-labelledby="file-migration-jobs-title"><h2 className="card-title" id="file-migration-jobs-title">Saved jobs</h2>
        <ReadStatus loading={jobsLoading && !jobsRead} error={jobsError} loadingMessage="Reading saved migrations and executor status…"
          errorTitle="Saved migrations are unavailable" retryLabel="Retry saved migrations" onRetry={() => void act(async () => {}, true)} />
        {jobsRead && jobsError && <p className="muted">Previously read jobs remain listed below; their status has not been refreshed.</p>}
        {!jobsRead && !jobsLoading && !jobsError && <p className="muted">Saved migrations have not been read yet.</p>}
        {jobsRead && !jobsLoading && !jobsError && !jobs.length && <p className="muted">No migrations have been accepted.</p>}
        <ul className="storage-profile-list">{jobs.map(job => <li key={job.id}><h3><code>{job.id}</code></h3>
          <SavedJobControls job={job} onPauseTarget={(presented, button) => {
            if (button) pauseTargets.current.set(presented.id, { job: presented, button }); else pauseTargets.current.delete(presented.id);
          }} onStatusTarget={(presented, element) => {
            if (element) statusTargets.current.set(presented.id, { job: presented, element }); else statusTargets.current.delete(presented.id);
          }} busy={busy} allowed={authorized === true && canManage.current} currentSignal={lifetime.current?.signal ?? null}
            onControl={(action, onStarting, onReceipt) => void act(async signal => {
              onStarting(signal); const receipt = await fileJobsClient.control(job.id, action, signal);
              if (owner.isCurrent() && !signal.aborted && canManage.current) onReceipt(receipt);
            })} />
          <button type="button" className="button" disabled={busy} onClick={() => void act(async signal => {
            detailJob.current = job.id; setDetailId(job.id); setDetails(null);
            const value = await fileJobsClient.items(job.id, signal); if (owner.isCurrent() && !signal.aborted && detailJob.current === job.id) setDetails(value);
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
