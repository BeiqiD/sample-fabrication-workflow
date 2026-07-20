import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RunStep, SampleRun, StepStatus } from "../../shared/types";
import { api } from "../lib/api";
import { compressLayerStackImage } from "../lib/images";
import { runStepIsModified } from "../lib/runSteps";
import { FileDropzone } from "./FileDropzone";
import { StatusPill } from "./StatusPill";

const STATUSES: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];

function DiagramGallery({ keys, label }: { keys: string[]; label: string }) {
  if (!keys.length) return null;
  return <div className="diagram-gallery">{keys.map((key) => <a key={key} href={`/api/assets/${key}`} target="_blank" rel="noreferrer"><img src={`/api/assets/${key}`} alt={label} loading="lazy" /></a>)}</div>;
}

function AddStepForm({ sampleId, runId, afterStepId, onSaved, onCancel }: { sampleId: string; runId: string; afterStepId?: string; onSaved: () => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [toolName, setToolName] = useState("");
  const [parametersText, setParametersText] = useState("");
  const [commentsText, setCommentsText] = useState("");
  const [deviationNote, setDeviationNote] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    if (!title.trim()) { setError("Step title is required."); return; }
    setSaving(true); setError("");
    try {
      let assetKey: string | undefined;
      if (image) {
        const compressed = await compressLayerStackImage(image);
        assetKey = (await api.uploadAsset(compressed, compressed.name)).key;
      }
      await api.createRunStep(sampleId, runId, { afterStepId, title, toolName, parametersText, commentsText, deviationNote, assetKey });
      await onSaved();
      onCancel();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  return <div className="step-form add-step-form">
    <div className="step-form-heading"><strong>Add an ad hoc step</strong><span>Saved only to this sample run</span></div>
    <label>Step name<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Tool<input value={toolName} onChange={(event) => setToolName(event.target.value)} /></label>
    <label>Parameters<textarea rows={3} value={parametersText} onChange={(event) => setParametersText(event.target.value)} /></label>
    <label>Instructions or comments<textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} /></label>
    <label>Reason for deviation<textarea rows={2} value={deviationNote} onChange={(event) => setDeviationNote(event.target.value)} placeholder="Why was this step added?" /></label>
    <FileDropzone compact accept="image/*" file={image} onFile={setImage} label="Drop a step diagram" />
    {error && <p className="error-banner">{error}</p>}
    <div className="form-actions"><button type="button" className="button" onClick={onCancel}>Cancel</button><button type="button" className="button primary" disabled={saving} onClick={() => void add()}>{saving ? "Adding…" : "Add step"}</button></div>
  </div>;
}

function StepEditor({ sampleId, runId, step, displayIndex, onSaved }: { sampleId: string; runId: string; step: RunStep; displayIndex: number; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState(step.status);
  const [title, setTitle] = useState(step.title);
  const [toolName, setToolName] = useState(step.toolName || "");
  const [parametersText, setParametersText] = useState(step.parametersText || "");
  const [commentsText, setCommentsText] = useState(step.commentsText || "");
  const [deviationNote, setDeviationNote] = useState(step.deviationNote || "");
  const [notes, setNotes] = useState(step.notes || "");
  const [image, setImage] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [addingAfter, setAddingAfter] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pendingUploadRef = useRef<{ signature: string; assetKey?: string } | null>(null);

  useEffect(() => {
    setStatus(step.status); setTitle(step.title); setToolName(step.toolName || ""); setParametersText(step.parametersText || "");
    setCommentsText(step.commentsText || ""); setDeviationNote(step.deviationNote || ""); setNotes(step.notes || "");
  }, [step.updatedAt]);

  async function save() {
    setSaving(true); setError("");
    try {
      let assetKey: string | undefined;
      if (image) {
        const signature = `${image.name}:${image.size}:${image.lastModified}`;
        if (pendingUploadRef.current?.signature !== signature) pendingUploadRef.current = { signature };
        const pending = pendingUploadRef.current;
        if (!pending.assetKey) {
          const compressed = await compressLayerStackImage(image);
          pending.assetKey = (await api.uploadAsset(compressed, compressed.name)).key;
        }
        assetKey = pending.assetKey;
      }
      await api.updateRunStep(sampleId, runId, step.id, { status, title, toolName, parametersText, commentsText, deviationNote, notes, expectedUpdatedAt: step.updatedAt, assetKey });
      pendingUploadRef.current = null; setImage(null); setEditing(false);
      await onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  const modified = runStepIsModified(step);
  return <li className="run-step">
    <div className="run-step-head">
      <span className="step-index">{displayIndex + 1}</span>
      <div><div className="step-title-line"><strong>{step.title}</strong>{step.origin === "ad_hoc" && <span className="change-badge">Ad hoc</span>}{modified && step.origin === "template" && <span className="change-badge">Modified</span>}</div>{step.toolName && <small>{step.toolName}</small>}</div>
      <StatusPill status={step.status} />
    </div>

    <div className="step-content-grid">
      <div>{step.parametersText && <><h4>Actual parameters</h4><p>{step.parametersText}</p></>}{step.commentsText && <><h4>Instructions / comments</h4><p>{step.commentsText}</p></>}{step.notes && <><h4>Execution note</h4><p>{step.notes}</p></>}{step.deviationNote && <p className="deviation-note"><strong>Deviation:</strong> {step.deviationNote}</p>}</div>
      <div><DiagramGallery keys={step.plannedImageKeys} label={`Planned diagram for ${step.title}`} /><DiagramGallery keys={step.executionImageKeys} label={`Execution diagram for ${step.title}`} /></div>
    </div>

    {modified && step.origin === "template" && <details className="planned-comparison"><summary>Compare with assigned plan</summary><dl><dt>Step</dt><dd>{step.plannedTitle || "—"}</dd><dt>Tool</dt><dd>{step.plannedToolName || "—"}</dd><dt>Parameters</dt><dd>{step.plannedParametersText || "—"}</dd><dt>Comments</dt><dd>{step.plannedCommentsText || "—"}</dd></dl></details>}

    <div className="step-actions"><button type="button" className="text-button" onClick={() => setEditing((value) => !value)}>{editing ? "Close editor" : "Edit actual step"}</button><button type="button" className="text-button" onClick={() => setAddingAfter((value) => !value)}>{addingAfter ? "Cancel insertion" : "Add step after"}</button></div>

    {editing && <div className="step-form">
      <div className="step-field-row"><label>Status<select value={status} onChange={(event) => setStatus(event.target.value as StepStatus)}>{STATUSES.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></label><label>Step name<input value={title} onChange={(event) => setTitle(event.target.value)} /></label></div>
      <label>Tool<input value={toolName} onChange={(event) => setToolName(event.target.value)} /></label>
      <label>Actual parameters<textarea rows={3} value={parametersText} onChange={(event) => setParametersText(event.target.value)} /></label>
      <label>Instructions or comments<textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} /></label>
      <label>Deviation from assigned plan<textarea rows={2} value={deviationNote} onChange={(event) => setDeviationNote(event.target.value)} placeholder="Explain why the actual process differs" /></label>
      <label>Execution note<textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <FileDropzone compact accept="image/*" file={image} onFile={(file) => { pendingUploadRef.current = null; setImage(file); }} label="Drop an execution diagram" />
      <button type="button" className="button primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save actual step"}</button>
    </div>}
    {addingAfter && <AddStepForm sampleId={sampleId} runId={runId} afterStepId={step.id} onSaved={onSaved} onCancel={() => setAddingAfter(false)} />}
    {error && <p className="error-banner">{error}</p>}
  </li>;
}

export function RunChecklist({ sampleId, run, onSaved }: { sampleId: string; run: SampleRun; onSaved: () => Promise<void> }) {
  const done = run.steps.filter((step) => ["done", "skipped"].includes(step.status)).length;
  const [addingFirst, setAddingFirst] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState<{ id: string; version: number } | null>(null);
  const [promoteError, setPromoteError] = useState("");

  async function promote() {
    if (!window.confirm("Create a new editable template version from the current actual steps? The assigned plan and this sample run will stay unchanged.")) return;
    setPromoting(true); setPromoteError("");
    try {
      const result = await api.promoteRun(sampleId, run.id);
      setPromoted(result);
      await onSaved();
    } catch (error) { setPromoteError((error as Error).message); }
    finally { setPromoting(false); }
  }

  return <article className="card run-card">
    <div className="run-heading"><div><p className="eyebrow">{run.templateType} · assigned v{run.templateVersion}</p><h2>{run.templateName}</h2><small>Independent sample run snapshot</small></div><div className="run-heading-actions"><span>{done}/{run.steps.length}</span><button type="button" className="button" disabled={promoting} onClick={() => void promote()}>{promoting ? "Creating…" : "Save actual as new version"}</button></div></div>
    {promoted && <p className="success-banner">Created editable template v{promoted.version}. <Link to={`/templates/${promoted.id}`}>Review it →</Link></p>}
    {promoteError && <p className="error-banner">{promoteError}</p>}
    <div className="progress-track"><span style={{ width: `${run.steps.length ? (done / run.steps.length) * 100 : 0}%` }} /></div>
    <button type="button" className="text-button add-first-step" onClick={() => setAddingFirst((value) => !value)}>{addingFirst ? "Cancel insertion" : "+ Add step at beginning"}</button>
    {addingFirst && <AddStepForm sampleId={sampleId} runId={run.id} onSaved={onSaved} onCancel={() => setAddingFirst(false)} />}
    <ol className="run-steps">{run.steps.map((step, index) => <StepEditor key={step.id} sampleId={sampleId} runId={run.id} step={step} displayIndex={index} onSaved={onSaved} />)}</ol>
  </article>;
}
