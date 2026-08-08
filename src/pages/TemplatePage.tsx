import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { DiagramGallery } from "../components/MultiSampleRunGrid";
import { SubstrateStepDetails } from "../components/SubstrateStepDetails";
import { FileDropzone } from "../components/FileDropzone";
import { api, type TemplateDetail, type TemplateStepRecord } from "../lib/api";
import { compressLayerStackImage } from "../lib/images";
import { templateDetailPath } from "../lib/templateRoutes";
import { sectionHeaderAtGroupStart } from "../lib/template-sections";
import "../template-page-layout.css";

function TemplateStepEditor({ template, step, onSaved }: { template: TemplateDetail; step: TemplateStepRecord; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(step.name);
  const [toolName, setToolName] = useState(step.toolName || "");
  const [parametersText, setParametersText] = useState(step.parametersText || "");
  const [commentsText, setCommentsText] = useState(step.commentsText || "");
  const [image, setImage] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  function beginEdit() {
    setName(step.name);
    setToolName(step.toolName || "");
    setParametersText(step.parametersText || "");
    setCommentsText(step.commentsText || "");
    setImage(null);
    setError("");
    setEditing(true);
  }

  function cancelEdit() {
    setName(step.name);
    setToolName(step.toolName || "");
    setParametersText(step.parametersText || "");
    setCommentsText(step.commentsText || "");
    setImage(null);
    setError("");
    setEditing(false);
  }

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

  async function deleteStep() {
    setSaving(true); setDeleteError("");
    try {
      await api.deleteTemplateStep(template.id, step.id);
      setConfirmingDelete(false);
      await onSaved();
    } catch (error) { setDeleteError((error as Error).message); }
    finally { setSaving(false); }
  }

  return <article className={`card template-step-card${editing ? " is-editing" : ""}`}>
    <div className="template-step-number">{step.stepNumber || step.position + 1}</div>
    <div className="template-step-body">
      <div className="card-title-row">
        {editing
          ? <div className="template-step-heading-editor">
            <label className="template-step-heading-control">
              <span>Step name</span>
              <input className="template-step-title-input" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="template-step-heading-control">
              <span>Tool</span>
              <input className="template-step-tool-input" value={toolName} placeholder="Optional" onChange={(event) => setToolName(event.target.value)} />
            </label>
          </div>
          : <div><h3 className="card-title">{step.name}</h3>{step.toolName && <p className="template-step-tool">{step.toolName}</p>}</div>}
        {!template.locked && !template.archived && <div className="template-step-actions">
          <button type="button" className="text-button" onClick={editing ? cancelEdit : beginEdit}>{editing ? "Cancel" : "Edit"}</button>
          <button type="button" className="text-button danger-text" onClick={() => { setDeleteError(""); setConfirmingDelete(true); }}>Delete step</button>
        </div>}
      </div>
      <div className={step.imageKeys.length > 0 ? "template-step-content has-diagrams" : "template-step-content"}>
        {editing
          ? <div className="template-step-fields template-step-fields-edit">
            <label className="template-step-field">
              <span>Parameters</span>
              <textarea rows={3} value={parametersText} onChange={(event) => setParametersText(event.target.value)} />
            </label>
            <label className="template-step-field">
              <span>Comments</span>
              <textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} />
            </label>
            <div className="template-step-edit-extras">
              <FileDropzone compact accept="image/*" file={image} onFile={setImage} label="Drop another diagram" />
              <div className="template-step-edit-actions"><button type="button" className="button primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save step"}</button></div>
            </div>
          </div>
          : <div className="template-step-fields template-step-fields-view">
            <div className="template-step-field"><span>Parameters</span><p>{step.parametersText || "—"}</p></div>
            <div className="template-step-field"><span>Comments</span><p>{step.commentsText || "—"}</p></div>
          </div>}
        {step.imageKeys.length > 0 && <DiagramGallery keys={step.imageKeys} label={step.name} className="template-diagram-gallery" />}
      </div>
      {error && <p className="error-banner">{error}</p>}
    </div>
    {confirmingDelete && <ConfirmDeleteDialog title="Delete this template step?" description="The complete step, including all of its diagrams, will be removed from this unused template version. Shared file data will remain unchanged." summary={step.name} deleting={saving} error={deleteError} eyebrow="Delete step" confirmLabel="Delete step" onCancel={() => { setConfirmingDelete(false); setDeleteError(""); }} onConfirm={() => void deleteStep()} />}
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
  const location = useLocation();
  const locationSearchRef = useRef(location.search);
  locationSearchRef.current = location.search;
  const navigate = useNavigate();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const load = useCallback(async () => {
    const result = await api.getTemplate(templateId);
    if (result.template.templateKind === "metrology") {
      navigate(`${templateDetailPath(templateId, "metrology")}${locationSearchRef.current}`, { replace: true });
      return;
    }
    setTemplate(result.template); setName(result.template.name); setVersion(result.template.version);
  }, [navigate, templateId]);
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
    setSaving(true); setRemoveError("");
    try {
      await api.removeTemplate(templateId);
      setConfirmingRemoval(false);
      navigate("/templates");
    } catch (error) {
      setRemoveError((error as Error).message);
      setSaving(false);
    }
  }

  if (!template) return <div className="page"><p>{error || "Loading template…"}</p></div>;
  const editable = !template.locked && !template.archived;
  const removalIsArchive = template.locked;
  return <div className="page template-detail-page">
    <Link className="back-link" to="/templates">← Templates</Link>
    <div className="page-heading"><div><p className="eyebrow">Process template · v{template.version}</p><h1>{template.name}</h1><p className="lead">{template.sourceFilename || "Manually created version"}</p></div><div className="header-actions"><button className="button" disabled={saving} onClick={() => void clone()}>{saving ? "Working…" : "Clone as new version"}</button><button className="button danger" disabled={saving} onClick={() => { setRemoveError(""); setConfirmingRemoval(true); }}>{removalIsArchive ? "Archive" : "Delete"}</button></div></div>
    {template.locked && <p className="info-banner">This version was first used on {template.lockedAt ? new Date(template.lockedAt).toLocaleString() : "an earlier run"} and is now immutable. Clone it to make changes.</p>}
    {editable && <section className="card template-metadata-editor"><h2 className="card-title">Editable version details</h2><div className="step-field-row"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Version<input type="number" min="1" step="1" value={version} onChange={(event) => setVersion(Number(event.target.value))} /></label></div><button className="button primary" disabled={saving} onClick={() => void saveMetadata()}>{saving ? "Saving…" : "Save version details"}</button></section>}
    {error && <p className="error-banner">{error}</p>}
    <section className={template.initialStateImageKeys.length ? "card template-initial-state has-diagrams" : "card template-initial-state"}><div className="card-copy"><div className="card-title-line"><h2 className="card-title">Initial substrate</h2><span className="meta-badge">Step 0</span></div><p className="card-value">{template.initialSubstrateStep ? "Substrate Stack" : template.initialStateHash ? "Legacy substrate definition" : "Substrate Stack missing"}</p>{template.initialSubstrateStep ? <SubstrateStepDetails step={template.initialSubstrateStep} /> : <p className="card-meta">{template.initialStateHash ? "This older version has a stored structure but no Step 0 metadata." : "Re-import this version with Step 0 named Substrate Stack before starting a run from it."}</p>}{!template.initialStateImageKeys.length && <p className="card-meta">No substrate diagram attached</p>}</div>{template.initialStateImageKeys.length > 0 && <DiagramGallery keys={template.initialStateImageKeys} label="Initial substrate" size="wide" className="template-diagram-gallery" />}</section>
    <section className="template-steps-section"><div className="section-heading"><div><h2>Process steps</h2><p>Executable steps in this template version.</p></div><span className="section-count">{template.steps.length}</span></div>{template.steps.map((step, index) => {
      const sectionLabel = sectionHeaderAtGroupStart(template.steps, index);
      return <Fragment key={step.id}>{sectionLabel && <div className="process-section-header template-section-header">{sectionLabel}</div>}<TemplateStepEditor template={template} step={step} onSaved={load} /></Fragment>;
    })}{editable && <NewTemplateStep templateId={template.id} onSaved={load} />}</section>
    {confirmingRemoval && <ConfirmDeleteDialog
      title={removalIsArchive ? "Archive this template version?" : "Delete this template version?"}
      description={removalIsArchive
        ? "Existing process runs and history will remain unchanged, but this version can no longer be used to start a run."
        : "This unused template version will be permanently deleted. Its import source and shared files will be retained."}
      summary={`${template.name} · v${template.version}`}
      deleting={saving}
      error={removeError}
      eyebrow={removalIsArchive ? "Archive template" : "Delete template"}
      confirmLabel={removalIsArchive ? "Archive" : "Delete template"}
      onCancel={() => { setConfirmingRemoval(false); setRemoveError(""); }}
      onConfirm={() => void remove()}
    />}
  </div>;
}
