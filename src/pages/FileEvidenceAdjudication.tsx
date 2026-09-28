import { useEffect, useRef, useState } from "react";
import type { FileShadowReviewKey } from "../../shared/contracts/file-shadow-evidence-review";
import {
  adjudicationJournalIdentity, canDismissAdjudication, createFileShadowAdjudicationClient,
  FILE_SHADOW_ADJUDICATION_JOURNAL_KEY, FILE_SHADOW_REVOCATION_JOURNAL_KEY, type AdjudicationJournal, type AdjudicationPreparation,
} from "../lib/file-shadow-adjudication-client";

const errorText = (error: unknown) => error instanceof Error ? error.message : "The evidence action could not be confirmed. Keep the saved request and inspect it again.";
const readable = (value: string) => value.replaceAll("_", " ");

/** This panel never reads or modifies the separate conversion journal. */
export function FileEvidenceAdjudication({ selected }: { selected: FileShadowReviewKey | null }) {
  const [client] = useState(createFileShadowAdjudicationClient);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [revocations, setRevocations] = useState<AdjudicationJournal[]>([]);
  const [journal, setJournal] = useState<AdjudicationJournal | null>(null);
  const [prepared, setPrepared] = useState<AdjudicationPreparation | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [purposeStatement, setPurposeStatement] = useState(""), [namespaceStatement, setNamespaceStatement] = useState("");
  const [evidenceReference, setEvidenceReference] = useState(""), [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false), [revokeConfirmed, setRevokeConfirmed] = useState(false);
  const alive = useRef(false), readSequence = useRef(0);
  const selectedIdentity = selected ? JSON.stringify(selected) : null;

  function resetForm() { setProfileId(""); setPurposeStatement(""); setNamespaceStatement(""); setEvidenceReference(""); setReason(""); setConfirmed(false); setRevokeConfirmed(false); }
  function reloadJournal() {
    try { setJournal(client.loadJournal()); setRevocations(client.loadRevocations()); }
    catch (failure) { setError(errorText(failure)); }
  }
  async function prepare() {
    const sequence = ++readSequence.current;
    setPrepared(null); resetForm(); setNotice("");
    if (!selected || !allowed) return;
    setReading(true); setError("");
    try {
      const next = await client.prepare(selected);
      if (alive.current && readSequence.current === sequence) setPrepared(next);
    } catch (failure) { if (alive.current && readSequence.current === sequence) setError(errorText(failure)); }
    finally { if (alive.current && readSequence.current === sequence) setReading(false); }
  }
  useEffect(() => {
    alive.current = true;
    let current = true;
    void client.capabilities().then((capability) => {
      if (!current) return;
      setAllowed(capability.canAdjudicate);
      if (capability.canAdjudicate) reloadJournal();
    }).catch(() => { if (current) setAllowed(false); });
    return () => { current = false; alive.current = false; readSequence.current += 1; };
    // Fixed client lifetime; loading the operator journal requires a capability grant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  useEffect(() => {
    void prepare();
    return () => { readSequence.current += 1; };
    // An explicit attachment selection or capability result starts a fresh read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdentity, allowed]);
  useEffect(() => {
    if (!allowed) return;
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== FILE_SHADOW_ADJUDICATION_JOURNAL_KEY && event.key !== FILE_SHADOW_REVOCATION_JOURNAL_KEY) return;
      readSequence.current += 1; setPrepared(null); resetForm(); reloadJournal();
      setNotice("The saved evidence request changed in another tab. Review its current state before continuing.");
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, client]);
  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setNotice(""); readSequence.current += 1; setReading(false);
    try { await action(); if (alive.current) setNotice(success); }
    catch (failure) { if (alive.current) setError(errorText(failure)); }
    finally {
      if (alive.current) { reloadJournal(); setPrepared(null); resetForm(); setBusy(false); }
    }
  }
  const identity = journal ? adjudicationJournalIdentity(journal) : "";
  const formReady = !!profileId && !!purposeStatement.trim() && !!namespaceStatement.trim() && !!evidenceReference.trim() && confirmed;
  return <section className="card evidence-panel evidence-adjudication" aria-labelledby="evidence-adjudication-title" aria-busy={busy || reading}>
    <div className="evidence-heading"><h2 className="card-title" id="evidence-adjudication-title">Operator evidence decision</h2>
      {allowed && <button className="button" disabled={busy || reading || !selected} onClick={() => void prepare()}>Read decision prerequisites</button>}</div>
    {allowed === null && <p role="status">Checking operator access…</p>}
    {allowed === false && <p className="muted">Operator access is unavailable. You can review the evidence above, but recording a decision requires operator access.</p>}
    {allowed && <>
      <p className="muted">Record a present-day research-source classification and its separate original-storage basis. This decision applies only to the selected reference. File conversion remains a separate action.</p>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button className="button" disabled={busy} onClick={() => { setError(""); reloadJournal(); }}>Reload saved request</button>
      {revocations.map((entry) => <div className="evidence-saved-request" key={entry.request.requestId}>
        <h3>{entry.receipt?.status === "revoked" ? "Confirmed revocation" : "Saved revocation awaiting confirmation"}</h3>
        <p>Reference <code>{JSON.stringify(entry.request.key.consumerId)}</code> · generation {entry.request.generation}</p>
        <p>{entry.revocationRequest!.reason}</p>
        <p className="muted">Keep this exact request until its outcome is confirmed. An active or completed file conversion may prevent revocation. Other reference decisions can continue while this request remains saved.</p>
        <details><summary>Revocation identity</summary><dl className="evidence-proof"><dt>Decision ID</dt><dd><code>{entry.request.requestId}</code></dd><dt>Revocation request ID</dt><dd><code>{entry.revocationRequest!.requestId}</code></dd></dl></details>
        <div className="evidence-actions">
          <button className="button" disabled={busy} onClick={() => void act(() => client.inspectRevocation(adjudicationJournalIdentity(entry)), "The saved revocation outcome has been inspected.")}>Inspect revocation receipt</button>
          {entry.receipt?.status !== "revoked" && <button className="button" disabled={busy} onClick={() => void act(() => client.retryRevocation(adjudicationJournalIdentity(entry)), "The saved revocation has been confirmed.")}>Retry saved revocation</button>}
          <button className="button" disabled={busy || entry.receipt?.status !== "revoked"} onClick={() => void act(() => client.dismissRevocation(adjudicationJournalIdentity(entry)), "The confirmed revocation receipt was dismissed.")}>Dismiss confirmed revocation</button>
        </div>
      </div>)}
      {journal && <div className="evidence-saved-request">
        <h3>Saved evidence request</h3>
        <p><strong>{journal.revocationRequest && journal.receipt?.status === "accepted" ? "Revocation awaiting confirmation" : journal.receipt ? readable(journal.receipt.status) : "Awaiting confirmation"}</strong></p>
        <p>Reference <code>{JSON.stringify(journal.request.key.consumerId)}</code> · generation {journal.request.generation}</p>
        <p className="muted">The original request is retained in this browser. A missing receipt does not prove it was never accepted. Inspect it or withdraw the unconfirmed request before dismissing it.</p>
        <details><summary>Saved statements and request identity</summary><dl className="evidence-proof">
          <dt>Request ID</dt><dd><code>{journal.request.requestId}</code></dd>
          <dt>Purpose statement</dt><dd>{journal.request.purposeStatement}</dd>
          <dt>Original storage statement</dt><dd>{journal.request.namespaceStatement}</dd>
          <dt>Supporting record</dt><dd>{journal.request.evidenceReference}</dd>
          <dt>Chosen profile</dt><dd><code>{journal.request.sourceProfile.profileId}</code> · revision {journal.request.sourceProfile.configurationRevision}</dd>
          {journal.revocationRequest && <><dt>Revocation reason</dt><dd>{journal.revocationRequest.reason}</dd></>}
        </dl></details>
        <div className="evidence-actions">
          <button className="button" disabled={busy} onClick={() => void act(() => client.inspect(identity), "The saved request receipt has been read.")}>Inspect saved receipt</button>
          {!journal.receipt && <button className="button" disabled={busy} onClick={() => void act(() => client.withdraw(identity), "The request outcome is confirmed. Review whether it was withdrawn or already accepted.")}>Withdraw unconfirmed request</button>}
          {journal.revocationRequest && journal.receipt?.status === "accepted" && <button className="button" disabled={busy} onClick={() => void act(() => client.retryRevocation(identity), "The saved revocation has been confirmed.")}>Retry saved revocation</button>}
          <button className="button" disabled={busy || !canDismissAdjudication(journal)} onClick={() => void act(() => client.dismiss(identity), "The confirmed receipt was dismissed. Read fresh prerequisites before another decision.")}>Dismiss confirmed receipt</button>
        </div>
      </div>}
      {reading && <p role="status">Reading current decision prerequisites…</p>}
      {!selected && <p className="muted">Inspect an attachment above to read its decision prerequisites.</p>}
      {selected && !reading && !prepared && <p className="muted">Read fresh decision prerequisites before recording or revoking evidence.</p>}
      {prepared && JSON.stringify(prepared.key) === selectedIdentity && <>
        {prepared.blockers.length > 0 && <div className="evidence-reasons"><h3>Decision is blocked</h3><ul>{prepared.blockers.map((blocker) => <li key={blocker}>{readable(blocker)}</li>)}</ul></div>}
        {prepared.activeAdjudication && <div className="evidence-active-decision"><h3>Accepted decision</h3>
          <dl className="evidence-proof"><dt>Purpose statement</dt><dd>{prepared.activeAdjudication.request.purposeStatement}</dd>
            <dt>Original storage statement</dt><dd>{prepared.activeAdjudication.request.namespaceStatement}</dd>
            <dt>Supporting record</dt><dd>{prepared.activeAdjudication.request.evidenceReference}</dd></dl>
          <p className="muted">To correct a mistake, explicitly revoke this decision, then reread the attachment and enter replacement statements. Existing file conversions may need their own recovery before revocation is allowed.</p>
          {prepared.revocationBlockers.length > 0 && <p className="muted">Revocation is currently unavailable: {prepared.revocationBlockers.map(readable).join("; ")}.</p>}
          <label>Reason for revocation<textarea maxLength={4000} value={reason} disabled={busy || !!journal || !prepared.revocable} onChange={(event) => setReason(event.target.value)} /></label>
          <label className="evidence-check"><input type="checkbox" checked={revokeConfirmed} disabled={busy || !!journal || !prepared.revocable} onChange={(event) => setRevokeConfirmed(event.target.checked)} />I intend to revoke this exact accepted decision.</label>
          <button className="button" disabled={busy || !!journal || !prepared.revocable || !reason.trim() || !revokeConfirmed || revocations.some((entry) => entry.request.requestId === prepared.activeAdjudication?.requestId)} onClick={() => void act(() => client.revoke(prepared, reason), "The decision was revoked. Dismiss its receipt and read fresh prerequisites before entering a correction.")}>Revoke decision</button>
        </div>}
        {prepared.eligible && <form onSubmit={(event) => { event.preventDefault(); if (formReady && !busy && !journal) void act(() => client.submit(prepared, { profileId, purposeStatement, namespaceStatement, evidenceReference }), "The operator decision was recorded. Reread evidence before any separate conversion."); }}>
          <h3>{prepared.preconditions?.supersedesId ? "Replacement decision" : "New decision"}</h3>
          {prepared.preconditions?.supersedesId && <p className="muted">This decision will explicitly replace revoked decision <code>{prepared.preconditions.supersedesId}</code>. Supply a new basis for every statement.</p>}
          <fieldset disabled={busy || !!journal}>
            <label>Original storage profile<select required value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              <option value="">Choose a reviewed profile</option>{prepared.profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.profileId} · revision {profile.configurationRevision}</option>)}
            </select></label>
            <p className="muted">A profile being available today does not establish where the original file was stored.</p>
            <label>Why retain this reference as a research source?<textarea required maxLength={4000} value={purposeStatement} onChange={(event) => setPurposeStatement(event.target.value)} /></label>
            <label>What establishes the original storage location?<textarea required maxLength={4000} value={namespaceStatement} onChange={(event) => setNamespaceStatement(event.target.value)} /></label>
            <label>Supporting record or source reference<textarea required maxLength={4000} value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} /></label>
            <p className="muted">Use an actual deployment record, operational record or historical binding statement. Do not include credentials. Leave this item unresolved if the basis is unknown.</p>
            <label className="evidence-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed this reference and supplied the purpose and original-storage basis separately.</label>
            <button className="button primary" type="submit" disabled={!formReady}>Record evidence decision</button>
          </fieldset>
        </form>}
      </>}
    </>}
  </section>;
}
