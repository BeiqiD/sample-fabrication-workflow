import { useEffect, useMemo, useState } from "react";
import type { FabubloxImportPreview, ParsedFabubloxImage } from "../../shared/types";
import { api, type ProcessTemplateFamilyOption } from "../lib/api";
import { parseFabuBloxWorkbook } from "../lib/fabublox";
import { FileDropzone } from "./FileDropzone";
import { SubstrateStepDetails } from "./SubstrateStepDetails";

function LayerThumbnail({ image, alt }: { image?: ParsedFabubloxImage; alt: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!image) return;
    const next = URL.createObjectURL(new Blob([new Uint8Array(image.data)], { type: image.mimeType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image]);
  return url ? <img className="layer-thumbnail" src={url} alt={alt} /> : <div className="layer-placeholder">No diagram</div>;
}

function substrateStatus(preview: FabubloxImportPreview) {
  if (!preview.initialSubstrateStep) return "Step 0 missing";
  return preview.initialStateImageIds.length ? "Substrate Stack detected" : "Detected · no diagram";
}

interface FabubloxImporterProps {
  onImported: (result: { templateVersionId: string; version: number; name: string }) => Promise<void>;
}

export function FabubloxImporter({ onImported }: FabubloxImporterProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<FabubloxImportPreview | null>(null);
  const [recipeFamilyId, setRecipeFamilyId] = useState("");
  const [families, setFamilies] = useState<ProcessTemplateFamilyOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [familyError, setFamilyError] = useState("");
  const images = useMemo(() => new Map(preview?.images.map((image) => [image.localId, image]) ?? []), [preview]);

  useEffect(() => {
    const controller = new AbortController();
    api.listTemplateFamilyOptions(controller.signal).then(({ families }) => {
      setFamilies(families);
      setFamilyError("");
    }).catch((error: Error) => {
      if (error.name !== "AbortError") setFamilyError(`Existing process templates could not be loaded: ${error.message}`);
    });
    return () => controller.abort();
  }, []);

  async function choose(nextFile: File | null) {
    if (!nextFile) { setFile(null); setPreview(null); setError(""); return; }
    setFile(nextFile); setPreview(null); setBusy(true); setError("");
    try { setPreview(await parseFabuBloxWorkbook(nextFile)); }
    catch (error) { setError(`Could not read FabuBlox workbook: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!file || !preview) return;
    setBusy(true); setError("");
    try {
      const result = await api.importFabublox(file, preview, recipeFamilyId || undefined);
      await onImported({ templateVersionId: result.templateVersionId, version: result.version, name: preview.title.trim() });
    } catch (error) { setError((error as Error).message); setBusy(false); }
  }

  return <section className="template-import-section">
    <div className="section-heading import-section-heading">
      <div>
        <h2>Import FabuBlox workbook</h2>
        <p className="muted">Create a new process template or import the workbook directly as the next version of an existing one. Nothing is uploaded before confirmation.</p>
      </div>
    </div>
    <FileDropzone accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" file={file} onFile={(nextFile) => void choose(nextFile)} label={busy && !preview ? "Inspecting workbook…" : "Drop a FabuBlox .xlsx workbook"} hint="Cell values, drawing relationships, anchor rows, and embedded layer-stack diagrams are inspected in the browser." />
    {familyError && <p className="error-banner">{familyError}</p>}
    {error && <p className="error-banner">{error}</p>}
    {preview && <div className="import-preview">
      <div className="card preview-summary">
        <div><small>Sheet</small><strong>{preview.source.sheetName}</strong></div>
        <div><small>Steps</small><strong>{preview.steps.length}</strong></div>
        <div><small>Images</small><strong>{preview.images.length}</strong></div>
        <div><small>Initial substrate</small><strong>{substrateStatus(preview)}</strong></div>
        <div><small>Unassigned</small><strong>{preview.unassignedImageIds.length}</strong></div>
      </div>
      <div className="card form-grid">
        <label>Process template title<input value={preview.title} disabled={Boolean(recipeFamilyId)} onChange={(event) => setPreview({ ...preview, title: event.target.value })} /></label>
        <label>Version relationship<select value={recipeFamilyId} onChange={(event) => { const id = event.target.value; setRecipeFamilyId(id); const family = families.find((candidate) => candidate.recipeFamilyId === id); if (family) setPreview({ ...preview, title: family.name }); }}><option value="">New process template</option>{families.map((family) => <option key={family.recipeFamilyId} value={family.recipeFamilyId}>New version of {family.name}</option>)}</select><small>{recipeFamilyId ? "The imported workbook becomes the next immutable version immediately." : "Creates a distinct process-template family."}</small></label>
      </div>
      <section className={`card initial-state-preview${preview.initialSubstrateStep ? "" : " missing-initial-state"}`}>
        <div className="card-copy">
          <div className="card-title-line"><h3 className="card-title">Initial substrate</h3><span className="meta-badge">Step 0</span></div>
          <p className="card-value">{preview.initialSubstrateStep ? "Substrate Stack" : "Substrate Stack was not found"}</p>
          {preview.initialSubstrateStep ? <SubstrateStepDetails step={preview.initialSubstrateStep} /> : <p className="card-meta">The importer will not borrow a diagram from Step 1. This template cannot start or update a run until it is re-imported with Step 0.</p>}
        </div>
        <div className="initial-state-preview-images">
          {preview.initialStateImageIds.length
            ? preview.initialStateImageIds.map((id) => <LayerThumbnail key={id} image={images.get(id)} alt="Step 0 Substrate Stack" />)
            : <div className="layer-placeholder">{preview.initialSubstrateStep ? "Step 0 has no diagram" : "No Step 0 structure"}</div>}
        </div>
      </section>
      {preview.warnings.length > 0 && <section className="warning-card"><strong>Import warnings</strong><ul>{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></section>}
      <section className="step-preview-list">
        {preview.steps.map((step) => <article className="card imported-step" key={step.localId}>
          <div className="step-position">{step.stepNumber ?? step.position + 1}</div>
          <div className="step-copy"><h3 className="card-title">{step.name}</h3>{step.sectionName && <span className="section-label">{step.sectionName}</span>}<dl><dt>Tool</dt><dd>{step.toolName || "—"}</dd><dt>Parameters</dt><dd className="preline">{step.parametersText || "—"}</dd><dt>Comments</dt><dd className="preline">{step.commentsText || "—"}</dd></dl></div>
          <LayerThumbnail image={step.imageIds[0] ? images.get(step.imageIds[0]) : undefined} alt={`Layer stack for ${step.name}`} />
        </article>)}
      </section>
      <button className="button primary wide" disabled={busy || !preview.title.trim() || !preview.steps.length} onClick={() => void confirm()}>{busy ? "Importing…" : "Confirm process-template import"}</button>
    </div>}
  </section>;
}
