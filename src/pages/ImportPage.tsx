import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TemplatePreview } from "../../shared/types";
import { api, type TemplateRecord } from "../lib/api";
import { parseFabuBloxWorkbook } from "../lib/fabublox";

export function ImportPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [type, setType] = useState<TemplateRecord["templateType"]>("recipe");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function choose(nextFile?: File) {
    if (!nextFile) return;
    setFile(nextFile); setBusy(true); setError("");
    try { setPreview(await parseFabuBloxWorkbook(nextFile)); }
    catch (error) { setError(`Could not read workbook: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!file || !preview) return;
    setBusy(true); setError("");
    try {
      const sourceAssetKey = (await api.uploadAsset(file, file.name)).key;
      const uploadedImages = [];
      for (const image of preview.images) {
        const blob = new Blob([new Uint8Array(image.data)], { type: image.mimeType });
        uploadedImages.push({ filename: image.filename, assetKey: (await api.uploadAsset(blob, image.filename)).key });
      }
      await api.createTemplate({
        name: preview.name,
        templateType: type,
        sourceFilename: preview.sourceFile,
        sourceAssetKey,
        content: { sheets: preview.sheets, images: uploadedImages },
      });
      navigate("/templates");
    } catch (error) { setError((error as Error).message); setBusy(false); }
  }

  return <div className="page narrow-page">
    <p className="eyebrow">Import</p><h1>FabuBlox workbook</h1><p className="lead">The workbook is parsed in your browser. Review its sheets and embedded images before creating an immutable template version.</p>
    <label className="dropzone"><input type="file" accept=".xlsx,.xls" onChange={(event) => void choose(event.target.files?.[0])} /><strong>{busy && !preview ? "Reading workbook…" : "Choose an Excel workbook"}</strong><span>Values and files under xl/media are extracted locally.</span></label>
    {error && <p className="error-banner">{error}</p>}
    {preview && <div className="import-preview">
      <div className="card preview-summary"><div><small>Workbook</small><strong>{preview.sourceFile}</strong></div><div><small>Sheets</small><strong>{preview.sheets.length}</strong></div><div><small>Embedded images</small><strong>{preview.images.length}</strong></div></div>
      <div className="card form-grid"><label>Template name<input value={preview.name} onChange={(event) => setPreview({ ...preview, name: event.target.value })} /></label><label>Template type<select value={type} onChange={(event) => setType(event.target.value as TemplateRecord["templateType"])}><option value="process">Process</option><option value="module">Module</option><option value="recipe">Recipe</option></select></label></div>
      {preview.sheets.map((sheet) => <section className="card sheet-preview" key={sheet.name}><h2>{sheet.name}</h2><div className="table-scroll"><table><tbody>{sheet.rows.slice(0, 12).map((row, rowIndex) => <tr key={rowIndex}>{row.slice(0, 8).map((cell, cellIndex) => <td key={cellIndex}>{String(cell ?? "")}</td>)}</tr>)}</tbody></table></div><p className="muted">Showing up to 12 rows and 8 columns of {sheet.rows.length} rows.</p></section>)}
      <button className="button primary wide" disabled={busy || !preview.name.trim()} onClick={() => void confirm()}>{busy ? "Importing…" : "Confirm import"}</button>
    </div>}
  </div>;
}
