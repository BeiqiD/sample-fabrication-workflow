import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { SAMPLE_STATUSES, SAMPLE_STATUS_LABELS, type SampleDetail, type SampleEvent, type SampleRun, type SampleStatus } from "../../shared/types";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { FileDropzone } from "../components/FileDropzone";
import { SplitSampleDialog } from "../components/SplitSampleDialog";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { exportSample } from "../lib/exportSample";
import { compressCommentImage } from "../lib/images";
import { SAMPLE_HISTORY_PREVIEW_COUNT, visibleSampleHistory } from "../lib/sampleHistory";

function runProgress(run: SampleRun) {
  const currentSteps = run.steps.filter((step) => step.planStatus === "current");
  const completed = currentSteps.filter((step) => step.status === "done" || step.status === "skipped").length;
  return { completed, total: currentSteps.length };
}

function runStatusLabel(status: SampleRun["status"]) {
  if (status === "complete") return "Completed";
  if (status === "cancelled") return "Cancelled";
  if (status === "superseded") return "Superseded";
  return "Active";
}

export function SamplePage() {
  const { sampleId = "" } = useParams();
  const [sample, setSample] = useState<SampleDetail | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [updatingDetails, setUpdatingDetails] = useState(false);
  const [commentImage, setCommentImage] = useState<File | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<SampleEvent | null>(null);
  const [recordDeleteError, setRecordDeleteError] = useState("");
  const [deletingRecord, setDeletingRecord] = useState(false);
  const [assetToDelete, setAssetToDelete] = useState<SampleEvent | null>(null);
  const [assetDeleteError, setAssetDeleteError] = useState("");
  const [deletingAsset, setDeletingAsset] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const pendingUploadRef = useRef<{ signature: string; assetKey?: string; thumbnailKey?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setSample(await api.getSample(sampleId));
      setError("");
    } catch (error) { setError((error as Error).message); }
  }, [sampleId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setHistoryExpanded(false); }, [sampleId]);

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sample) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = String(data.get("body") || "").trim();
    const image = commentImage;
    if (!body && !image) return;
    setSaving(true); setError("");
    try {
      let assetKey: string | undefined;
      let thumbnailKey: string | undefined;
      if (image) {
        const signature = `${image.name}:${image.size}:${image.lastModified}`;
        if (pendingUploadRef.current?.signature !== signature) pendingUploadRef.current = { signature };
        const pending = pendingUploadRef.current;
        if (!pending.assetKey || !pending.thumbnailKey) {
          const compressed = await compressCommentImage(image);
          if (!pending.assetKey) pending.assetKey = (await api.uploadAsset(compressed.main, compressed.main.name)).key;
          if (!pending.thumbnailKey) pending.thumbnailKey = (await api.uploadAsset(compressed.thumbnail, compressed.thumbnail.name)).key;
        }
        assetKey = pending.assetKey;
        thumbnailKey = pending.thumbnailKey;
      }
      await api.createRecord(sampleId, {
        status: sample.status,
        location: sample.location || "",
        pinned: sample.pinned,
        expectedUpdatedAt: sample.updatedAt,
        body,
        assetKey,
        thumbnailKey,
      });
      pendingUploadRef.current = null;
      setCommentImage(null);
      form.reset();
      await load();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function deleteRecord() {
    if (!sample || !recordToDelete) return;
    setDeletingRecord(true); setRecordDeleteError("");
    try {
      await api.deleteSampleRecord(sample.id, recordToDelete.id);
      setRecordToDelete(null);
      await load();
    } catch (error) { setRecordDeleteError((error as Error).message); }
    finally { setDeletingRecord(false); }
  }

  async function deleteAsset() {
    if (!sample || !assetToDelete) return;
    setDeletingAsset(true); setAssetDeleteError("");
    try {
      await api.deleteEventAsset(sample.id, assetToDelete.id);
      setAssetToDelete(null);
      await load();
    } catch (error) { setAssetDeleteError((error as Error).message); }
    finally { setDeletingAsset(false); }
  }

  async function updateDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sample) return;
    const form = new FormData(event.currentTarget);
    setUpdatingDetails(true); setError("");
    try {
      await api.updateSample(sampleId, {
        title: String(form.get("title")),
        status: String(form.get("status")) as SampleStatus,
        location: String(form.get("location")),
        pinned: form.get("pinned") === "on",
        expectedUpdatedAt: sample.updatedAt,
      });
      setEditingDetails(false);
      await load();
    } catch (error) { setError((error as Error).message); }
    finally { setUpdatingDetails(false); }
  }

  if (!sample) return <div className="page"><p>{error || "Loading sample…"}</p></div>;
  const activeRun = sample.runs.find((run) => run.status === "active") ?? null;
  const visibleEvents = visibleSampleHistory(sample.events, historyExpanded);
  const hiddenEventCount = sample.events.length - visibleEvents.length;

  return <div className="page sample-overview-page">
    <Link className="back-link" to="/samples">← Samples</Link>
    <div className="sample-header">
      <div className="sample-header-copy"><p className="eyebrow">{sample.code}</p><h1>{sample.title}</h1><p className="lead">{sample.description || "No description"}</p></div>
      <div className="header-actions"><StatusPill status={sample.status} /><Link className="button primary" to={`/processing/${sample.id}${activeRun ? `?run=${encodeURIComponent(activeRun.id)}` : ""}`}>Open processing</Link><a className="button" href="#sample-record">Add record</a><button className="button" onClick={() => setSplitting(true)}>Split sample</button><button className="button" disabled={exporting} onClick={() => {
        setExporting(true);
        void exportSample(sample).catch((error: Error) => setError(error.message)).finally(() => setExporting(false));
      }}>{exporting ? "Exporting…" : "Export ZIP"}</button></div>
    </div>

    {error && <p className="error-banner">{error}</p>}
    <div className="sample-overview-grid">
      <aside className="card facts sample-details-card">
        <div className="card-title-row"><h2>Sample details</h2><button className="text-button" onClick={() => setEditingDetails((value) => !value)}>{editingDetails ? "Cancel" : "Edit"}</button></div>
        {editingDetails ? <form className="detail-form" onSubmit={updateDetails}>
          <label>Sample code<input value={sample.code} readOnly aria-readonly="true" title="Sample code is a permanent identifier" /></label>
          <label>Short title<input name="title" defaultValue={sample.title} required maxLength={200} /></label>
          <label>Status<select name="status" defaultValue={sample.status}>{SAMPLE_STATUSES.map((status) => <option value={status} key={status}>{SAMPLE_STATUS_LABELS[status]}</option>)}</select></label>
          <label>Location<input name="location" defaultValue={sample.location || ""} placeholder="Box, lab, or tool" /></label>
          <label className="checkbox-label"><input name="pinned" type="checkbox" defaultChecked={sample.pinned} />Pinned</label>
          <button className="button primary wide" disabled={updatingDetails}>{updatingDetails ? "Saving…" : "Save changes"}</button>
        </form> : <dl><dt>Sample code</dt><dd>{sample.code}</dd><dt>Short title</dt><dd>{sample.title}</dd><dt>Status</dt><dd>{sample.status}</dd><dt>Location</dt><dd>{sample.location || "—"}</dd><dt>Pinned</dt><dd>{sample.pinned ? "Yes" : "No"}</dd><dt>Parent</dt><dd>{sample.parent ? <Link to={`/samples/${sample.parent.id}`}>{sample.parent.code}</Link> : "—"}</dd><dt>Children</dt><dd>{sample.children.length ? sample.children.map((child) => <Link key={child.id} to={`/samples/${child.id}`}>{child.code}</Link>) : "—"}</dd><dt>Created</dt><dd>{new Date(sample.createdAt).toLocaleString()}</dd></dl>}
      </aside>

      <section className="sample-runs-section">
        <div className="section-heading"><div><p className="eyebrow">Processing history</p><h2>Runs</h2></div><span>{sample.runs.length}</span></div>
        {sample.runs.length ? <div className="sample-run-list">{sample.runs.map((run) => {
          const progress = runProgress(run);
          return <article className="card sample-run-summary" key={run.id}>
            <div><span className={`run-status run-status-${run.status}`}>{runStatusLabel(run.status)}</span><p className="sample-run-name"><strong>{run.templateName}</strong> · v{run.templateVersion}</p><small>{run.templateType} · run {run.sequenceNo} · plan r{run.planRevisionNumber}</small></div>
            <div className="sample-run-progress"><strong>{progress.completed} / {progress.total}</strong><span>steps complete</span></div>
            <time>{new Date(run.completedAt || run.createdAt).toLocaleString()}</time>
            <Link className="button" to={`/processing/${sample.id}?run=${encodeURIComponent(run.id)}`}>{run.status === "active" ? "Continue" : "View run"}</Link>
          </article>;
        })}</div> : <div className="card empty-run-message"><h2>No processing runs</h2><p>Open Processing to assign the first workflow.</p></div>}
      </section>
    </div>

    <section className="sample-record-section" id="sample-record">
      <div className="section-heading sample-record-heading"><div><p className="eyebrow">Permanent sample history</p><h2>Timeline</h2></div></div>
      <form className="card composer" onSubmit={addComment}>
        <label>Add a sample record<textarea name="body" rows={3} placeholder="Overall observation about this sample, independent of any workflow step…" /></label>
        <FileDropzone compact accept="image/*" capture="environment" file={commentImage} onFile={(file) => { pendingUploadRef.current = null; setCommentImage(file); }} label="Drop a sample-level photo" />
        <div className="composer-actions"><span className="muted">This belongs to the sample archive, not a processing step.</span><button className="button primary" disabled={saving}>{saving ? "Saving…" : "Add record"}</button></div>
      </form>
      {sample.events.length > SAMPLE_HISTORY_PREVIEW_COUNT && <div className="timeline-toolbar">
        <span>{historyExpanded ? `All ${sample.events.length} entries` : `Latest ${visibleEvents.length} of ${sample.events.length} entries`}</span>
        <button type="button" className="text-button" aria-expanded={historyExpanded} aria-controls="sample-history" onClick={() => setHistoryExpanded((value) => !value)}>{historyExpanded ? `Show latest ${SAMPLE_HISTORY_PREVIEW_COUNT}` : `Show ${hiddenEventCount} older`}</button>
      </div>}
      <div className="timeline" id="sample-history">
        {visibleEvents.map((event) => <article className={`event${event.metadata.deletedAt ? " deleted-event" : ""}`} key={event.id}>
          <div className="event-dot" />
          <div className="event-content"><div className="event-meta"><span>{event.kind}{event.metadata.deletedAt ? " · deleted" : ""}{event.actorEmail ? ` · ${event.actorEmail}` : ""}</span><div><time>{new Date(event.createdAt).toLocaleString()}</time>{event.assetKey && <button type="button" onClick={() => { setAssetDeleteError(""); setAssetToDelete(event); }}>Delete image</button>}{isSampleRecordEvent(event.kind, event.metadata) && <button type="button" onClick={() => { setRecordDeleteError(""); setRecordToDelete(event); }}>Delete record</button>}</div></div>{event.body && <p>{event.body}</p>}{event.assetKey && <div className="event-asset"><a href={`/api/assets/${event.assetKey}`} target="_blank" rel="noreferrer"><img src={`/api/assets/${typeof event.metadata.thumbnailKey === "string" ? event.metadata.thumbnailKey : event.assetKey}`} alt={event.body || "Sample record"} loading="lazy" /></a></div>}</div>
        </article>)}
      </div>
    </section>
    {recordToDelete && <ConfirmDeleteDialog title="Delete this sample record?" description="The record will disappear from the current view, while the Timeline will retain an audit entry." summary={recordToDelete.body?.trim() || (recordToDelete.assetKey ? "Photo record" : "Empty record")} deleting={deletingRecord} error={recordDeleteError} eyebrow="Delete record" confirmLabel="Delete record" onCancel={() => { setRecordToDelete(null); setRecordDeleteError(""); }} onConfirm={() => void deleteRecord()} />}
    {assetToDelete && <ConfirmDeleteDialog title="Delete this image attachment?" description="The image will be detached from the record. The Timeline will retain a text-only audit entry showing that an image was removed." summary={assetToDelete.body?.trim() || "Image attachment"} deleting={deletingAsset} error={assetDeleteError} eyebrow="Delete image" confirmLabel="Delete image" onCancel={() => { setAssetToDelete(null); setAssetDeleteError(""); }} onConfirm={() => void deleteAsset()} />}
    {splitting && <SplitSampleDialog sample={sample} onCancel={() => setSplitting(false)} onComplete={async () => { setSplitting(false); await load(); }} />}
  </div>;
}
