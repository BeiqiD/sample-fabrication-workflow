import { useEffect, useRef, useState } from "react";
import {
  FileAuthorityAccessError, fileAuthorityClient,
  type ActivateFileAuthorityInput, type EnableRecoveredFileAuthorityInput, type FileAuthorityStatus,
} from "../lib/file-authority-client";
import "./file-shadow-pilot.css";

function activationBlockers(status: FileAuthorityStatus) {
  const blockers: string[] = [];
  if (status.mode === "legacy") blockers.push("Enable and complete file conversion first.");
  if (status.shadow_enabled) blockers.push("Pause file conversions before activation.");
  if (status.resolved_count !== status.current_count) blockers.push(`${status.resolved_count} of ${status.current_count} current references are resolved.`);
  const counts = [
    [status.unfinished_attempts, "Unfinished conversion attempts"],
    [status.pending_receipts, "Pending uploads and imports"],
    [status.unfinished_failed_imports, "Failed imports awaiting recovery"],
    [status.unattached_ready_uploads, "Ready uploads awaiting a resolved reference or expiry"],
    [status.unpublished_candidates, "Unpublished file candidates"],
    [status.legacy_deleting, "Legacy deletions in progress"],
    [status.file_deleting, "File deletions in progress"],
  ] as const;
  for (const [count, label] of counts) if (count > 0) blockers.push(`${label}: ${count}.`);
  return blockers;
}

type Attempt = { kind: "activate"; input: ActivateFileAuthorityInput } | { kind: "recover"; input: EnableRecoveredFileAuthorityInput };

export function FileAuthorityPage() {
  const [status, setStatus] = useState<FileAuthorityStatus | null>(null);
  const [access, setAccess] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true), [running, setRunning] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [previousStopped, setPreviousStopped] = useState(false);
  const generation = useRef(0), commandLock = useRef(false);
  const attempt = useRef<Attempt | null>(null);

  async function refresh() {
    if (commandLock.current) return;
    const current = ++generation.current;
    setLoading(true); setStatus(null); setError(""); setNotice(""); setPreviousStopped(false);
    try {
      const capability = await fileAuthorityClient.capabilities();
      const value = capability.canAdjudicate ? await fileAuthorityClient.status() : null;
      if (current === generation.current) { setAccess(capability.canAdjudicate); setStatus(value); }
    } catch (failure) {
      if (current === generation.current) {
        setAccess(failure instanceof FileAuthorityAccessError ? false : null);
        if (!(failure instanceof FileAuthorityAccessError)) setError("File authority status is unavailable. Refresh to try again.");
      }
    } finally { if (current === generation.current) setLoading(false); }
  }
  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, []);

  async function run(kind: Attempt["kind"]) {
    if (!status || !access || commandLock.current || loading) return;
    if (kind === "activate" && (status.mode !== "overlap" || activationBlockers(status).length)) return;
    if (kind === "recover" && (status.mode !== "active" || status.enabled || !previousStopped)) return;
    // A deliberate retry of an unchanged cutoff keeps its original request ID.
    const previous = attempt.current;
    const selected: Attempt = kind === "activate" ? {
      kind, input: previous?.kind === kind && previous.input.expectedEpoch === status.epoch
        && previous.input.expectedShadowIncarnation === status.shadow_incarnation ? previous.input
        : { requestId: crypto.randomUUID(), expectedEpoch: status.epoch, expectedShadowIncarnation: status.shadow_incarnation },
    } : {
      kind, input: previous?.kind === kind && previous.input.expectedIncarnation === status.incarnation ? previous.input
        : { requestId: crypto.randomUUID(), expectedIncarnation: status.incarnation, previousInstallationStopped: true },
    };
    attempt.current = selected;
    commandLock.current = true;
    const current = ++generation.current;
    setRunning(true); setError(""); setNotice(""); setPreviousStopped(false);
    try {
      const value = selected.kind === "activate" ? await fileAuthorityClient.activate(selected.input)
        : await fileAuthorityClient.enableRecovered(selected.input);
      if (current === generation.current) {
        setStatus(value);
        setNotice(value.mode === "active" && value.enabled === 1
          ? selected.kind === "activate" ? "File authority is active." : "File execution is enabled on this installation."
          : "Current status updated.");
      }
    } catch {
      // An uncertain response is reconciled by a read, never an automatic POST.
      try {
        const value = await fileAuthorityClient.status();
        if (current === generation.current) {
          setStatus(value);
          if (value.mode === "active" && value.enabled === 1) {
            setNotice(value.incarnation === selected.input.requestId
              ? "Command confirmed by current status. File execution is enabled."
              : "File authority is active and execution is enabled. Current status refreshed.");
          } else setError("The command was not confirmed. Review the current status before retrying.");
        }
      } catch (failure) {
        if (current === generation.current) {
          setStatus(null);
          if (failure instanceof FileAuthorityAccessError) setAccess(false);
          else setError("The command outcome is unknown. Refresh status before continuing.");
        }
      }
    } finally {
      commandLock.current = false;
      if (current === generation.current) setRunning(false);
    }
  }

  const blockers = status && status.mode !== "active" ? activationBlockers(status) : [];
  return <div className="page file-shadow-pilot-page">
    <a className="back-link" href="/settings/storage">← Storage settings</a>
    <div className="page-heading"><div><p className="eyebrow">Maintenance</p><h1>File authority</h1>
      <p className="lead">Activate the File system after conversion, or enable execution on a recovered installation.</p></div></div>
    <section className="card shadow-panel" aria-labelledby="authority-status-title">
      <div className="shadow-heading"><h2 className="card-title" id="authority-status-title">Current status</h2>
        <button type="button" className="button" disabled={loading || running} onClick={() => void refresh()}>Refresh status</button></div>
      {loading && <p role="status">Reading current status…</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!loading && access === false && <p>File operator access is required. This account cannot perform File authority maintenance.</p>}
      {status && <>
        <dl className="shadow-summary">
          <div><dt>Authority</dt><dd>{status.mode}</dd></div>
          <div><dt>File execution</dt><dd>{status.mode !== "active" ? "Not active" : status.enabled ? "Enabled" : "Paused"}</dd></div>
          <div><dt>Resolved references</dt><dd>{status.resolved_count} / {status.current_count}</dd></div>
        </dl>
        {status.mode !== "active" && <>
          <p>Activation switches file reads, writes and lifecycle management together.</p>
          {blockers.length ? <><h3>Before activation</h3><ul>{blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>
            <p><a href="/maintenance/file-shadow">Open file conversion maintenance</a></p></>
            : <p>All current references are resolved and no unfinished work is reported. The server checks this state again during activation.</p>}
          <button type="button" className="button primary" disabled={running || blockers.length > 0 || status.mode !== "overlap"}
            onClick={() => void run("activate")}>{running ? "Activating…" : "Activate File authority"}</button>
        </>}
        {status.mode === "active" && !status.enabled && <>
          <p>File execution is paused on this installation. Stop the previous installation before enabling writes and maintenance here.</p>
          <label className="shadow-check"><input type="checkbox" checked={previousStopped} disabled={running}
            onChange={event => setPreviousStopped(event.target.checked)} />
            <span>The previous installation has stopped executing writes and maintenance.</span></label>
          <button type="button" className="button primary" disabled={running || !previousStopped}
            onClick={() => void run("recover")}>{running ? "Enabling…" : "Enable execution on this installation"}</button>
        </>}
      </>}
    </section>
  </div>;
}
