import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { isSampleRecordEvent } from "../../shared/sample-records";
import type { PlanUpdatePreview, SampleDetail, SampleEvent, SampleStatus, SampleSummary } from "../../shared/types";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { FileDropzone } from "../components/FileDropzone";
import { MultiSampleRunGrid } from "../components/MultiSampleRunGrid";
import { StatusPill } from "../components/StatusPill";
import { api, type TemplateRecord } from "../lib/api";
import { exportSample } from "../lib/exportSample";
import { compressCommentImage } from "../lib/images";

const MAX_VISIBLE_SAMPLES = 8;

export function SamplePage() {
  const { sampleId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const additionalKey = searchParams.get("with") || "";
  const additionalIds = additionalKey.split(",").map((id) => id.trim()).filter((id, index, ids) => id && id !== sampleId && ids.indexOf(id) === index).slice(0, MAX_VISIBLE_SAMPLES - 1);
  const [samples, setSamples] = useState<SampleDetail[]>([]);
  const sample = samples.find((item) => item.id === sampleId) || null;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [templateVersionId, setTemplateVersionId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [planPreview, setPlanPreview] = useState<PlanUpdatePreview | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [updatingDetails, setUpdatingDetails] = useState(false);
  const [commentImage, setCommentImage] = useState<File | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<SampleEvent | null>(null);
  const [recordDeleteError, setRecordDeleteError] = useState("");
  const [deletingRecord, setDeletingRecord] = useState(false);
  const [showSamplePicker, setShowSamplePicker] = useState(false);
  const [sampleQuery, setSampleQuery] = useState("");
  const [sampleResults, setSampleResults] = useState<SampleSummary[]>([]);
  const pendingUploadRef = useRef<{ signature: string; assetKey?: string; thumbnailKey?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const details = await Promise.all([sampleId, ...additionalIds].map((id) => api.getSample(id)));
      setSamples(details);
      setError("");
    } catch (error) { setError((error as Error).message); }
  // additionalKey is the stable URL representation of additionalIds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId, additionalKey]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api.listTemplates().then(({ templates }) => setTemplates(templates)).catch((error: Error) => setError(error.message)); }, []);
  const activeRun = sample?.runs.find((run) => run.status === "active") ?? null;
  useEffect(() => {
    setPlanPreview(null);
    if (!sample || !activeRun || !templateVersionId) return;
    api.previewPlanUpdate(sample.id, activeRun.id, templateVersionId).then(setPlanPreview).catch((error: Error) => setError(error.message));
  }, [sample, activeRun, templateVersionId]);
  useEffect(() => {
    if (!showSamplePicker) return;
    const timeout = window.setTimeout(() => {
      api.listSamples(sampleQuery).then(({ samples }) => setSampleResults(samples)).catch((error: Error) => setError(error.message));
    }, 160);
    return () => window.clearTimeout(timeout);
  }, [sampleQuery, showSamplePicker]);

  function updateVisibleSamples(ids: string[]) {
    const next = new URLSearchParams(searchParams);
    if (ids.length) next.set("with", ids.join(",")); else next.delete("with");
    setSearchParams(next, { replace: true });
  }

  function addVisibleSample(id: string) {
    if (samples.length >= MAX_VISIBLE_SAMPLES || id === sampleId || additionalIds.includes(id)) return;
    updateVisibleSamples([...additionalIds, id]);
    setShowSamplePicker(false);
    setSampleQuery("");
  }

  function removeVisibleSample(id: string) {
    updateVisibleSamples(additionalIds.filter((sample) => sample !== id));
  }

  async function assignTemplate() {
    if (!templateVersionId) return;
    setAssigning(true); setError("");
    try { await api.assignTemplate(sampleId, templateVersionId); setTemplateVersionId(""); await load(); }
    catch (error) { setError((error as Error).message); }
    finally { setAssigning(false); }
  }

  async function updatePlan() {
    if (!templateVersionId || !activeRun || !planPreview?.compatible) return;
    setAssigning(true); setError("");
    try { await api.applyPlanUpdate(sampleId, activeRun.id, templateVersionId); setTemplateVersionId(""); setPlanPreview(null); await load(); }
    catch (error) { setError((error as Error).message); }
    finally { setAssigning(false); }
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sample) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = String(data.get("body") || "").trim();
    const image = commentImage;
    if (!body && !image) return;
    setSaving(true);
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

  async function updateDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sample) return;
    const form = new FormData(event.currentTarget);
    setUpdatingDetails(true); setError("");
    try {
      await api.updateSample(sampleId, {
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
  const includedIds = new Set(samples.map((item) => item.id));
  const availableResults = sampleResults.filter((result) => !includedIds.has(result.id));
  const assignableTemplates = activeRun
    ? templates.filter((template) => template.recipeFamilyId === activeRun.recipeFamilyId && template.id !== activeRun.templateVersionId)
    : templates;

  return <div className="page sample-page">
    <Link className="back-link" to="/">← Samples</Link>
    <div className="sample-header">
      <div><p className="eyebrow">{sample.code}</p><h1>{sample.title}</h1><p className="lead">{sample.description || "No description"}</p></div>
      <div className="header-actions"><StatusPill status={sample.status} /><Link className="button primary" to={`/entry?sampleId=${encodeURIComponent(sample.id)}`}>Sample record</Link><Link className="button" to={`/samples/new?parentId=${encodeURIComponent(sample.id)}`}>Create child</Link><button className="button" disabled={exporting} onClick={() => {
        setExporting(true);
        void exportSample(sample).catch((error: Error) => setError(error.message)).finally(() => setExporting(false));
      }}>{exporting ? "Exporting…" : "Export ZIP"}</button></div>
    </div>

    <section className="execution-workspace">
      <div className="execution-heading">
        <div><p className="eyebrow">Execution workspace</p><h2>Samples in this view</h2><p>Use checked columns for common confirmation and comments. Every correction remains sample-specific.</p></div>
        <button className="button primary" disabled={samples.length >= MAX_VISIBLE_SAMPLES} onClick={() => setShowSamplePicker((value) => !value)}>+ Add sample</button>
      </div>
      <div className="visible-samples">
        {samples.map((item, index) => <div className="visible-sample" key={item.id}><span>{item.code}</span><small>{item.title}</small>{index > 0 && <button type="button" aria-label={`Remove ${item.code} from view`} onClick={() => removeVisibleSample(item.id)}>×</button>}</div>)}
      </div>
      {showSamplePicker && <div className="card sample-picker-popover">
        <label>Find another sample<input autoFocus value={sampleQuery} onChange={(event) => setSampleQuery(event.target.value)} placeholder="Code, title, or location" /></label>
        <div>{availableResults.length ? availableResults.map((result) => <button type="button" key={result.id} onClick={() => addVisibleSample(result.id)}><strong>{result.code}</strong><span>{result.title}</span><small>{result.location || "No location"}</small></button>) : <p className="muted">No samples to add.</p>}</div>
      </div>}

      <div className="card assign-template"><div><strong>{activeRun ? `Update the active plan for ${sample.code}` : `Continue processing ${sample.code}`}</strong><small>{activeRun ? `Only another version of ${activeRun.templateName} can reconcile unfinished work. Completed history is protected.` : sample.runs.length ? "Starts a successor run connected to the last actual step." : "Starts the first run for this physical sample."}</small></div><select value={templateVersionId} onChange={(event) => setTemplateVersionId(event.target.value)}><option value="">{activeRun ? "Choose another version of this recipe…" : "Choose process, module, or recipe…"}</option>{assignableTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.templateType} v{template.version} · {template.stepCount} steps</option>)}</select><button className="button" disabled={!templateVersionId || assigning || Boolean(activeRun && !planPreview?.compatible)} onClick={() => void (activeRun ? updatePlan() : assignTemplate())}>{assigning ? "Saving…" : activeRun ? "Apply plan update" : sample.runs.length ? "Start successor run" : "Assign"}</button>{activeRun && planPreview && <small className={planPreview.compatible ? "muted" : "error-text"}>{planPreview.compatible ? `${planPreview.preservedCount} linked · ${planPreview.additionCount} new · ${planPreview.supersededCount} replaced` : "This version conflicts with executed history and cannot be applied in place."}</small>}</div>

      {sample.runs.length > 0 ? <section className="runs-section">{sample.runs.map((run) => <MultiSampleRunGrid key={`${run.id}:${samples.map((item) => item.id).join(",")}`} primaryRun={run} columns={samples.map((item) => ({ sample: item, run: item.id === sample.id ? run : item.runs.find((candidate) => candidate.recipeFamilyId === run.recipeFamilyId && candidate.status === run.status) ?? null }))} onSaved={load} />)}</section> : <div className="card empty-run-message"><h2>No assigned recipe yet</h2><p>Assign one above to start the execution grid.</p></div>}
    </section>

    <div className="detail-grid sample-record-layout">
      <aside className="card facts">
        <div className="card-title-row"><h2>Sample details</h2><button className="text-button" onClick={() => setEditingDetails((value) => !value)}>{editingDetails ? "Cancel" : "Edit"}</button></div>
        {editingDetails ? <form className="detail-form" onSubmit={updateDetails}>
          <label>Status<select name="status" defaultValue={sample.status}><option value="active">Active</option><option value="stored">Stored</option><option value="consumed">Consumed</option><option value="lost">Lost</option></select></label>
          <label>Location<input name="location" defaultValue={sample.location || ""} placeholder="Box, lab, or tool" /></label>
          <label className="checkbox-label"><input name="pinned" type="checkbox" defaultChecked={sample.pinned} />Pinned</label>
          <button className="button primary wide" disabled={updatingDetails}>{updatingDetails ? "Saving…" : "Save changes"}</button>
        </form> : <dl><dt>Status</dt><dd>{sample.status}</dd><dt>Location</dt><dd>{sample.location || "—"}</dd><dt>Pinned</dt><dd>{sample.pinned ? "Yes" : "No"}</dd><dt>Parent</dt><dd>{sample.parent ? <Link to={`/samples/${sample.parent.id}`}>{sample.parent.code}</Link> : "—"}</dd><dt>Children</dt><dd>{sample.children.length ? sample.children.map((child) => <Link key={child.id} to={`/samples/${child.id}`}>{child.code}</Link>) : "—"}</dd><dt>Created</dt><dd>{new Date(sample.createdAt).toLocaleString()}</dd></dl>}
      </aside>
      <section>
        <div className="section-heading sample-record-heading"><div><p className="eyebrow">Sample-level information</p><h2>Sample record</h2></div></div>
        <form className="card composer" onSubmit={addComment}>
          <label>Add a sample record<textarea name="body" rows={3} placeholder="Overall observation about this sample, independent of any recipe step…" /></label>
          <FileDropzone compact accept="image/*" capture="environment" file={commentImage} onFile={(file) => { pendingUploadRef.current = null; setCommentImage(file); }} label="Drop a sample-level photo" />
          <div className="composer-actions"><span className="muted">This appears in the sample timeline, not inside a recipe step.</span><button className="button primary" disabled={saving}>{saving ? "Saving…" : "Add to sample record"}</button></div>
        </form>
        {error && <p className="error-banner">{error}</p>}
        <div className="timeline">
          {sample.events.map((event) => <article className="event" key={event.id}>
            <div className="event-dot" />
            <div className="event-content"><div className="event-meta"><span>{event.kind}{event.actorEmail ? ` · ${event.actorEmail}` : ""}</span><div><time>{new Date(event.createdAt).toLocaleString()}</time>{isSampleRecordEvent(event.kind, event.metadata) && <button type="button" onClick={() => { setRecordDeleteError(""); setRecordToDelete(event); }}>Delete</button>}</div></div>{event.body && <p>{event.body}</p>}{event.assetKey && <a href={`/api/assets/${event.assetKey}`} target="_blank" rel="noreferrer"><img src={`/api/assets/${typeof event.metadata.thumbnailKey === "string" ? event.metadata.thumbnailKey : event.assetKey}`} alt={event.body || "Sample record"} loading="lazy" /></a>}</div>
          </article>)}
        </div>
      </section>
    </div>
    {recordToDelete && <ConfirmDeleteDialog
      title="Remove this sample record?"
      description="This global comment or photo will be removed from the sample timeline."
      summary={recordToDelete.body?.trim() || (recordToDelete.assetKey ? "Photo record" : "Empty record")}
      deleting={deletingRecord}
      error={recordDeleteError}
      onCancel={() => { setRecordToDelete(null); setRecordDeleteError(""); }}
      onConfirm={() => void deleteRecord()}
    />}
  </div>;
}
