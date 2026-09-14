import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { FileDropzone } from "../components/FileDropzone";
import { MetrologyTemplateForm } from "../components/MetrologyTemplateForm";
import { MetrologyReferenceSourceFocus } from "../components/ReferenceSourceFocus";
import { api, type MetrologyTemplateInput, type TemplateDetail } from "../lib/api";
import { discardMetrologyReferenceUpload, finishMetrologyReferenceUpload, MetrologyReferenceUploadError, savedMetrologyReferenceUploadFilename } from "../lib/metrology-reference-upload-client";
import { shouldAutoFocusPageField } from "../lib/page-load-autofocus";
import { templateDetailPath } from "../lib/templateRoutes";

export function MetrologyTemplatePage() {
  const { templateId = "" } = useParams();
  // A different source starts a new editing session; focus/history changes for
  // the same source keep its draft, pending file, and local feedback intact.
  return <MetrologyTemplateSession key={templateId} templateId={templateId} />;
}

function MetrologyTemplateSession({ templateId }: { templateId: string }) {
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
  const [referenceUploadProblem, setReferenceUploadProblem] = useState(false);
  const [referenceUploadRecoveryName, setReferenceUploadRecoveryName] = useState<string | null>(null);
  const [referenceToDelete, setReferenceToDelete] = useState<{ id: string; filename: string } | null>(null);
  const [referenceDeleteError, setReferenceDeleteError] = useState("");
  const sessionActive = useRef(true);
  const loadSequence = useRef(0);
  const load = useCallback(async (syncReferenceNotes = true) => {
    if (!sessionActive.current) return;
    const sequence = ++loadSequence.current;
    let result: Awaited<ReturnType<typeof api.getTemplate>>;
    try {
      result = await api.getTemplate(templateId);
    } catch (error) {
      if (!sessionActive.current || sequence !== loadSequence.current) return;
      throw error;
    }
    if (!sessionActive.current || sequence !== loadSequence.current) return;
    if (result.template.templateKind !== "metrology") {
      navigate(`${templateDetailPath(templateId, "process")}${locationSearchRef.current}`, { replace: true });
      return;
    }
    if (result.template.steps.length !== 1) {
      throw new Error("This is not a valid metrology template.");
    }
    setTemplate(result.template);
    if (syncReferenceNotes) setReferenceNotes(result.template.metrologyNotes || "");
    return result.template;
  }, [navigate, templateId]);
  useEffect(() => {
    sessionActive.current = true;
    try {
      const pendingFilename = savedMetrologyReferenceUploadFilename(templateId);
      setReferenceUploadRecoveryName(pendingFilename);
      setReferenceUploadProblem(pendingFilename !== null);
    } catch (caught) { setError((caught as Error).message); setReferenceUploadProblem(true); }
    void load(true).catch((error: Error) => {
      if (sessionActive.current) setError(error.message);
    });
    return () => {
      sessionActive.current = false;
      loadSequence.current += 1;
    };
  }, [load, templateId]);

  async function update(input: MetrologyTemplateInput) {
    await api.updateMetrologyTemplate(templateId, input);
    if (!sessionActive.current) return;
    await load(false);
    if (!sessionActive.current) return;
    setNotice("Template details saved.");
  }

  async function saveReferenceNotes() {
    setSavingReference(true); setError(""); setNotice("");
    try {
      await api.updateMetrologyTemplateNotes(templateId, referenceNotes);
      if (!sessionActive.current) return;
      await load();
      if (!sessionActive.current) return;
      setNotice("Equipment and method notes saved.");
    } catch (error) { if (sessionActive.current) setError((error as Error).message); }
    finally { if (sessionActive.current) setSavingReference(false); }
  }

  async function uploadReference() {
    if (!referenceFile) return;
    setSavingReference(true); setError(""); setNotice("");
    try {
      const result = await api.uploadMetrologyTemplateReference(templateId, referenceFile);
      if (!sessionActive.current) return;
      const refreshed = await load(false);
      if (!sessionActive.current) return;
      if (!refreshed?.referenceAttachments.some((reference) => reference.id === result.reference.id)) {
        throw new Error("The uploaded reference is not visible yet. Check the same upload again to refresh the template.");
      }
      finishMetrologyReferenceUpload(templateId, result.requestId);
      setReferenceFile(null);
      setReferenceUploadProblem(false);
      setReferenceUploadRecoveryName(null);
      setNotice("Reference file attached.");
    } catch (error) {
      if (sessionActive.current) {
        setError((error as Error).message);
        setReferenceUploadProblem(true);
      }
    }
    finally { if (sessionActive.current) setSavingReference(false); }
  }

  async function deleteReference() {
    if (!referenceToDelete) return;
    setSavingReference(true); setReferenceDeleteError(""); setNotice("");
    try {
      await api.deleteMetrologyTemplateReference(templateId, referenceToDelete.id);
      if (!sessionActive.current) return;
      setReferenceToDelete(null);
      await load(false);
      if (!sessionActive.current) return;
      setNotice("Reference file removed.");
    } catch (error) { if (sessionActive.current) setReferenceDeleteError((error as Error).message); }
    finally { if (sessionActive.current) setSavingReference(false); }
  }

  async function remove() {
    if (!template) return;
    setDeleting(true); setTemplateDeleteError("");
    try {
      await api.removeTemplate(template.id);
      if (!sessionActive.current) return;
      setConfirmingTemplateDeletion(false);
      navigate("/templates");
    } catch (error) {
      if (!sessionActive.current) return;
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
        <FileDropzone accept="*/*" file={referenceFile} disabled={savingReference} onFile={setReferenceFile} label="Attach an equipment manual or reference file" hint="PDF, image, spreadsheet, document, or other reference file · up to 25 MB" />
        {referenceFile && <button type="button" className="button" disabled={savingReference} onClick={() => void uploadReference()}>{savingReference ? "Uploading…" : referenceUploadProblem ? "Check reference upload" : "Upload reference"}</button>}
        {referenceUploadRecoveryName && !referenceFile && <small>Reselect {referenceUploadRecoveryName} to check the previous upload, or discard it to start another.</small>}
        {referenceUploadProblem && <div className="form-actions">
          <small>The previous upload may still finish. Discarding lets you choose a new upload.</small>
          <button type="button" className="button" disabled={savingReference} onClick={() => {
            try {
              discardMetrologyReferenceUpload(templateId);
              setReferenceFile(null); setReferenceUploadProblem(false); setReferenceUploadRecoveryName(null); setError("");
            } catch (caught) { setError(caught instanceof MetrologyReferenceUploadError ? caught.message : "The reference upload could not be discarded."); }
          }}>Discard reference upload</button>
        </div>}
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
