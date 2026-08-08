import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { FileDropzone } from "../components/FileDropzone";
import { MetrologyTemplateForm } from "../components/MetrologyTemplateForm";
import { MetrologyReferenceSourceFocus } from "../components/ReferenceSourceFocus";
import { api, type MetrologyTemplateInput, type TemplateDetail } from "../lib/api";
import { shouldAutoFocusPageField } from "../lib/page-load-autofocus";
import { templateDetailPath } from "../lib/templateRoutes";

export function MetrologyTemplatePage() {
  const { templateId = "" } = useParams();
  const location = useLocation();
  const locationSearchRef = useRef(location.search);
  locationSearchRef.current = location.search;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedFocus = searchParams.get("focus");
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmingTemplateDeletion, setConfirmingTemplateDeletion] = useState(false);
  const [templateDeleteError, setTemplateDeleteError] = useState("");
  const [referenceNotes, setReferenceNotes] = useState("");
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [savingReference, setSavingReference] = useState(false);
  const [referenceToDelete, setReferenceToDelete] = useState<{ id: string; filename: string } | null>(null);
  const [referenceDeleteError, setReferenceDeleteError] = useState("");
  const load = useCallback(async (syncReferenceNotes = true) => {
    const result = await api.getTemplate(templateId);
    if (result.template.templateKind !== "metrology") {
      navigate(`${templateDetailPath(templateId, "process")}${locationSearchRef.current}`, { replace: true });
      return;
    }
    if (result.template.steps.length !== 1) {
      throw new Error("This is not a valid metrology template.");
    }
    setTemplate(result.template);
    if (syncReferenceNotes) setReferenceNotes(result.template.metrologyNotes || "");
  }, [navigate, templateId]);
  useEffect(() => { void load(true).catch((error: Error) => setError(error.message)); }, [load]);

  async function update(input: MetrologyTemplateInput) {
    await api.updateMetrologyTemplate(templateId, input);
    await load(false);
    setNotice("Template details saved.");
  }

  async function saveReferenceNotes() {
    setSavingReference(true); setError(""); setNotice("");
    try {
      await api.updateMetrologyTemplateNotes(templateId, referenceNotes);
      await load();
      setNotice("Equipment and method notes saved.");
    } catch (error) { setError((error as Error).message); }
    finally { setSavingReference(false); }
  }

  async function uploadReference() {
    if (!referenceFile) return;
    setSavingReference(true); setError(""); setNotice("");
    try {
      await api.uploadMetrologyTemplateReference(templateId, referenceFile);
      setReferenceFile(null);
      await load(false);
      setNotice("Reference file attached.");
    } catch (error) { setError((error as Error).message); }
    finally { setSavingReference(false); }
  }

  async function deleteReference() {
    if (!referenceToDelete) return;
    setSavingReference(true); setReferenceDeleteError(""); setNotice("");
    try {
      await api.deleteMetrologyTemplateReference(templateId, referenceToDelete.id);
      setReferenceToDelete(null);
      await load(false);
      setNotice("Reference file removed.");
    } catch (error) { setReferenceDeleteError((error as Error).message); }
    finally { setSavingReference(false); }
  }

  async function remove() {
    if (!template) return;
    setDeleting(true); setTemplateDeleteError("");
    try {
      await api.removeTemplate(template.id);
      setConfirmingTemplateDeletion(false);
      navigate("/templates");
    } catch (error) {
      setTemplateDeleteError((error as Error).message);
      setDeleting(false);
    }
  }

  if (!template) return <div className="page"><p>{error || "Loading metrology template…"}</p></div>;
  const step = template.steps[0];
  return <div className="page metrology-template-page">
    <Link className="back-link" to="/templates">← Templates</Link>
    <div className="page-heading">
      <div><p className="eyebrow">Metrology template</p><h1>{template.name}</h1><p className="lead">A flat reusable record. Runs keep their own snapshot when this template is used.</p></div>
      <button type="button" className="button danger" disabled={deleting} onClick={() => { setTemplateDeleteError(""); setConfirmingTemplateDeletion(true); }}>{deleting ? "Deleting…" : "Delete"}</button>
    </div>
    {error && <p className="error-banner">{error}</p>}
    {notice && <p className="success-banner">{notice}</p>}
    <MetrologyTemplateForm
      title="Template details"
      submitLabel="Save changes"
      autoFocusTitle={shouldAutoFocusPageField()}
      initialValue={{
        name: template.name,
        toolName: step.toolName || "",
        parametersText: step.parametersText || "",
        commentsText: step.commentsText || "",
      }}
      onCancel={() => navigate("/templates")}
      onSubmit={update}
    />
    <section className="card metrology-reference-card">
      <div className="card-copy">
        <p className="card-label">Template reference</p>
        <h2 className="card-title">Equipment / method notes</h2>
        <p className="card-meta">Only shown on this template page. These notes and files are never copied into a run.</p>
      </div>
      <label>Reference notes<textarea rows={7} value={referenceNotes} onChange={(event) => setReferenceNotes(event.target.value)} placeholder="Operating notes, instrument-specific reminders, contacts, or method guidance…" /></label>
      <div className="form-actions reference-note-actions">
        <button type="button" className="button primary" disabled={savingReference} onClick={() => void saveReferenceNotes()}>{savingReference ? "Saving…" : "Save reference notes"}</button>
      </div>
      <div className="metrology-reference-upload">
        <FileDropzone accept="*/*" file={referenceFile} onFile={setReferenceFile} label="Attach an equipment manual or reference file" hint="PDF, image, spreadsheet, document, or other reference file · up to 25 MB" />
        {referenceFile && <button type="button" className="button" disabled={savingReference} onClick={() => void uploadReference()}>{savingReference ? "Uploading…" : "Upload reference"}</button>}
      </div>
      {template.referenceAttachments.length > 0 && <div className="metrology-reference-list">
        <small>Reference files</small>
        {template.referenceAttachments.map((reference) => <div className="metrology-reference-item" key={reference.id}>
          <a href={`/api/assets/${reference.assetKey}`} target="_blank" rel="noreferrer"><strong>{reference.filename}</strong><small>{reference.mimeType} · {reference.byteSize < 1024 * 1024 ? `${Math.max(1, Math.round(reference.byteSize / 1024))} KB` : `${(reference.byteSize / (1024 * 1024)).toFixed(1)} MB`}</small></a>
          <button type="button" className="text-button danger-text" disabled={savingReference} onClick={() => { setReferenceDeleteError(""); setReferenceToDelete({ id: reference.id, filename: reference.filename }); }}>Remove</button>
        </div>)}
      </div>}
      <MetrologyReferenceSourceFocus focusValue={requestedFocus} template={template} />
    </section>
    {referenceToDelete && <ConfirmDeleteDialog
      title="Remove this template reference?"
      description="The reference file will be detached from this template. Existing metrology runs are unaffected."
      summary={referenceToDelete.filename}
      deleting={savingReference}
      error={referenceDeleteError}
      eyebrow="Remove reference"
      confirmLabel="Remove reference"
      onCancel={() => { setReferenceToDelete(null); setReferenceDeleteError(""); }}
      onConfirm={() => void deleteReference()}
    />}
    {confirmingTemplateDeletion && <ConfirmDeleteDialog
      title={`Delete ${template.name}?`}
      description="The metrology template will be removed from future use. Existing records and runs will remain unchanged."
      summary={template.name}
      deleting={deleting}
      error={templateDeleteError}
      eyebrow="Delete metrology template"
      confirmLabel="Delete template"
      onCancel={() => { setConfirmingTemplateDeletion(false); setTemplateDeleteError(""); }}
      onConfirm={() => void remove()}
    />}
  </div>;
}
