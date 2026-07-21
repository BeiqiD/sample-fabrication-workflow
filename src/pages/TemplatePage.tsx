import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FileDropzone } from "../components/FileDropzone";
import { api, type TemplateDetail, type TemplateStepRecord } from "../lib/api";
import { compressLayerStackImage } from "../lib/images";

function TemplateStepEditor({ template, step, onSaved }: { template: TemplateDetail; step: TemplateStepRecord; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(step.name);
  const [toolName, setToolName] = useState(step.toolName || "");
  const [parametersText, setParametersText] = useState(step.parametersText || "");
  const [commentsText, setCommentsText] = useState(step.commentsText || "");
  const [image, setImage] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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

  return <article className="card template-step-card">
    <div className="template-step-number">{step.stepNumber || step.position + 1}</div>
    <div className="template-step-body">
      <div className="card-title-row"><div><h2>{step.name}</h2>{step.sectionName && <span className="section-label">{step.sectionName}</span>}</div>{!template.locked && !template.archived && <button type="button" className="text-button" onClick={() => setEditing((value) => !value)}>{editing ? "Cancel" : "Edit"}</button>}</div>
      <dl className="template-detail-list"><dt>Tool</dt><dd>{step.toolName || "—"}</dd><dt>Parameters</dt><dd>{step.parametersText || "—"}</dd><dt>Comments</dt><dd>{step.commentsText || "—"}</dd></dl>
      {step.imageKeys.length > 0 && <div className="diagram-gallery">{step.imageKeys.map((key) => <a key={key} href={`/api/assets/${key}`} target="_blank" rel="noreferrer"><img src={`/api/assets/${key}`} alt={`Diagram for ${step.name}`} /></a>)}</div>}
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
  return <div className="card step-form new-template-step"><h2>Add template step</h2><label>Step name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Tool<input value={toolName} onChange={(event) => setToolName(event.target.value)} /></label><label>Parameters<textarea rows={3} value={parametersText} onChange={(event) => setParametersText(event.target.value)} /></label><label>Comments<textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} /></label><FileDropzone compact accept="image/*" file={image} onFile={setImage} label="Drop a diagram" />{error && <p className="error-banner">{error}</p>}<div className="form-actions"><button type="button" className="button" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="button primary" disabled={saving || !name.trim()} onClick={() => void add()}>{saving ? "Adding…" : "Add step"}</button></div></div>;
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
      ? "Archive this assigned template version? Existing sample runs and history will remain unchanged, but it can no longer be assigned."
      : "Permanently delete this unused template version? Its import source and shared files will be retained.";
    if (!window.confirm(message)) return;
    setSaving(true); setError("");
    try { await api.removeTemplate(templateId); navigate("/templates"); }
    catch (error) { setError((error as Error).message); setSaving(false); }
  }

  if (!template) return <div className="page narrow-page"><p>{error || "Loading template…"}</p></div>;
  const editable = !template.locked && !template.archived;
  return <div className="page narrow-page">
    <Link className="back-link" to="/templates">← Templates</Link>
    <div className="page-heading"><div><p className="eyebrow">{template.templateType} · v{template.version}</p><h1>{template.name}</h1><p className="lead">{template.sourceFilename || "Manually created version"}</p></div><div className="header-actions"><button className="button" disabled={saving} onClick={() => void clone()}>{saving ? "Working…" : "Clone as new version"}</button><button className="button danger" disabled={saving} onClick={() => void remove()}>{template.locked ? "Archive" : "Delete"}</button></div></div>
    {template.locked && <p className="info-banner">This version was assigned on {template.lockedAt ? new Date(template.lockedAt).toLocaleString() : "an earlier run"} and is now immutable. Clone it to make changes.</p>}
    {editable && <section className="card template-metadata-editor"><h2>Editable version details</h2><div className="step-field-row"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Version<input type="number" min="1" step="1" value={version} onChange={(event) => setVersion(Number(event.target.value))} /></label></div><button className="button primary" disabled={saving} onClick={() => void saveMetadata()}>{saving ? "Saving…" : "Save version details"}</button></section>}
    {error && <p className="error-banner">{error}</p>}
    <section className="template-steps-section"><div className="section-heading"><h2>Complete template</h2><span>{template.steps.length} steps</span></div>{template.steps.map((step) => <TemplateStepEditor key={step.id} template={template} step={step} onSaved={load} />)}{editable && <NewTemplateStep templateId={template.id} onSaved={load} />}</section>
  </div>;
}
