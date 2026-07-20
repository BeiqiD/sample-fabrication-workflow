import { useRef, useState } from "react";
import type { RunStep, SampleRun, StepStatus } from "../../shared/types";
import { api } from "../lib/api";
import { compressCommentImage } from "../lib/images";
import { StatusPill } from "./StatusPill";

const STATUSES: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];

function StepEditor({ sampleId, runId, step, onSaved }: { sampleId: string; runId: string; step: RunStep; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState(step.status);
  const [notes, setNotes] = useState(step.notes || "");
  const [image, setImage] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pendingUploadRef = useRef<{ signature: string; assetKey?: string; thumbnailKey?: string } | null>(null);

  async function save() {
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
      await api.updateRunStep(sampleId, runId, step.id, { status, notes, expectedUpdatedAt: step.updatedAt, assetKey, thumbnailKey });
      pendingUploadRef.current = null;
      setImage(null);
      await onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  return <li className="run-step">
    <div className="run-step-head"><span className="step-index">{step.position + 1}</span><div><strong>{step.title}</strong>{step.toolName && <small>{step.toolName}</small>}</div><StatusPill status={step.status} /></div>
    {(step.parametersText || step.templateCommentsText || step.templateImageKey) && <details className="step-reference"><summary>Template details</summary><div className="step-reference-grid"><div>{step.parametersText && <><h4>Parameters</h4><p>{step.parametersText}</p></>}{step.templateCommentsText && <><h4>Template comments</h4><p>{step.templateCommentsText}</p></>}</div>{step.templateImageKey && <img src={`/api/assets/${step.templateImageKey}`} alt={`Layer stack for ${step.title}`} />}</div></details>}
    <div className="step-edit"><select aria-label={`Status for ${step.title}`} value={status} onChange={(event) => setStatus(event.target.value as StepStatus)}>{STATUSES.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Step note…" /><input type="file" accept="image/*" capture="environment" onChange={(event) => { pendingUploadRef.current = null; setImage(event.target.files?.[0] || null); }} /><button className="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save step"}</button></div>
    {error && <p className="error-banner">{error}</p>}
  </li>;
}

export function RunChecklist({ sampleId, run, onSaved }: { sampleId: string; run: SampleRun; onSaved: () => Promise<void> }) {
  const done = run.steps.filter((step) => ["done", "skipped"].includes(step.status)).length;
  return <article className="card run-card">
    <div className="run-heading"><div><p className="eyebrow">{run.templateType} · v{run.templateVersion}</p><h2>{run.templateName}</h2></div><span>{done}/{run.steps.length}</span></div>
    <div className="progress-track"><span style={{ width: `${run.steps.length ? (done / run.steps.length) * 100 : 0}%` }} /></div>
    <ol className="run-steps">{run.steps.map((step) => <StepEditor key={step.id} sampleId={sampleId} runId={run.id} step={step} onSaved={onSaved} />)}</ol>
  </article>;
}
