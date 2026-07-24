import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { SubstrateStepDetails } from "../components/SubstrateStepDetails";
import { FileDropzone } from "../components/FileDropzone";
import { api, type TemplateDetail, type TemplateStepRecord } from "../lib/api";
import { compressLayerStackImage } from "../lib/images";
import { sectionNameAtGroupStart } from "../lib/template-sections";

function TemplateStepEditor({ template, step, sectionName, onSaved }: { template: TemplateDetail; step: TemplateStepRecord; sectionName: string | null; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(step.name);
  const [toolName, setToolName] = useState(step.toolName || "");
  const [parametersText, setParametersText] = useState(step.parametersText || "");
  const [commentsText, setCommentsText] = useState(step.commentsText || "");
  const [image, setImage] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [imageToDelete, setImageToDelete] = useState<string | null>(null);
  const [imageDeleteError, setImageDeleteError] = useState("");

  async function save() {
    setSaving(true); setError("");
    try {
      let assetKey: string | undefined;
      if (image) {
        const compressed = await compressLayerStackImage(image);
        assetKey = (await api.uploadAsset(compressed, compressed.name)).key;
      }
      await api.updateTemplateStep(template.id, step.id, { name, toolName, parametersText, commentsText, assetKey });
      setImage(null); setEditing(false); await onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function deleteImage() {
    if (!imageToDelete) return;
    setSaving(true); setImageDeleteError("");
    try {
      await api.deleteTemplateStepImage(template.id, step.id, imageToDelete);
      setImageToDelete(null);
      await onSaved();
    } catch (error) { setImageDeleteError((error as Error).message); }
    finally { setSaving(false); }
  }

  return <article className="card template-step-card">
    <div className="template-step-number">{step.stepNumber || step.position + 1}</div>
    <div className="template-step-body">
      <div className="card-title-row"><div><h3 className="card-title">{step.name}</h3>{sectionName && <span className="section-label">{sectionName}</span>}</div>{!template.locked && !template.archived && <button type="button" className="text-button" onClick={() => setEditing((value) => !value)}>{editing ? "Cancel" : "Edit"}</button>}</div>
      <div className="template-step-content">
        <dl className="template-detail-list"><dt>Tool</dt><dd>{step.toolName || "—"}</dd><dt>Parameters</dt><dd>{step.parametersText || "—"}</dd><dt>Comments</dt><dd>{step.commentsText || "—"}</dd></dl>
        {step.imageKeys.length > 0 && <><div className="run-start-structure-images">{step.imageKeys.map((key, index) => <a href={`/api/assets/${key}`} target="_blank" rel="noreferrer" key={key}><img src={`/api/assets/${key}`} alt={`Diagram ${index + 1} for ${step.name}`} /></a>)}</div><div className="template-diagram-summary"><span>{step.imageKeys.length} diagram{step.imageKeys.length === 1 ? "" : "s"} attached</span>{!template.locked && !template.archived && <div>{step.imageKeys.map((key, index) => <button type="button" className="text-button danger-text" key={key} onClick={() => { setImageDeleteError(""); setImageToDelete(key); }}>Remove diagram {index + 1}</button>)}</div>}</div></>}
      </div>
      {editing && <div className="step-form">
        <label>Step name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Tool<input value={toolName} onChange={(event) => setToolName(event.target.value)} /></label>
        <label>Parameters<textarea rows={3} value={parametersText} onChange={(event) => setParametersText(event.target.value)} /></label>
        <label>Comments<textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} /></label>
        <FileDropzone compact accept="image/*" file={image} onFile={setImage} label="Drop another diagram" />
        <button type="button" className="button primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save step"}</button>
      </div>}
      {error && <p className="error-banner">{error}</p>}
    </div>
    {imageToDelete && <ConfirmDeleteDialog title="Delete this template diagram?" description="The diagram will be removed from this editable process step. Existing process runs and shared file data will remain unchanged." summary={`${step.name} · diagram ${step.imageKeys.indexOf(imageToDelete) + 1}`} deleting={saving} error={imageDeleteError} eyebrow="Delete diagram" confirmLabel="Delete diagram" onCancel={() => { setImageToDelete(null); setImageDeleteError(""); }} onConfirm={() => void deleteImage()} />}
  </article>;
}

function NewTemplateStep({ templateId, onSaved }: { templateId: string; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [toolName, setToolName] = useState("");
  const [parametersText, setParametersText] = useState("");
  const [commentsText, setCommentsText] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    setSaving(true); setError("");
    try {
      let assetKey: string | undefined;
      if (image) {
        const compressed = await compressLayerStackImage(image);
        assetKey = (await api.uploadAsset(compressed, compressed.name)).key;
      }
      await api.createTemplateStep(templateId, { name, toolName, parametersText, commentsText, assetKey });
      setName(""); setToolName(""); setParametersText(""); setCommentsText(""); setImage(null); setOpen(false); await onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  if (!open) return <button type="button" className="button wide" onClick={() => setOpen(true)}>+ Add template step</button>;
  return <div className="card step-form new-template-step"><h3 className="card-title">Add template step</h3><label>Step name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Tool<input value={toolName} onChange={(event) => setToolName(event.target.value)} /></label><label>Parameters<textarea rows={3} value={parametersText} onChange={(event) => setParametersText(event.target.value)} /></label><label>Comments<textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} /></label><FileDropzone compact accept="image/*" file={image} onFile={setImage} label="Drop a diagram" />{error && <p className="error-banner">{error}</p>}<div className="form-actions"><button type="button" className="button" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="button primary" disabled={saving || !name.trim()} onClick={() => void add()}>{saving ? "Adding…" : "Add step"}</button></div></div>;
}

export function TemplatePage() {
  const { templateId = "" } = useParams();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const result = await api.getTemplate(templateId);
    setTemplate(result.template); setName(result.template.name); setVersion(result.template.version);
  }, [templateId]);
  useEffect(() => {
    setTemplate(null); setError("");
    void load().catch((error: Error) => setError(error.message));
  }, [load]);

  async function saveMetadata() {
    setSaving(true); setError("");
    try { await api.updateTemplate(templateId, { name, version }); await load(); }
    catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function clone() {
    setSaving(true); setError("");
    try { const created = await api.cloneTemplate(templateId); navigate(`/templates/${created.id}`); }
    catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function remove() {
    const message = template?.locked
      ? "Archive this template version? Existing process runs and history will remain unchanged, but it can no longer be used to start a run."
      : "Permanently delete this unused template version? Its import source and shared files will be retained.";
    if (!window.confirm(message)) return;
    setSaving(true); setError("");
    try { await api.removeTemplate(templateId); navigate("/templates"); }
    catch (error) { setError((error as Error).message); setSaving(false); }
  }

  if (!template) return <div className="page"><p>{error || "Loading template…"}</p></div>;
  const editable = !template.locked && !template.archived;
  return <div className="page template-detail-page">
    <Link className="back-link" to="/templates">← Process templates</Link>
    <div className="page-heading"><div><p className="eyebrow">Process template · v{template.version}</p><h1>{template.name}</h1><p className="lead">{template.sourceFilename || "Manually created version"}</p></div><div className="header-actions"><button className="button" disabled={saving} onClick={() => void clone()}>{saving ? "Working…" : "Clone as new version"}</button><button className="button danger" disabled={saving} onClick={() => void remove()}>{template.locked ? "Archive" : "Delete"}</button></div></div>
    {template.locked && <p className="info-banner">This version was first used on {template.lockedAt ? new Date(template.lockedAt).toLocaleString() : "an earlier run"} and is now immutable. Clone it to make changes.</p>}
    {editable && <section className="card template-metadata-editor"><h2 className="card-title">Editable version details</h2><div className="step-field-row"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Version<input type="number" min="1" step="1" value={version} onChange={(event) => setVersion(Number(event.target.value))} /></label></div><button className="button primary" disabled={saving} onClick={() => void saveMetadata()}>{saving ? "Saving…" : "Save version details"}</button></section>}
    {error && <p className="error-banner">{error}</p>}
    <section className="card initial-state-preview"><div className="card-copy"><div className="card-title-line"><h2 className="card-title">Initial substrate</h2><span className="meta-badge">Step 0</span></div><p className="card-value">{template.initialSubstrateStep ? "Substrate Stack" : template.initialStateHash ? "Legacy substrate definition" : "Substrate Stack missing"}</p>{template.initialSubstrateStep ? <SubstrateStepDetails step={template.initialSubstrateStep} /> : <p className="card-meta">{template.initialStateHash ? "This older version has a stored structure but no Step 0 metadata." : "Re-import this version with Step 0 named Substrate Stack before using it for a run transition."}</p>}<p className="card-meta">{template.initialStateImageKeys.length ? `${template.initialStateImageKeys.length} substrate diagram${template.initialStateImageKeys.length === 1 ? "" : "s"} attached` : "No substrate diagram attached"}</p></div><div className="initial-state-preview-images">{template.initialStateImageKeys.length ? template.initialStateImageKeys.map((key, index) => <a href={`/api/assets/${key}`} target="_blank" rel="noreferrer" key={key}><img className="layer-thumbnail" src={`/api/assets/${key}`} alt={`Initial substrate diagram ${index + 1}`} /></a>) : <div className="layer-placeholder">{template.initialSubstrateStep ? "Step 0 has no diagram" : "No initial structure"}</div>}</div></section>
    <section className="template-steps-section"><div className="section-heading"><div><h2>Process steps</h2><p>Executable steps in this template version.</p></div><span className="section-count">{template.steps.length}</span></div>{template.steps.map((step, index) => <TemplateStepEditor key={step.id} template={template} step={step} sectionName={sectionNameAtGroupStart(template.steps, index)} onSaved={load} />)}{editable && <NewTemplateStep templateId={template.id} onSaved={load} />}</section>
  </div>;
}
