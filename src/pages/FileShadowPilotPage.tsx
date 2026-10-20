import { useEffect, useRef, useState } from "react";
import {
  canCancelReceipt, canConvertBaseline, canEnableProfile, createFileShadowPilotClient, isTerminalReceipt,
  type PilotBaseline, type PilotConsumerPage, type PilotJournal, type PilotStatus, type ShadowConsumerKey,
} from "../lib/file-shadow-pilot-client";
import "./file-shadow-pilot.css";

function readable(value: string) { return value.replaceAll("_", " "); }
function exactKeyText(value: string) { return JSON.stringify(value); }
function keyId(key: ShadowConsumerKey) { return JSON.stringify(key); }
function message(error: unknown) { return error instanceof Error ? error.message : "The state could not be read. Refresh before continuing."; }

export function FileShadowPilotPage() {
  const [client] = useState(() => createFileShadowPilotClient());
  const [status, setStatus] = useState<PilotStatus | null>(null);
  const [page, setPage] = useState<PilotConsumerPage | null>(null);
  const [cursor, setCursor] = useState<ShadowConsumerKey | null>(null);
  const [selected, setSelected] = useState<ShadowConsumerKey | null>(null);
  const [baseline, setBaseline] = useState<PilotBaseline | null>(null);
  const [journal, setJournal] = useState<PilotJournal | null>(null);
  const [journalError, setJournalError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [listError, setListError] = useState("");
  const [baselineError, setBaselineError] = useState("");
  const [commandError, setCommandError] = useState("");
  const [notice, setNotice] = useState("");
  const [statusLoading, setStatusLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [overlapReviewed, setOverlapReviewed] = useState(false);
  const [proofReviewed, setProofReviewed] = useState(false);
  const mounted = useRef(false);
  const statusRequest = useRef(0), listRequest = useRef(0), baselineRequest = useRef(0);
  const commandLock = useRef(false);
  const pauseLock = useRef(false);

  function readJournal() {
    try { setJournal(client.loadJournal()); setJournalError(""); }
    catch (error) { setJournalError(message(error)); }
  }

  function invalidateBaseline() {
    baselineRequest.current += 1;
    setBaseline(null); setBaselineLoading(false); setProofReviewed(false); setBaselineError("");
  }

  async function refreshStatus() {
    if (commandLock.current || pauseLock.current) return;
    const request = ++statusRequest.current;
    invalidateBaseline(); readJournal(); setOverlapReviewed(false);
    setStatus(null); setStatusLoading(true); setStatusError("");
    try {
      const result = await client.getStatus();
      if (mounted.current && request === statusRequest.current) setStatus(result);
    } catch (error) {
      if (mounted.current && request === statusRequest.current) setStatusError(message(error));
    } finally {
      if (mounted.current && request === statusRequest.current) setStatusLoading(false);
    }
  }

  async function refreshList(after: ShadowConsumerKey | null) {
    if (commandLock.current || pauseLock.current) return;
    const request = ++listRequest.current;
    invalidateBaseline(); setSelected(null); setPage(null); setCursor(after);
    setListLoading(true); setListError("");
    try {
      const result = await client.listConsumers(after);
      if (mounted.current && request === listRequest.current) setPage(result);
    } catch (error) {
      if (mounted.current && request === listRequest.current) setListError(message(error));
    } finally {
      if (mounted.current && request === listRequest.current) setListLoading(false);
    }
  }

  async function inspect(key: ShadowConsumerKey) {
    if (commandLock.current || pauseLock.current) return;
    const request = ++baselineRequest.current;
    setSelected(key); setBaseline(null); setProofReviewed(false); setBaselineError(""); setBaselineLoading(true);
    try {
      const result = await client.getBaseline(key);
      if (mounted.current && request === baselineRequest.current) setBaseline(result);
    } catch (error) {
      if (mounted.current && request === baselineRequest.current) setBaselineError(message(error));
    } finally {
      if (mounted.current && request === baselineRequest.current) setBaselineLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refreshStatus(); void refreshList(null);
    // Recover another tab's durable receipt without replaying any operation.
    const syncStorage = () => { readJournal(); invalidateBaseline(); };
    window.addEventListener("storage", syncStorage);
    return () => {
      mounted.current = false;
      statusRequest.current += 1; listRequest.current += 1; baselineRequest.current += 1;
      window.removeEventListener("storage", syncStorage);
    };
    // The client is fixed for the lifetime of this page. Refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function run(label: string, action: () => Promise<unknown>, success: string, changesStatus = true) {
    if (commandLock.current || pauseLock.current) return;
    commandLock.current = true; setCommand(label); setCommandError(""); setNotice("");
    invalidateBaseline(); setOverlapReviewed(false);
    const request = ++statusRequest.current;
    setStatusLoading(false);
    try {
      await action();
      if (!mounted.current) return;
      setNotice(success);
      if (changesStatus && request === statusRequest.current) {
        try {
          const refreshed = await client.getStatus();
          if (mounted.current && request === statusRequest.current) { setStatus(refreshed); setStatusError(""); }
        }
        catch (error) { if (mounted.current && request === statusRequest.current) setStatusError(message(error)); }
      }
    } catch (error) {
      if (mounted.current) {
        setCommandError(message(error));
        if (changesStatus && request === statusRequest.current) setStatus(null);
      }
    } finally {
      commandLock.current = false;
      if (mounted.current) { readJournal(); setCommand(null); }
    }
  }

  // Pause must remain available while a storage copy awaits its response. Read
  // a fresh fence independently; pausing never clears the durable operation.
  async function pause() {
    if (pauseLock.current) return;
    pauseLock.current = true; setPausing(true); setCommandError("");
    invalidateBaseline(); setOverlapReviewed(false);
    const request = ++statusRequest.current;
    setStatusLoading(false);
    try {
      const current = await client.getStatus();
      const result = current.enabled ? await client.pause(current) : current;
      if (mounted.current && request === statusRequest.current) {
        setStatus(result); setStatusError("");
        setNotice("Conversions paused. Overlap and admitted profiles remain; in-flight writes may still finish. Inspect the saved operation.");
      }
    } catch (error) {
      if (mounted.current && request === statusRequest.current) { setStatus(null); setCommandError(message(error)); }
    } finally {
      pauseLock.current = false;
      if (mounted.current) setPausing(false);
    }
  }

  const locked = command !== null || pausing;
  const canConvert = !!baseline && canConvertBaseline(baseline) && !journal && !journalError && !statusLoading;
  const authorityActive = status?.mode === "active";
  const activeRuntime = status?.mode === "overlap" && status.enabled;
  const receipt = journal?.receipt ?? null;
  const terminal = isTerminalReceipt(receipt);

  return <div className="page file-shadow-pilot-page">
    <a className="back-link" href="/export">← Export</a>
    <p className="muted"><a href="/maintenance/file-evidence">Review historical file evidence</a> · Identify missing purpose and original storage records.</p>
    <div className="page-heading">
      <div><p className="eyebrow">Maintenance</p><h1>File shadow pilot</h1>
        <p className="lead">{authorityActive ? "File authority is active. Shadow conversion is complete." : "Inspect current file references and convert one reviewed reference at a time. Existing file access continues during overlap."}</p></div>
    </div>
    {commandError && <p className="error-banner" role="alert">{commandError}</p>}
    {journalError && <p className="error-banner" role="alert">{journalError} Conversion is blocked until the saved operation can be read.</p>}
    <p className="shadow-feedback" role="status" aria-live="polite">{pausing ? "Pausing conversions…" : command ? `${command}…` : notice}</p>

    <section className="card shadow-panel" aria-labelledby="shadow-runtime-title">
      <div className="shadow-heading"><h2 id="shadow-runtime-title" className="card-title">Runtime</h2>
        <button className="button" disabled={locked || statusLoading} onClick={() => void refreshStatus()}>Refresh status</button></div>
      {statusLoading && <p className="muted" role="status">Reading current status…</p>}
      {statusError && <p className="error-banner" role="alert">{statusError}</p>}
      {status && <>
        <dl className="shadow-summary">
          <div><dt>Authority</dt><dd>{readable(status.mode)}</dd></div>
          <div><dt>Conversions</dt><dd>{authorityActive ? "Complete" : status.enabled ? "Enabled" : "Paused"}</dd></div>
          <div><dt>Current references</dt><dd>{status.currentCount}</dd></div>
          <div><dt>Resolved</dt><dd>{status.resolvedCount}</dd></div>
          <div><dt>Pending</dt><dd>{status.pendingCount}</dd></div>
          <div><dt>Admitted unresolved</dt><dd>{status.unresolvedCount}</dd></div>
          <div><dt>Unfinished attempts</dt><dd>{status.unfinishedAttempts}</dd></div>
        </dl>
        {authorityActive ? <p className="muted">Manage active File authority and recovery from <a href="/maintenance/file-authority">File authority</a>.</p> : <>
        <p className="muted">Enabling conversions permanently enters overlap. Pausing stops new work but retains overlap and admitted profiles; in-flight storage writes may still finish. This page cannot activate File authority.</p>
        {!status.enabled && <label className="shadow-check"><input type="checkbox" checked={overlapReviewed} disabled={locked} onChange={(event) => setOverlapReviewed(event.target.checked)} />
          <span>I understand that overlap remains enabled after pausing.</span></label>}
        <div className="shadow-actions">
          {!status.enabled && <button className="button" disabled={locked || !overlapReviewed} onClick={() => void run("Enabling conversions", () => client.enable(status), "Conversions enabled. Inspect a reference before admitting its exact R2 profile.")}>{status.mode === "legacy" ? "Enable overlap" : "Resume conversions"}</button>}
          <button className="button" disabled={pausing || !status.enabled} onClick={() => void pause()}>Pause conversions</button>
        </div>
        </>}
      </>}
    </section>

    {journal && <section className="card shadow-panel shadow-saved" aria-labelledby="shadow-operation-title">
      <h2 id="shadow-operation-title" className="card-title">Saved operation</h2>
      <p className="muted">The request was saved in this browser before conversion. Keep this operation until its outcome is confirmed.</p>
      <dl className="shadow-proof">
        <dt>Operation</dt><dd><code>{journal.request.operationId}</code></dd>
        <dt>Reference type</dt><dd><code>{exactKeyText(journal.request.key.consumerKind)}</code></dd>
        <dt>Reference ID</dt><dd><code>{exactKeyText(journal.request.key.consumerId)}</code></dd>
        <dt>Sub-ID</dt><dd><code>{exactKeyText(journal.request.key.consumerSubId)}</code></dd>
        <dt>File slot</dt><dd><code>{exactKeyText(journal.request.key.fileSlot)}</code></dd>
        <dt>Generation</dt><dd>{journal.proof.generation}</dd>
        <dt>Purpose</dt><dd>{readable(journal.proof.purpose)}</dd>
        <dt>Expected bytes</dt><dd>{journal.proof.expectedBytes.toLocaleString()}</dd>
        <dt>Expected SHA-256</dt><dd><code>{journal.proof.expectedSha256}</code></dd>
        <dt>R2 profile</dt><dd><code>{journal.request.destinationProfile.profileId}</code> · revision {journal.request.destinationProfile.configurationRevision}</dd>
        <dt>Outcome</dt><dd>{receipt?.status === "withdrawn" ? "Closed before acceptance" : receipt ? readable(receipt.status) : "Unknown — inspect saved operation"}</dd>
        {receipt?.attemptState && <><dt>Copy attempt</dt><dd>{readable(receipt.attemptState)}</dd></>}
      </dl>
      <p className={terminal ? "muted" : "warning-card"}>
        {authorityActive ? "Inspect the saved operation to read its recorded outcome. Completed receipts can be dismissed."
          : receipt?.status === "resolved" ? "This operation resolved its recorded generation. Dismiss the receipt and reread the reference to check its current generation."
          : receipt?.status === "withdrawn" ? "The server durably closed this unaccepted request. It cannot start a conversion later. Dismiss the receipt before reviewing another conversion."
            : terminal ? "This operation has a recorded terminal outcome. Dismiss the receipt before reviewing another conversion."
            : receipt?.nextAction === "reconcile" ? "Inspect this operation, then reconcile its recorded copy. Reconciliation verifies the existing copy without starting another storage write."
              : "The outcome is still pending or unknown. Inspect this same operation; do not start another conversion."}
      </p>
      {!authorityActive && !receipt && <p className="muted">You can ask the server to close this request if it was never accepted, including while paused. If it was already accepted, its existing operation will be shown instead. A missing receipt alone does not confirm either outcome.</p>}
      <div className="shadow-actions">
        <button className="button" disabled={locked} onClick={() => void run("Reading saved operation", () => client.inspectOperation(journal.request.operationId), "Saved operation read. Review its outcome below.", false)}>Inspect saved operation</button>
        {!authorityActive && !receipt && <button className="button" disabled={locked} onClick={() => void run("Closing unaccepted request", () => client.withdrawOperation(journal.request.operationId), "Request checked. Review the saved outcome before continuing.")}>Close unaccepted request</button>}
        {!authorityActive && receipt?.nextAction === "reconcile" && <button className="button" disabled={locked || !activeRuntime} onClick={() => status && void run("Reconciling recorded copy", () => client.reconcileOperation(status, journal.request.operationId), "Reconciliation finished. Review the saved outcome before continuing.")}>Reconcile recorded copy</button>}
        {!authorityActive && canCancelReceipt(receipt) && <button className="button" disabled={locked || !activeRuntime} onClick={() => status && void run("Cancelling unstarted operation", () => client.cancelOperation(status, journal.request.operationId), "Cancellation checked. Review the saved outcome before continuing.")}>Cancel unstarted operation</button>}
        {terminal && <button className="button" disabled={locked} onClick={() => void run("Dismissing completed operation", () => client.clearTerminalReceipt(journal.request.operationId), "Completed receipt dismissed. Reread the reference before another conversion.", false)}>Dismiss completed operation</button>}
      </div>
      {!authorityActive && !activeRuntime && receipt?.status === "pending" && <p className="muted">Inspection is available while paused. Resume conversions before reconciliation or cancelling an unstarted operation.</p>}
    </section>}

    {!authorityActive && <div className="shadow-workspace">
      <section className="card shadow-panel" aria-labelledby="shadow-consumers-title">
        <div className="shadow-heading"><h2 id="shadow-consumers-title" className="card-title">Current references</h2>
          <button className="button" disabled={locked || listLoading} onClick={() => void refreshList(cursor)}>Refresh list</button></div>
        <p className="muted">Up to 20 references per page. Inspect one to read its current generation and conversion evidence.</p>
        {listError && <p className="error-banner" role="alert">{listError}</p>}
        {listLoading && <p className="muted" role="status">Reading references…</p>}
        {page && <ul className="shadow-consumers">{page.records.map((consumer) => <li key={keyId(consumer.key)} className={selected && keyId(selected) === keyId(consumer.key) ? "is-selected" : undefined}>
          <div><strong>{exactKeyText(consumer.key.consumerKind)}</strong><code>{exactKeyText(consumer.key.consumerId)}</code>
            <small>Sub-ID: <code>{exactKeyText(consumer.key.consumerSubId)}</code> · Slot: <code>{exactKeyText(consumer.key.fileSlot)}</code></small>
            <small>Generation {consumer.generation} · {readable(consumer.state)}</small></div>
          <button className="button" disabled={locked} aria-label={`Inspect ${consumer.key.consumerKind} ${consumer.key.consumerId} ${consumer.key.consumerSubId || "(no sub-ID)"} ${consumer.key.fileSlot || "(no slot)"}`} onClick={() => void inspect(consumer.key)}>Inspect</button>
        </li>)}</ul>}
        {page?.records.length === 0 && <p className="muted">No current references on this page.</p>}
        <div className="shadow-actions shadow-pagination">
          <button className="button" disabled={locked || listLoading || cursor === null} onClick={() => void refreshList(null)}>First page</button>
          <button className="button" disabled={locked || listLoading || !page?.nextCursor} onClick={() => page?.nextCursor && void refreshList(page.nextCursor)}>Next page</button>
        </div>
      </section>

      <section className="card shadow-panel" aria-labelledby="shadow-selected-title">
        <div className="shadow-heading"><h2 id="shadow-selected-title" className="card-title">Selected reference</h2>
          <button className="button" disabled={locked || !selected || baselineLoading || statusLoading} onClick={() => selected && void inspect(selected)}>Reread baseline</button></div>
        {!selected && <p className="muted">Choose a reference to inspect its proof.</p>}
        {selected && <p className="shadow-selected-key"><code>{exactKeyText(selected.consumerKind)}</code><br /><code>{exactKeyText(selected.consumerId)}</code></p>}
        {selected && !baseline && !baselineLoading && !baselineError && <p className="muted">Reread the baseline after a refresh or command before continuing.</p>}
        {baselineLoading && <p className="muted" role="status">Reading current generation…</p>}
        {baselineError && <p className="error-banner" role="alert">{baselineError}</p>}
        {baseline && <>
          <dl className="shadow-proof">
            <dt>Sub-ID</dt><dd><code>{exactKeyText(baseline.key.consumerSubId)}</code></dd>
            <dt>File slot</dt><dd><code>{exactKeyText(baseline.key.fileSlot)}</code></dd>
            <dt>Metadata status</dt><dd>{readable(baseline.status)}</dd>
            <dt>Generation</dt><dd>{baseline.head?.generation ?? "Absent"}</dd>
            <dt>Occurrence</dt><dd><code>{baseline.head?.occurrenceId ?? "Absent"}</code></dd>
            <dt>Purpose</dt><dd>{baseline.purpose ? readable(baseline.purpose) : "Not established"}</dd>
            <dt>Expected bytes</dt><dd>{baseline.expectedBytes === null ? "Not established" : baseline.expectedBytes.toLocaleString()}</dd>
            <dt>Expected SHA-256</dt><dd><code>{baseline.expectedSha256 ?? "Not established"}</code></dd>
            <dt>Source provider</dt><dd>{baseline.provider === "r2" ? "R2" : "Not supported by this pilot"}</dd>
            <dt>Source and destination profile</dt><dd>{baseline.sourceProfile ? <><code>{baseline.sourceProfile.profileId}</code> · revision {baseline.sourceProfile.configurationRevision}<br />{readable(baseline.sourceProfile.runtimeState)}</> : "Not established"}</dd>
            <dt>Baseline SHA-256</dt><dd><code>{baseline.baselineSha256}</code></dd>
          </dl>
          <p className="muted">The destination is an independent copy in the exact recorded R2 profile and revision shown above. Metadata inspection does not verify stored bytes.</p>
          {baseline.reasons.length > 0 && <div className="warning-card"><strong>Evidence still required</strong><ul>{baseline.reasons.map((reason) => <li key={reason}>{readable(reason)}</li>)}</ul></div>}
          {!baseline.runtime.enabled && <p className="muted">Enable or resume conversions, then reread this baseline.</p>}
          {canEnableProfile(baseline) && <div className="shadow-profile-admission">
            <p className="muted">Admit only this recorded R2 profile for shadow copies. Admission remains after pausing and does not change the configured storage binding.</p>
            <button className="button" disabled={locked || statusLoading || !!journal || !!journalError} onClick={() => void run("Admitting exact R2 profile", () => client.enableProfile(baseline), "Exact R2 profile admitted. Reread the baseline to review the new state.")}>Admit exact R2 profile</button>
          </div>}
          {journal ? <p className="muted">Complete and dismiss the saved operation before starting another conversion.</p> : <>
            {canConvert && <label className="shadow-check"><input type="checkbox" checked={proofReviewed} disabled={locked} onChange={(event) => setProofReviewed(event.target.checked)} />
              <span>I have reviewed this reference, its purpose, byte size, SHA-256 and the exact R2 profile.</span></label>}
            <button className="button primary" disabled={locked || !canConvert || !proofReviewed} onClick={() => proofReviewed && void run("Converting reviewed reference", () => client.convert(baseline), "Conversion response received. Review the saved operation before continuing.")}>Convert this reference</button>
          </>}
        </>}
      </section>
    </div>}
  </div>;
}
