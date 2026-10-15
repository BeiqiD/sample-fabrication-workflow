import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { DiagramGallery } from "../components/MultiSampleRunGrid";
import { SubstrateStepDetails } from "../components/SubstrateStepDetails";
import { FileDropzone } from "../components/FileDropzone";
import { ReadStatus } from "../components/ReadStatus";
import { api, type TemplateDetail, type TemplateStepRecord } from "../lib/api";
import { discardR2Upload, prepareR2UploadFile, R2UploadRequestError } from "../lib/r2-upload-client";
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
  const [uploadProblem, setUploadProblem] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  function beginEdit() {
    if (saving) return;
    setName(step.name);
    setToolName(step.toolName || "");
    setParametersText(step.parametersText || "");
    setCommentsText(step.commentsText || "");
    setImage(null);
    setUploadProblem(false);
    setError("");
    setEditing(true);
  }

  function cancelEdit() {
    if (saving) return;
    setName(step.name);
    setToolName(step.toolName || "");
    setParametersText(step.parametersText || "");
    setCommentsText(step.commentsText || "");
    setImage(null);
    setError("");
    setUploadProblem(false);
    setEditing(false);
  }

  async function save() {
    if (saving) return;
    setSaving(true); setError(""); setUploadProblem(false);
    try {
      let assetKey: string | undefined;
      let assetId: string | undefined;
      if (image) {
        const context = `template-step:${template.id}:${step.id}`;
        const compressed = await prepareR2UploadFile(image, context, () => compressLayerStackImage(image));
        const uploaded = await api.uploadAsset(compressed, compressed.name, { context });
        if (uploaded.key === null) assetId = uploaded.id; else assetKey = uploaded.key;
      }
      await api.updateTemplateStep(template.id, step.id, { name, toolName, parametersText, commentsText, assetKey, assetId });
      setImage(null); setEditing(false); await onSaved();
    } catch (error) { setError((error as Error).message); setUploadProblem(error instanceof R2UploadRequestError); }
    finally { setSaving(false); }
  }

  async function deleteStep() {
    if (saving) return;
    setSaving(true); setDeleteError("");
    try {
      await api.deleteTemplateStep(template.id, step.id);
      setConfirmingDelete(false);
      await onSaved();
    } catch (error) { setDeleteError((error as Error).message); }
    finally { setSaving(false); }
  }

  return <article className={`card template-step-card${editing ? " is-editing" : ""}`} aria-busy={saving}>
    <div className="template-step-number">{step.stepNumber || step.position + 1}</div>
    <div className="template-step-body">
      <div className="card-title-row">
        {editing
          ? <div className="template-step-heading-editor">
            <label className="template-step-heading-control">
              <span>Step name</span>
              <input className="template-step-title-input" value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="template-step-heading-control">
              <span>Tool</span>
              <input className="template-step-tool-input" value={toolName} disabled={saving} placeholder="Optional" onChange={(event) => setToolName(event.target.value)} />
            </label>
          </div>
          : <div><h3 className="card-title">{step.name}</h3>{step.toolName && <p className="template-step-tool">{step.toolName}</p>}</div>}
        {!template.locked && !template.archived && <div className="template-step-actions">
          <button type="button" className="text-button" disabled={saving} onClick={editing ? cancelEdit : beginEdit}>{editing ? "Cancel" : "Edit"}</button>
          <button type="button" className="text-button danger-text" disabled={saving} onClick={() => { setDeleteError(""); setConfirmingDelete(true); }}>Delete step</button>
        </div>}
      </div>
      <div className={(step.imageKeys.length > 0 || Boolean(step.images?.length)) ? "template-step-content has-diagrams" : "template-step-content"}>
        {editing
          ? <div className="template-step-fields template-step-fields-edit">
            <label className="template-step-field">
              <span>Parameters</span>
              <textarea rows={3} value={parametersText} disabled={saving} onChange={(event) => setParametersText(event.target.value)} />
            </label>
            <label className="template-step-field">
              <span>Comments</span>
              <textarea rows={3} value={commentsText} disabled={saving} onChange={(event) => setCommentsText(event.target.value)} />
            </label>
            <div className="template-step-edit-extras">
              <FileDropzone compact accept="image/*" file={image} disabled={saving} onFile={setImage} label="Drop another diagram" />
              <div className="template-step-edit-actions"><button type="button" className="button primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save step"}</button></div>
            </div>
          </div>
          : <div className="template-step-fields template-step-fields-view">
            <div className="template-step-field"><span>Parameters</span><p>{step.parametersText || "—"}</p></div>
            <div className="template-step-field"><span>Comments</span><p>{step.commentsText || "—"}</p></div>
          </div>}
        {(step.imageKeys.length > 0 || Boolean(step.images?.length)) && <DiagramGallery keys={step.imageKeys} images={step.images} label={step.name} className="template-diagram-gallery" />}
      </div>
      {saving && <p className="visually-hidden" role="status">{confirmingDelete ? "Deleting template step…" : "Saving template step…"}</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {uploadProblem && <div className="form-actions"><small>The previous upload may still finish. Discarding lets you choose a new upload.</small><button type="button" className="button" disabled={saving} onClick={() => { try { discardR2Upload("ordinary_image", `template-step:${template.id}:${step.id}`); setImage(null); setError(""); setUploadProblem(false); } catch (caught) { setError((caught as Error).message); } }}>Discard upload</button></div>}
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
  const [uploadProblem, setUploadProblem] = useState(false);

  async function add() {
    if (saving) return;
    setSaving(true); setError(""); setUploadProblem(false);
    try {
      let assetKey: string | undefined;
      let assetId: string | undefined;
      if (image) {
        const context = `template-new-step:${templateId}`;
        const compressed = await prepareR2UploadFile(image, context, () => compressLayerStackImage(image));
        const uploaded = await api.uploadAsset(compressed, compressed.name, { context });
        if (uploaded.key === null) assetId = uploaded.id; else assetKey = uploaded.key;
      }
      await api.createTemplateStep(templateId, { name, toolName, parametersText, commentsText, assetKey, assetId });
      setName(""); setToolName(""); setParametersText(""); setCommentsText(""); setImage(null); setOpen(false); await onSaved();
    } catch (error) { setError((error as Error).message); setUploadProblem(error instanceof R2UploadRequestError); }
    finally { setSaving(false); }
  }

  if (!open) return <button type="button" className="button wide" onClick={() => setOpen(true)}>+ Add template step</button>;
  return <div className="card step-form new-template-step" aria-busy={saving}>
    <h3 className="card-title">Add template step</h3>
    <label>Step name<input value={name} disabled={saving} onChange={(event) => setName(event.target.value)} /></label>
    <label>Tool<input value={toolName} disabled={saving} onChange={(event) => setToolName(event.target.value)} /></label>
    <label>Parameters<textarea rows={3} value={parametersText} disabled={saving} onChange={(event) => setParametersText(event.target.value)} /></label>
    <label>Comments<textarea rows={3} value={commentsText} disabled={saving} onChange={(event) => setCommentsText(event.target.value)} /></label>
    <FileDropzone compact accept="image/*" file={image} disabled={saving} onFile={setImage} label="Drop a diagram" />
    {saving && <p className="visually-hidden" role="status">Adding template step…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {uploadProblem && <div className="form-actions"><small>The previous upload may still finish. Discarding lets you choose a new upload.</small><button type="button" className="button" disabled={saving} onClick={() => { try { discardR2Upload("ordinary_image", `template-new-step:${templateId}`); setImage(null); setError(""); setUploadProblem(false); } catch (caught) { setError((caught as Error).message); } }}>Discard upload</button></div>}
    <div className="form-actions"><button type="button" className="button" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button type="button" className="button primary" disabled={saving || !name.trim()} onClick={() => void add()}>{saving ? "Adding…" : "Add step"}</button></div>
  </div>;
}

export function TemplatePage() {
  const { templateId = "" } = useParams();
  return <TemplateSession key={templateId} templateId={templateId} />;
}

function TemplateSession({ templateId }: { templateId: string }) {
  const location = useLocation();
  const locationSearchRef = useRef(location.search);
  locationSearchRef.current = location.search;
  const navigate = useNavigate();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const sessionActive = useRef(true);
  const loadSequence = useRef(0);
  const load = useCallback(async () => {
    if (!sessionActive.current) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setReadError("");
    try {
      const result = await api.getTemplate(templateId);
      if (!sessionActive.current || sequence !== loadSequence.current) return;
      if (result.template.templateKind === "metrology") {
        navigate(`${templateDetailPath(templateId, "metrology")}${locationSearchRef.current}`, { replace: true });
        return;
      }
      setTemplate(result.template); setName(result.template.name); setVersion(result.template.version);
    } catch (caught) {
      if (!sessionActive.current || sequence !== loadSequence.current) return;
      setReadError((caught as Error).message);
      throw caught;
    } finally {
      if (sessionActive.current && sequence === loadSequence.current) setLoading(false);
    }
  }, [navigate, templateId]);
  useEffect(() => {
    sessionActive.current = true;
    setTemplate(null); setError("");
    void load().catch(() => undefined);
    return () => { sessionActive.current = false; loadSequence.current += 1; };
  }, [load]);

  async function saveMetadata() {
    if (saving) return;
    setSaving(true); setError("");
    try { await api.updateTemplate(templateId, { name, version }); await load(); }
    catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function clone() {
    if (saving) return;
    setSaving(true); setError("");
    try { const created = await api.cloneTemplate(templateId); if (sessionActive.current) navigate(`/templates/${created.id}`); }
    catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (saving) return;
    setSaving(true); setRemoveError("");
    try {
      await api.removeTemplate(templateId);
      if (!sessionActive.current) return;
      setConfirmingRemoval(false);
      navigate("/templates");
    } catch (error) {
      setRemoveError((error as Error).message);
      setSaving(false);
    }
  }

  if (!template) return <div className="page">
    <Link className="back-link" to="/templates">← Templates</Link>
    <ReadStatus loading={loading} error={readError} loadingMessage="Loading template…" errorTitle="Template could not be loaded" retryLabel="Retry template" onRetry={() => void load().catch(() => undefined)} />
  </div>;
  const editable = !template.locked && !template.archived;
  const removalIsArchive = template.locked;
  return <div className="page template-detail-page">
    <Link className="back-link" to="/templates">← Templates</Link>
    <div className="page-heading"><div><p className="eyebrow">Process template · v{template.version}</p><h1>{template.name}</h1><p className="lead">{template.sourceFilename || "Manually created version"}</p></div><div className="header-actions"><button className="button" disabled={saving} onClick={() => void clone()}>{saving ? "Working…" : "Clone as new version"}</button><button className="button danger" disabled={saving} onClick={() => { setRemoveError(""); setConfirmingRemoval(true); }}>{removalIsArchive ? "Archive" : "Delete"}</button></div></div>
    {template.locked && <p className="info-banner">This version was first used on {template.lockedAt ? new Date(template.lockedAt).toLocaleString() : "an earlier run"} and is now immutable. Clone it to make changes.</p>}
    {editable && <section className="card template-metadata-editor" aria-busy={saving}><h2 className="card-title">Editable version details</h2><div className="step-field-row"><label>Name<input value={name} disabled={saving} onChange={(event) => setName(event.target.value)} /></label><label>Version<input type="number" min="1" step="1" value={version} disabled={saving} onChange={(event) => setVersion(Number(event.target.value))} /></label></div><button className="button primary" disabled={saving} onClick={() => void saveMetadata()}>{saving ? "Saving…" : "Save version details"}</button></section>}
    <ReadStatus loading={loading} error={readError} loadingMessage="Refreshing template…" errorTitle="Template could not be refreshed" retryLabel="Retry template" onRetry={() => void load().catch(() => undefined)} />
    {error && <p className="error-banner" role="alert">{error}</p>}
    <section className={(template.initialStateImageKeys.length + (template.initialStateImages?.length ?? 0)) ? "card template-initial-state has-diagrams" : "card template-initial-state"}><div className="card-copy"><div className="card-title-line"><h2 className="card-title">Initial substrate</h2><span className="meta-badge">Step 0</span></div><p className="card-value">{template.initialSubstrateStep ? "Substrate Stack" : template.initialStateHash ? "Legacy substrate definition" : "Substrate Stack missing"}</p>{template.initialSubstrateStep ? <SubstrateStepDetails step={template.initialSubstrateStep} /> : <p className="card-meta">{template.initialStateHash ? "This older version has a stored structure but no Step 0 metadata." : "Re-import this version with Step 0 named Substrate Stack before starting a run from it."}</p>}{!(template.initialStateImageKeys.length + (template.initialStateImages?.length ?? 0)) && <p className="card-meta">No substrate diagram attached</p>}</div>{(template.initialStateImageKeys.length + (template.initialStateImages?.length ?? 0)) > 0 && <DiagramGallery keys={template.initialStateImageKeys} images={template.initialStateImages} label="Initial substrate" size="wide" className="template-diagram-gallery" />}</section>
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
