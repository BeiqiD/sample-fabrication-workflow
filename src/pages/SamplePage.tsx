import { Fragment, type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SAMPLE_STATUSES, SAMPLE_STATUS_LABELS, type SampleDetail, type SampleEvent, type SampleRun, type SampleStatus } from "../../shared/types";
import { ActionIcon } from "../components/ActionIcon";
import { CommentAttachmentList } from "../components/CommentAttachmentList";
import { CommentComposer, CommentSubmissionRecovery } from "../components/CommentComposer";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { DiagramGallery } from "../components/MultiSampleRunGrid";
import { SampleStateThumbnail } from "../components/SampleStateThumbnail";
import { SampleTimeline } from "../components/SampleTimeline";
import { SplitSampleDialog } from "../components/SplitSampleDialog";
import { StandaloneMetrologyDialog } from "../components/StandaloneMetrologyDialog";
import { StatusPill } from "../components/StatusPill";
import { api } from "../lib/api";
import { currentStructurePresentation } from "../lib/currentStructure";
import { exportSample } from "../lib/exportSample";
import { SAMPLE_HISTORY_PREVIEW_COUNT } from "../lib/sampleHistory";
import { collectSampleNotes } from "../lib/sampleNotes";
import { selectSamplePageRuns } from "../lib/sample-run-selection";

const SAMPLE_NOTES_PREVIEW_COUNT = 5;

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
  const [exporting, setExporting] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [updatingDetails, setUpdatingDetails] = useState(false);
  const [recordToDelete, setRecordToDelete] = useState<SampleEvent | null>(null);
  const [recordDeleteError, setRecordDeleteError] = useState("");
  const [deletingRecord, setDeletingRecord] = useState(false);
  const [assetToDelete, setAssetToDelete] = useState<SampleEvent | null>(null);
  const [assetDeleteError, setAssetDeleteError] = useState("");
  const [deletingAsset, setDeletingAsset] = useState(false);
  const [submissionToDelete, setSubmissionToDelete] = useState<{ id: string; body: string } | null>(null);
  const [submissionDeleteError, setSubmissionDeleteError] = useState("");
  const [deletingSubmission, setDeletingSubmission] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [confirmingSampleDeletion, setConfirmingSampleDeletion] = useState(false);
  const [sampleDeleteConfirmation, setSampleDeleteConfirmation] = useState("");
  const [sampleDeleteError, setSampleDeleteError] = useState("");
  const [deletingSample, setDeletingSample] = useState(false);
  const [showMetrologyPicker, setShowMetrologyPicker] = useState(false);
  const [showAllNotes, setShowAllNotes] = useState(false);

  const load = useCallback(async () => {
    try {
      setSample(await api.getSample(sampleId));
      setError("");
    } catch (error) { setError((error as Error).message); }
  }, [sampleId]);

  useEffect(() => {
    setShowAllNotes(false);
    void load();
  }, [load]);

  async function refreshNotes() {
    setShowAllNotes(false);
    await load();
  }

  function toggleNotes() {
    setShowAllNotes((expanded) => !expanded);
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

  async function deleteSubmission() {
    if (!submissionToDelete) return;
    setDeletingSubmission(true);
    setSubmissionDeleteError("");
    try {
      await api.deleteCommentSubmission(submissionToDelete.id);
      setSubmissionToDelete(null);
      await load();
    } catch (error) { setSubmissionDeleteError((error as Error).message); }
    finally { setDeletingSubmission(false); }
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
  const {
    activeProcessRun,
    activeMetrologyRun,
    latestProcessRun,
    processRunCount,
  } = selectSamplePageRuns(sample.runs);
  const notes = collectSampleNotes(sample);
  const recentEvents = sample.events.slice(0, SAMPLE_HISTORY_PREVIEW_COUNT);
  const processActionLabel = activeProcessRun
    ? "Continue processing"
    : processRunCount
      ? "Start new process"
      : "Start first process";
  const processActionPath = `/processing/${sample.id}${activeProcessRun
    ? `?run=${encodeURIComponent(activeProcessRun.id)}`
    : "?action=start"}`;
  const metrologyActionLabel = activeMetrologyRun ? "Continue metrology" : "Start metrology";
  const currentStructure = currentStructurePresentation(sample);

  return <div className="page sample-overview-page">
    <Link className="back-link" to="/samples">← Samples</Link>
    <div className="sample-header">
      <div className="sample-header-copy"><p className="eyebrow">{sample.code}</p><h1>{sample.title}</h1><p className="lead">{sample.description || "No description"}</p></div>
      <div className="header-actions sample-header-actions">
        <StatusPill status={sample.status} />
        <div className="sample-header-action-buttons">
          <Link
            className="button primary responsive-icon-button"
            to={processActionPath}
            aria-label={processActionLabel}
            title={processActionLabel}
          >
            <ActionIcon name="process" />
            <span className="responsive-action-label">{processActionLabel}</span>
          </Link>
          {activeMetrologyRun
            ? <Link
              className="button responsive-icon-button"
              to={`/processing/${sample.id}?run=${encodeURIComponent(activeMetrologyRun.id)}`}
              aria-label={metrologyActionLabel}
              title={metrologyActionLabel}
            >
              <ActionIcon name="metrology" />
              <span className="responsive-action-label">{metrologyActionLabel}</span>
            </Link>
            : <button
              type="button"
              className="button responsive-icon-button"
              aria-label={metrologyActionLabel}
              title={metrologyActionLabel}
              onClick={() => setShowMetrologyPicker(true)}
            >
              <ActionIcon name="metrology" />
              <span className="responsive-action-label">{metrologyActionLabel}</span>
            </button>}
          <button
            type="button"
            className="button responsive-icon-button sample-header-secondary-action"
            aria-label="Split sample"
            title="Split sample"
            onClick={() => setSplitting(true)}
          >
            <ActionIcon name="split" />
            <span className="responsive-action-label">Split sample</span>
          </button>
          <button
            type="button"
            className="button responsive-icon-button sample-header-secondary-action"
            disabled={exporting}
            aria-label={exporting ? "Exporting sample ZIP" : "Export sample ZIP"}
            aria-busy={exporting}
            title={exporting ? "Exporting sample ZIP" : "Export sample ZIP"}
            onClick={() => {
              setExporting(true);
              void exportSample(sample).catch((error: Error) => setError(error.message)).finally(() => setExporting(false));
            }}
          >
            <ActionIcon name="export" />
            <span className="responsive-action-label">{exporting ? "Exporting…" : "Export ZIP"}</span>
          </button>
        </div>
      </div>
    </div>

    {error && <p className="error-banner">{error}</p>}
    <section className="sample-priority-grid">
      <div className="sample-priority-sidebar">
        <aside className="card facts sample-details-card">
          <div className="card-title-row"><h2 className="card-title">Sample details</h2><button className="text-button" onClick={() => setEditingDetails((value) => !value)}>{editingDetails ? "Cancel" : "Edit"}</button></div>
          {editingDetails ? <form className="detail-form" onSubmit={updateDetails}>
            <label>Sample code<input value={sample.code} readOnly aria-readonly="true" title="Sample code is a permanent identifier" /></label>
            <label>Sample name<input name="title" defaultValue={sample.title} required maxLength={200} /></label>
            <label>Status<select name="status" defaultValue={sample.status}>{SAMPLE_STATUSES.map((status) => <option value={status} key={status}>{SAMPLE_STATUS_LABELS[status]}</option>)}</select></label>
            <label>Location<input name="location" defaultValue={sample.location || ""} placeholder="Box, lab, or tool" /></label>
            <label className="checkbox-label"><input name="pinned" type="checkbox" defaultChecked={sample.pinned} />Pinned</label>
            <button className="button primary wide" disabled={updatingDetails}>{updatingDetails ? "Saving…" : "Save changes"}</button>
          </form> : <dl><dt>Location</dt><dd className="sample-location-value">{sample.location || "—"}</dd><dt>Sample code</dt><dd>{sample.code}</dd><dt>Sample name</dt><dd>{sample.title}</dd><dt>Status</dt><dd>{SAMPLE_STATUS_LABELS[sample.status]}</dd><dt>Pinned</dt><dd>{sample.pinned ? "Yes" : "No"}</dd><dt>Parent</dt><dd>{sample.parent ? <Link to={`/samples/${sample.parent.id}`}>{sample.parent.code}</Link> : "—"}</dd><dt>Children</dt><dd>{sample.children.length ? sample.children.map((child) => <Link key={child.id} to={`/samples/${child.id}`}>{child.code}</Link>) : "—"}</dd><dt>Created</dt><dd>{new Date(sample.createdAt).toLocaleString()}</dd></dl>}
          {!editingDetails && <div className="sample-danger-zone"><div><strong>Delete sample</strong><small>Remove this sample and its processing history.</small></div><button type="button" className="button danger" onClick={() => { setSampleDeleteConfirmation(""); setSampleDeleteError(""); setConfirmingSampleDeletion(true); }}>Delete</button></div>}
        </aside>

        <article className="card sample-current-structure">
          <div className="card-copy">
            <h2 className="card-title">Current structure</h2>
            <p className="card-value">{currentStructure.title}</p>
            <p className="card-meta">{currentStructure.detail}</p>
            {latestProcessRun && <Link className="text-button structure-source-link" to={`/processing/${sample.id}?run=${encodeURIComponent(latestProcessRun.id)}`}>Open source run</Link>}
          </div>
          <SampleStateThumbnail sample={sample} />
        </article>
      </div>

      <div className="sample-notes-slot">
      <section className="card sample-notes-card" id="sample-notes">
        <div className="section-heading sample-notes-heading">
          <div><h2>Notes &amp; observations</h2><p>Important comments, observations, and exceptions from this sample and its processing runs.</p></div>
          <span className="section-count">{notes.length}</span>
        </div>
        <div className="sample-note-composer">
          <p className="card-label">Add a note or observation</p>
          <CommentComposer
            label="Add a note or observation"
            submitLabel="Add note"
            context={{ kind: "sample", sampleId: sample.id, expectedUpdatedAt: sample.updatedAt }}
            onSubmitted={refreshNotes}
          />
          <CommentSubmissionRecovery submissions={(sample.comments ?? []).filter((comment) => comment.status !== "ready" && comment.status !== "cancelled")} onSubmitted={refreshNotes} />
          <small>Saved directly to this sample.</small>
        </div>
        {notes.length ? <div className={`sample-notes-list ${showAllNotes ? "is-expanded" : "is-collapsed"}`} id="sample-notes-list">{notes.map((note, index) => <Fragment key={note.id}>
          {index === SAMPLE_NOTES_PREVIEW_COUNT && <button
            type="button"
            className="sample-notes-toggle"
            aria-controls="sample-notes-list"
            aria-expanded={showAllNotes}
            onClick={toggleNotes}
          >
            {showAllNotes ? `Show recent ${SAMPLE_NOTES_PREVIEW_COUNT}` : `Show all ${notes.length} notes`}
          </button>}
          <article className={`sample-note sample-note-${note.kind}${index >= SAMPLE_NOTES_PREVIEW_COUNT ? " sample-note-preview-overflow" : ""}`}>
          <div className="sample-note-heading">
            <div><p className="card-label">{note.label}</p><p className="sample-note-context">{note.context}</p></div>
            <time>{new Date(note.createdAt).toLocaleString()}</time>
          </div>
          <div className="sample-note-content">
            {note.status !== "ready" && <strong className={`comment-upload-state status-${note.status}`}>{note.status === "failed" ? "Upload incomplete" : "Uploading…"}</strong>}
            <p>{note.body}</p>
            {note.images.some((image) => image.assetKey) && <div className="sample-note-images"><DiagramGallery
              keys={note.images.flatMap((image) => image.assetKey ? [image.assetKey] : [])}
              label={`${note.label} photo`}
              kind="photo"
            /></div>}
            <CommentAttachmentList attachments={note.attachments} className="sample-note-attachments" />
          </div>
          <div className="sample-note-footer">
            <span>{note.actorEmail || (note.kind === "execution_detail" || note.kind === "execution_image" || note.kind === "deviation" || note.kind === "blocked_step" ? "Recorded process evidence" : "Unknown user")}</span>
            <div>
              {note.runId && <Link className="text-button" to={`/processing/${sample.id}?run=${encodeURIComponent(note.runId)}`}>Open in processing</Link>}
              {note.sampleEvent?.assetKey && <button type="button" className="text-button" onClick={() => { setAssetDeleteError(""); setAssetToDelete(note.sampleEvent); }}>Delete image</button>}
              {note.sampleEvent && <button type="button" className="text-button danger-text-button" onClick={() => { setRecordDeleteError(""); setRecordToDelete(note.sampleEvent); }}>Delete note</button>}
              {note.submissionId && <button type="button" className="text-button danger-text-button" onClick={() => { setSubmissionDeleteError(""); setSubmissionToDelete({ id: note.submissionId!, body: note.body }); }}>Delete note</button>}
            </div>
          </div>
          </article>
        </Fragment>)}</div> : <div className="notes-empty"><p>No notes or exceptions have been recorded yet.</p><span>Normal processing activity remains available in the Timeline.</span></div>}
      </section>
      </div>
    </section>

    <section className="sample-secondary-grid">
      <section className="sample-runs-section">
        <div className="section-heading"><div><h2>Process runs</h2><p>The ordered processing history for this sample.</p></div><span className="section-count">{sample.runs.length}</span></div>
        {sample.runs.length ? <div className="sample-run-list">{sample.runs.map((run) => {
          const progress = runProgress(run);
          const frames = runStructureFrames(run);
          return <details className="card sample-run-card" key={run.id}>
            <summary className="sample-run-summary">
              <div>
                <div className="sample-run-title-row"><h3 className="sample-run-name">Run {run.sequenceNo} · {run.templateName} <span>v{run.templateVersion}</span></h3><span className={`run-status run-status-${run.status}`}>{runStatusLabel(run.status)}</span></div>
                <p className="card-meta">Plan revision {run.planRevisionNumber} · {run.initialStateHash ? "initial substrate recorded" : "initial substrate unavailable"}</p>
              </div>
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
        })}</div> : <div className="card empty-run-message"><h3 className="card-title">No process runs</h3><p>Open Processing to choose a process template and start the first run.</p></div>}
      </section>

      <section className="sample-recent-timeline">
        <div className="section-heading">
          <div><h2>Recent timeline</h2><p>The latest audit events, including normal activity.</p></div>
          <span className="section-count">{sample.events.length}</span>
        </div>
        <div className="card recent-timeline-card">
          <SampleTimeline events={recentEvents} compact />
          <Link className="button wide" to={`/samples/${sample.id}/timeline`}>View full timeline</Link>
        </div>
      </section>
    </section>
    {recordToDelete && <ConfirmDeleteDialog title="Delete this sample note?" description="The note will disappear from Notes & observations, while the Timeline will retain a deletion audit entry." summary={recordToDelete.body?.trim() || (recordToDelete.assetKey ? "Photo observation" : "Empty note")} deleting={deletingRecord} error={recordDeleteError} eyebrow="Delete note" confirmLabel="Delete note" onCancel={() => { setRecordToDelete(null); setRecordDeleteError(""); }} onConfirm={() => void deleteRecord()} />}
    {assetToDelete && <ConfirmDeleteDialog title="Delete this image attachment?" description="The image will be detached from the record. The Timeline will retain a text-only audit entry showing that an image was removed." summary={assetToDelete.body?.trim() || "Image attachment"} deleting={deletingAsset} error={assetDeleteError} eyebrow="Delete image" confirmLabel="Delete image" onCancel={() => { setAssetToDelete(null); setAssetDeleteError(""); }} onConfirm={() => void deleteAsset()} />}
    {submissionToDelete && <ConfirmDeleteDialog title="Delete this sample note?" description="The note and its attachments will be removed. The Timeline will retain a deletion audit entry." summary={submissionToDelete.body || "Files attached"} deleting={deletingSubmission} error={submissionDeleteError} eyebrow="Delete note" confirmLabel="Delete note" onCancel={() => { setSubmissionToDelete(null); setSubmissionDeleteError(""); }} onConfirm={() => void deleteSubmission()} />}
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
    {showMetrologyPicker && <StandaloneMetrologyDialog
      sampleId={sample.id}
      onClose={() => setShowMetrologyPicker(false)}
      onStarted={(runId) => navigate(`/processing/${sample.id}?run=${encodeURIComponent(runId)}`)}
    />}
    {splitting && <SplitSampleDialog sample={sample} onCancel={() => setSplitting(false)} onComplete={async () => { setSplitting(false); await load(); }} />}
  </div>;
}
