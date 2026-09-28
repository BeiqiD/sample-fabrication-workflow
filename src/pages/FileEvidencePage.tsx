import { useEffect, useRef, useState } from "react";
import type { FileShadowEvidenceReview, FileShadowReviewKey } from "../../shared/contracts/file-shadow-evidence-review";
import { createFileShadowEvidenceClient, type EvidenceConsumerPage } from "../lib/file-shadow-evidence-client";
import "./file-evidence.css";

const identity = (key: FileShadowReviewKey) => JSON.stringify(key);
const readable = (value: string) => value.replaceAll("_", " ");
function reasonText(reason: string) {
  if (reason === "consumer_purpose_unresolved") return "Purpose is unresolved: the recorded evidence does not establish the intended use of this reference.";
  if (reason === "namespace_evidence_missing") return "Original storage is unresolved: there is no recorded association with the account and bucket used for the original upload.";
  if (reason === "namespace_conflict") return "Original storage records conflict. The recorded profile cannot establish the original location until the conflict is resolved.";
  if (reason === "namespace_evidence_invalid" || reason === "namespace_revision_mismatch") return "The recorded storage profile is incomplete or inconsistent with the original acceptance record.";
  return readable(reason);
}
const message = (error: unknown) => error instanceof Error ? error.message : "Evidence could not be read. Retry this read.";
function KeyDetails({ value }: { value: FileShadowReviewKey }) {
  return <><dt>Reference type</dt><dd><code>{JSON.stringify(value.consumerKind)}</code></dd>
    <dt>Reference ID</dt><dd><code>{JSON.stringify(value.consumerId)}</code></dd>
    <dt>Sub-ID</dt><dd><code>{JSON.stringify(value.consumerSubId)}</code></dd>
    <dt>File slot</dt><dd><code>{JSON.stringify(value.fileSlot)}</code></dd></>;
}

export function FileEvidencePage() {
  const [client] = useState(() => createFileShadowEvidenceClient());
  const [page, setPage] = useState<EvidenceConsumerPage | null>(null);
  const [cursor, setCursor] = useState<FileShadowReviewKey | null>(null);
  const [selected, setSelected] = useState<FileShadowReviewKey | null>(null);
  const [evidence, setEvidence] = useState<FileShadowEvidenceReview | null>(null);
  const [listLoading, setListLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState(""), [detailError, setDetailError] = useState("");
  const mounted = useRef(false), listRequest = useRef(0), detailRequest = useRef(0);

  async function refreshList(after: FileShadowReviewKey | null) {
    const request = ++listRequest.current;
    detailRequest.current += 1;
    setPage(null); setCursor(after); setListError(""); setListLoading(true);
    setSelected(null); setEvidence(null); setDetailError(""); setDetailLoading(false);
    try {
      const result = await client.listConsumers(after);
      if (mounted.current && request === listRequest.current) setPage(result);
    } catch (error) {
      if (mounted.current && request === listRequest.current) setListError(message(error));
    } finally {
      if (mounted.current && request === listRequest.current) setListLoading(false);
    }
  }
  async function inspect(key: FileShadowReviewKey) {
    const request = ++detailRequest.current;
    setSelected(key); setEvidence(null); setDetailError(""); setDetailLoading(true);
    try {
      const result = await client.getEvidence(key);
      if (mounted.current && request === detailRequest.current) setEvidence(result);
    } catch (error) {
      if (mounted.current && request === detailRequest.current) setDetailError(message(error));
    } finally {
      if (mounted.current && request === detailRequest.current) setDetailLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true; void refreshList(null);
    return () => { mounted.current = false; listRequest.current += 1; detailRequest.current += 1; };
    // This independent read client is fixed for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const records = page?.records.filter(({ key }) => key.consumerKind === "project_content_attachment" && key.fileSlot === "primary") ?? [];
  return <div className="page file-evidence-page">
    <nav className="evidence-links" aria-label="File maintenance"><a className="back-link" href="/export">← Export</a><a href="/maintenance/file-shadow">File shadow pilot</a></nav>
    <div className="page-heading"><div><p className="eyebrow">Maintenance · Read only</p><h1>Historical file evidence</h1>
      <p className="lead">Review the recorded identity of a Project attachment and identify the information needed to resolve its history.</p></div></div>
    <p className="muted evidence-intro">This review reads database metadata. It does not verify stored bytes or record a classification. Each selected reference is read afresh.</p>

    <div className="evidence-workspace">
      <section className="card evidence-panel" aria-labelledby="evidence-list-title">
        <div className="evidence-heading"><h2 id="evidence-list-title" className="card-title">Project attachments</h2>
          <button className="button" disabled={listLoading} onClick={() => void refreshList(cursor)}>Refresh list</button></div>
        <p className="muted">Project attachments from this page of up to 20 current references. Titles and filenames help identify a reference; inspect it for a fresh evidence snapshot.</p>
        {listLoading && <p role="status">Reading references…</p>}
        {listError && <p className="error-banner" role="alert">{listError}</p>}
        {page && records.length === 0 && <p className="muted">{page.nextCursor ? "No Project attachments on this page. Continue to the next page." : "No current Project attachments on this page."}</p>}
        {records.length > 0 && <ul className="evidence-consumers">{records.map((record) => <li key={identity(record.key)} className={selected && identity(record.key) === identity(selected) ? "is-selected" : undefined}>
          <div><strong>{record.identification?.attachmentName || "Attachment name unavailable"}</strong>
            <span>{record.identification?.projectTitle || "Project title unavailable"}</span>
            <code>{JSON.stringify(record.key.consumerId)}</code>
            <small>Generation {record.generation} · {readable(record.state)}</small></div>
          <button className="button" aria-label={`Inspect evidence ${JSON.stringify(record.key.consumerId)} ${JSON.stringify(record.key.consumerSubId)}`}
            aria-pressed={selected !== null && identity(record.key) === identity(selected)} onClick={() => void inspect(record.key)}>Inspect</button>
        </li>)}</ul>}
        <div className="evidence-actions"><button className="button" disabled={listLoading || cursor === null} onClick={() => void refreshList(null)}>First page</button>
          <button className="button" disabled={listLoading || !page?.nextCursor} onClick={() => page?.nextCursor && void refreshList(page.nextCursor)}>Next page</button></div>
      </section>

      <section className="card evidence-panel" aria-labelledby="evidence-detail-title" aria-busy={detailLoading}>
        <div className="evidence-heading"><h2 id="evidence-detail-title" className="card-title">Selected evidence</h2>
          <button className="button" disabled={!selected || detailLoading} onClick={() => selected && void inspect(selected)}>Reread evidence</button></div>
        {!selected && <p className="muted">Choose an attachment to review its recorded evidence.</p>}
        {selected && !evidence && <p className="evidence-key"><code>{JSON.stringify(selected.consumerId)}</code></p>}
        {detailLoading && <p role="status">Reading a fresh evidence snapshot…</p>}
        {detailError && <p className="error-banner" role="alert">{detailError}</p>}
        {evidence && <>
          {evidence.identification && <div className="evidence-identification"><h3>{evidence.identification.attachmentName || "Attachment name unavailable"}</h3>
            <p>{evidence.identification.projectTitle || "Project title unavailable"}</p></div>}
          {evidence.status === "absent" && <p className="warning-card">This reference is no longer current. Refresh the list before choosing another attachment.</p>}
          {evidence.reasons.length > 0 && <div className="evidence-reasons"><h3>Evidence gaps and blockers</h3><ul>{evidence.reasons.map((reason) => <li key={reason}>{reasonText(reason)}</li>)}</ul>
            <details><summary>Technical reason codes</summary><ul>{evidence.reasons.map((reason) => <li key={reason}><code>{reason}</code></li>)}</ul></details></div>}
          <dl className="evidence-proof"><dt>Snapshot status</dt><dd>{readable(evidence.status)}</dd>
            <dt>Recorded purpose</dt><dd>{evidence.purpose ? readable(evidence.purpose) : "Missing — intended use needs evidence"}</dd>
            <dt>Recorded storage profile</dt><dd>{evidence.sourceProfile ? <><code>{evidence.sourceProfile.profileId}</code> · revision {evidence.sourceProfile.configurationRevision}</> : "Missing — original storage needs evidence"}</dd>
            <dt>Source provider</dt><dd>{evidence.sourceProvider === "r2" ? "R2" : evidence.sourceProvider === "other" ? "Other provider" : "Not recorded"}</dd>
            <dt>Recorded expected bytes</dt><dd>{evidence.expectedBytes === null ? "Not available" : evidence.expectedBytes.toLocaleString()}</dd>
            <dt>Recorded expected SHA-256</dt><dd><code>{evidence.expectedSha256 ?? "Not available"}</code></dd></dl>
          <p className="muted">Size and SHA-256 are recorded expectations. This read has not downloaded or verified the source bytes. Recorded profile metadata remains subject to the listed blockers.</p>
          <details className="evidence-exact"><summary>Exact reference and snapshot</summary><dl className="evidence-proof"><KeyDetails value={evidence.key} />
            {evidence.identification && <><dt>Project ID</dt><dd><code>{JSON.stringify(evidence.identification.projectId)}</code></dd></>}
            <dt>Generation</dt><dd>{evidence.head?.generation ?? "No current generation"}</dd>
            <dt>Occurrence</dt><dd><code>{evidence.head?.occurrenceId ?? "Not available"}</code></dd>
            <dt>Source metadata SHA-256</dt><dd><code>{evidence.head?.sourceMetadataSha256 ?? "Not available"}</code></dd>
            <dt>Baseline SHA-256</dt><dd><code>{evidence.baselineSha256}</code></dd></dl></details>
          <div className="evidence-peers"><h3>Other references sharing this storage locator</h3>
            <p className="muted">Each reference needs its own review. Sharing storage or identical bytes does not establish shared purpose.</p>
            {evidence.peerReferences.length === 0 ? <p className="muted">No other references were recorded in this snapshot.</p> : <ul>{evidence.peerReferences.map((peer) => {
              const listed = records.find((record) => identity(record.key) === identity(peer.key));
              return <li key={identity(peer.key)}>{listed?.identification && <div className="evidence-peer-label"><strong>{listed.identification.attachmentName || "Attachment name unavailable"}</strong>
                <span>{listed.identification.projectTitle || "Project title unavailable"}</span>
                <button className="button" onClick={() => void inspect(peer.key)}>Inspect this related reference</button></div>}
                <dl className="evidence-proof"><KeyDetails value={peer.key} /><dt>Recorded purpose</dt><dd>{peer.purpose ? readable(peer.purpose) : "Unresolved"}</dd></dl></li>;
            })}</ul>}
          </div>
        </>}
      </section>
    </div>

    <section className="card evidence-panel evidence-guidance" aria-labelledby="evidence-guidance-title"><h2 id="evidence-guidance-title" className="card-title">Information to gather</h2>
      <div><h3>Intended use of this reference</h3><p>Locate the original upload or acceptance record, or a contemporaneous note explaining how this attachment was intended to be used. A new decision about its purpose must be recorded separately from historical evidence.</p></div>
      <div><h3>Original storage location</h3><p>Locate deployment configuration, a deployment log, or an operational record identifying the account and bucket used when this file was uploaded. Include the date and the record that ties that storage location to this reference.</p></div>
      <p className="muted">A filename, image type, matching hash, Project placement or currently configured profile cannot establish historical purpose or the original bucket. Keep the exact reference and generation with any supporting records. Missing evidence remains unresolved.</p>
    </section>
  </div>;
}
