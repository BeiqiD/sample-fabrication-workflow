import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { SAMPLE_STATUSES, SAMPLE_STATUS_LABELS, type SampleDetail, type SampleEvent, type SampleRun, type SampleStatus } from "../../shared/types";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { FileDropzone } from "../components/FileDropzone";
import { SampleStateThumbnail } from "../components/SampleStateThumbnail";
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

function runStructureFrames(run: SampleRun) {
  const frames: Array<{ key: string; label: string; imageKeys: string[]; stateHash: string | null }> = [];
  if (run.initialStateImageKeys.length) {
    frames.push({ key: `${run.id}:initial`, label: "Initial substrate", imageKeys: run.initialStateImageKeys, stateHash: run.initialStateHash });
  }
  for (const step of run.steps) {
    if (step.status !== "done" || !step.actualizedAt) continue;
    const imageKeys = step.executionImageKeys.length ? step.executionImageKeys : step.plannedImageKeys;
    if (!imageKeys.length) continue;
    const previous = frames[frames.length - 1];
    if (step.expectedStateHash && previous?.stateHash === step.expectedStateHash && !step.executionImageKeys.length) continue;
    frames.push({ key: step.id, label: step.title, imageKeys, stateHash: step.expectedStateHash });
  }
  if (frames.length === 1 && frames[0].key.endsWith(":initial")) {
    frames[0].label = run.status === "active" ? "Initial / latest recorded structure" : "Initial / final structure";
  } else if (frames.length) {
    frames[frames.length - 1].label = run.status === "active" ? "Latest recorded structure" : "Final structure";
  }
  return frames;
}

export function SamplePage() {
  const { sampleId = "" } = useParams();
  const navigate = useNavigate();
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
  const [confirmingSampleDeletion, setConfirmingSampleDeletion] = useState(false);
  const [sampleDeleteConfirmation, setSampleDeleteConfirmation] = useState("");
  const [sampleDeleteError, setSampleDeleteError] = useState("");
  const [deletingSample, setDeletingSample] = useState(false);
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

  async function deleteSample() {
    if (!sample || sampleDeleteConfirmation !== sample.code) return;
    setDeletingSample(true); setSampleDeleteError("");
    try {
      await api.deleteSample(sample.id, {
        confirmationCode: sampleDeleteConfirmation,
        expectedUpdatedAt: sample.updatedAt,
      });
      navigate("/samples", { replace: true });
    } catch (error) { setSampleDeleteError((error as Error).message); }
    finally { setDeletingSample(false); }
  }

  if (!sample) return <div className="page"><p>{error || "Loading sample…"}</p></div>;
  const activeRun = sample.runs.find((run) => run.status === "active") ?? null;
  const visibleEvents = visibleSampleHistory(sample.events, historyExpanded);
  const hiddenEventCount = sample.events.length - visibleEvents.length;

  return <div className="page sample-overview-page">
    <Link className="back-link" to="/samples">← Samples</Link>
    <div className="sample-header">
      <div className="sample-header-copy"><p className="eyebrow">{sample.code}</p><h1>{sample.title}</h1><p className="lead">{sample.description || "No description"}</p></div>
      <div className="header-actions"><StatusPill status={sample.status} /><Link className="button primary" to={`/processing/${sample.id}${activeRun ? `?run=${encodeURIComponent(activeRun.id)}` : "?action=start"}`}>{activeRun ? "Continue processing" : sample.runs.length ? "Start new run" : "Start first run"}</Link><a className="button" href="#sample-record">Add record</a><button className="button" onClick={() => setSplitting(true)}>Split sample</button><button className="button" disabled={exporting} onClick={() => {
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
          <label>Sample name<input name="title" defaultValue={sample.title} required maxLength={200} /></label>
          <label>Status<select name="status" defaultValue={sample.status}>{SAMPLE_STATUSES.map((status) => <option value={status} key={status}>{SAMPLE_STATUS_LABELS[status]}</option>)}</select></label>
          <label>Location<input name="location" defaultValue={sample.location || ""} placeholder="Box, lab, or tool" /></label>
          <label className="checkbox-label"><input name="pinned" type="checkbox" defaultChecked={sample.pinned} />Pinned</label>
          <button className="button primary wide" disabled={updatingDetails}>{updatingDetails ? "Saving…" : "Save changes"}</button>
        </form> : <dl><dt>Sample code</dt><dd>{sample.code}</dd><dt>Sample name</dt><dd>{sample.title}</dd><dt>Status</dt><dd>{sample.status}</dd><dt>Location</dt><dd>{sample.location || "—"}</dd><dt>Pinned</dt><dd>{sample.pinned ? "Yes" : "No"}</dd><dt>Parent</dt><dd>{sample.parent ? <Link to={`/samples/${sample.parent.id}`}>{sample.parent.code}</Link> : "—"}</dd><dt>Children</dt><dd>{sample.children.length ? sample.children.map((child) => <Link key={child.id} to={`/samples/${child.id}`}>{child.code}</Link>) : "—"}</dd><dt>Created</dt><dd>{new Date(sample.createdAt).toLocaleString()}</dd></dl>}
        {!editingDetails && <div className="sample-danger-zone"><div><strong>Delete sample</strong><small>Remove this sample and its processing history.</small></div><button type="button" className="button danger" onClick={() => { setSampleDeleteConfirmation(""); setSampleDeleteError(""); setConfirmingSampleDeletion(true); }}>Delete</button></div>}
      </aside>

      <section className="sample-runs-section">
        <article className="card sample-current-structure">
          <div><p className="eyebrow">Current structure</p><h2>{sample.currentStateStepTitle ? `After ${sample.currentStateStepTitle}` : sample.latestWorkflowName ? "Latest recorded substrate" : "No process structure yet"}</h2><p>{sample.latestWorkflowName ? `${sample.latestWorkflowName}${sample.latestWorkflowVersion ? ` · v${sample.latestWorkflowVersion}` : ""}` : "Start a process run to establish the first substrate snapshot."}</p></div>
          <SampleStateThumbnail sample={sample} />
        </article>
        <div className="section-heading"><div><p className="eyebrow">Processing history</p><h2>Runs</h2></div><span>{sample.runs.length}</span></div>
        {sample.runs.length ? <div className="sample-run-list">{sample.runs.map((run) => {
          const progress = runProgress(run);
          const frames = runStructureFrames(run);
          return <details className="card sample-run-card" key={run.id}>
            <summary className="sample-run-summary">
              <div><span className={`run-status run-status-${run.status}`}>{runStatusLabel(run.status)}</span><p className="sample-run-name"><strong>Run {run.sequenceNo} · {run.templateName}</strong> · v{run.templateVersion}</p><small>Plan revision {run.planRevisionNumber} · {run.initialStateHash ? "initial substrate recorded" : "initial substrate unavailable"}</small></div>
              <div className="sample-run-progress"><strong>{progress.completed} / {progress.total}</strong><span>steps complete</span></div>
              <time>{new Date(run.completedAt || run.createdAt).toLocaleString()}</time>
              <Link className="button" onClick={(event) => event.stopPropagation()} to={`/processing/${sample.id}?run=${encodeURIComponent(run.id)}`}>{run.status === "active" ? "Continue" : "View run"}</Link>
            </summary>
            <div className="run-structure-history">
              {frames.length ? frames.map((frame, index) => <div className="run-structure-frame" key={frame.key}>
                {index > 0 && <span className="run-structure-arrow" aria-hidden="true">→</span>}
                <div><small>{frame.label}</small><div className="run-structure-images">{frame.imageKeys.map((key) => <img loading="lazy" src={`/api/assets/${key}`} alt={`${frame.label} for run ${run.sequenceNo}`} key={key} />)}</div></div>
              </div>) : <p className="muted">This run has no recorded structure diagrams.</p>}
            </div>
          </details>;
        })}</div> : <div className="card empty-run-message"><h2>No process runs</h2><p>Open Processing to choose a process template and start the first run.</p></div>}
      </section>
    </div>

    <section className="sample-record-section" id="sample-record">
      <div className="section-heading sample-record-heading"><div><p className="eyebrow">Permanent sample history</p><h2>Timeline</h2></div></div>
      <form className="card composer" onSubmit={addComment}>
        <label>Add a sample record<textarea name="body" rows={3} placeholder="Overall observation about this sample, independent of any process step…" /></label>
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
    {confirmingSampleDeletion && <ConfirmDeleteDialog
      title={`Delete ${sample.code}?`}
      description={`The sample and all of its processing history will be permanently deleted.${sample.children.length ? " Child samples will remain, but their parent link will be removed." : ""}`}
      summary={`${sample.runs.length} processing run${sample.runs.length === 1 ? "" : "s"}\n${sample.runs.reduce((total, run) => total + run.steps.length, 0)} processing steps\n${sample.events.length} timeline entries\n${sample.stateVerifications.length} state verifications\n${sample.children.length} child sample${sample.children.length === 1 ? "" : "s"} kept`}
      deleting={deletingSample}
      error={sampleDeleteError}
      eyebrow="Delete sample"
      confirmLabel="Permanently delete"
      confirmation={{ label: `Type ${sample.code} to confirm`, target: sample.code, value: sampleDeleteConfirmation, onChange: setSampleDeleteConfirmation }}
      onCancel={() => { setConfirmingSampleDeletion(false); setSampleDeleteConfirmation(""); setSampleDeleteError(""); }}
      onConfirm={() => void deleteSample()}
    />}
    {splitting && <SplitSampleDialog sample={sample} onCancel={() => setSplitting(false)} onComplete={async () => { setSplitting(false); await load(); }} />}
  </div>;
}
