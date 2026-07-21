import { useEffect, useMemo, useState } from "react";
import type { FabubloxImportPreview, ParsedFabubloxImage } from "../../shared/types";
import { api, type TemplateRecord } from "../lib/api";
import { parseFabuBloxWorkbook } from "../lib/fabublox";
import { FileDropzone } from "./FileDropzone";

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

interface FabubloxImporterProps {
  templates: TemplateRecord[];
  onImported: (result: { templateVersionId: string; version: number; name: string }) => Promise<void>;
}

export function FabubloxImporter({ templates, onImported }: FabubloxImporterProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<FabubloxImportPreview | null>(null);
  const [type, setType] = useState<TemplateRecord["templateType"]>("recipe");
  const [recipeFamilyId, setRecipeFamilyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const images = useMemo(() => new Map(preview?.images.map((image) => [image.localId, image]) ?? []), [preview]);
  const families = useMemo(() => [...new Map(templates.filter((template) => template.templateType === type)
    .map((template) => [template.recipeFamilyId, template])).values()], [templates, type]);

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
      const result = await api.importFabublox(file, preview, type, recipeFamilyId || undefined);
      await onImported({ templateVersionId: result.templateVersionId, version: result.version, name: preview.title.trim() });
    } catch (error) { setError((error as Error).message); setBusy(false); }
  }

  return <section className="template-import-section">
    <div>
      <p className="eyebrow">Import</p>
      <h2>FabuBlox workbook</h2>
      <p className="muted">Create a new template or import the workbook directly as the next version of an existing template. Nothing is uploaded before confirmation.</p>
    </div>
    <FileDropzone accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" file={file} onFile={(nextFile) => void choose(nextFile)} label={busy && !preview ? "Inspecting workbook…" : "Drop a FabuBlox .xlsx workbook"} hint="Cell values, drawing relationships, anchor rows, and embedded layer-stack diagrams are inspected in the browser." />
    {error && <p className="error-banner">{error}</p>}
    {preview && <div className="import-preview">
      <div className="card preview-summary">
        <div><small>Sheet</small><strong>{preview.source.sheetName}</strong></div>
        <div><small>Steps</small><strong>{preview.steps.length}</strong></div>
        <div><small>Images</small><strong>{preview.images.length}</strong></div>
        <div><small>Unassigned</small><strong>{preview.unassignedImageIds.length}</strong></div>
      </div>
      <div className="card form-grid">
        <label>Template title<input value={preview.title} disabled={Boolean(recipeFamilyId)} onChange={(event) => setPreview({ ...preview, title: event.target.value })} /></label>
        <label>Object kind<select value={type} onChange={(event) => { setType(event.target.value as TemplateRecord["templateType"]); setRecipeFamilyId(""); }}><option value="process">Process</option><option value="module">Module</option><option value="recipe">Recipe</option></select></label>
        <label>Version relationship<select value={recipeFamilyId} onChange={(event) => { const id = event.target.value; setRecipeFamilyId(id); const family = families.find((candidate) => candidate.recipeFamilyId === id); if (family) setPreview({ ...preview, title: family.name }); }}><option value="">New template</option>{families.map((family) => <option key={family.recipeFamilyId} value={family.recipeFamilyId}>New version of {family.name}</option>)}</select><small>{recipeFamilyId ? "The imported workbook becomes the next version immediately; no separate clone or save is needed." : "Creates a distinct template family."}</small></label>
      </div>
      {preview.warnings.length > 0 && <section className="warning-card"><strong>Import warnings</strong><ul>{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></section>}
      <section className="step-preview-list">
        {preview.steps.map((step) => <article className="card imported-step" key={step.localId}>
          <div className="step-position">{step.stepNumber ?? step.position + 1}</div>
          <div className="step-copy"><h2>{step.name}</h2>{step.sectionName && <span className="section-label">{step.sectionName}</span>}<dl><dt>Tool</dt><dd>{step.toolName || "—"}</dd><dt>Parameters</dt><dd className="preline">{step.parametersText || "—"}</dd><dt>Comments</dt><dd className="preline">{step.commentsText || "—"}</dd></dl></div>
          <LayerThumbnail image={step.imageIds[0] ? images.get(step.imageIds[0]) : undefined} alt={`Layer stack for ${step.name}`} />
        </article>)}
      </section>
      <button className="button primary wide" disabled={busy || !preview.title.trim() || !preview.steps.length} onClick={() => void confirm()}>{busy ? "Importing…" : `Confirm ${type} import`}</button>
    </div>}
  </section>;
}
