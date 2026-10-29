import { captureApplicationOwner } from "../lib/authentication-client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FabubloxImportPreview, ImportWarning, ParsedFabubloxImage } from "../../shared/types";
import { api, type ProcessTemplateFamilyOption } from "../lib/api";
import { parseFabuBloxWorkbook } from "../lib/fabublox";
import type { FabubloxImportRequestState, FabubloxImportResult } from "../../shared/contracts/fabublox-import";
import {
  clearSavedFabubloxImport, FabubloxImportRequestError, getFabubloxImportRequest,
  loadSavedFabubloxImport, prepareFabubloxImport, saveFabubloxImport,
  type PreparedFabubloxImport, type SavedFabubloxImport,
} from "../lib/fabublox-import-client";
import { sectionHeaderAtGroupStart } from "../lib/template-sections";
import { FABUBLOX_WORKBOOK_FORMATS } from "../lib/fabublox-formats";
import { ActionIcon } from "./ActionIcon";
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
  return preview.initialStateImageIds.length ? "Detected · with diagram" : "Detected · no diagram";
}

type WorkbookFormatId = (typeof FABUBLOX_WORKBOOK_FORMATS)[number]["id"];

interface FabubloxImporterProps {
  onImported: (result: { templateVersionId: string; version: number; name: string }) => Promise<void>;
}

type ImportOperation = SavedFabubloxImport & (
  | { status: "ready"; result: FabubloxImportResult }
  | { status: "unknown" | "not_found" | "reselect" | "pending" | "failed" }
);

function observedOperation(saved: SavedFabubloxImport, state: FabubloxImportRequestState | null): ImportOperation {
  const identity = { requestId: saved.requestId, title: saved.title };
  if (state?.status === "ready") return { ...identity, status: "ready", result: state.result };
  return { ...identity, status: state?.status ?? "not_found" };
}

export function FabubloxImporter({ onImported }: FabubloxImporterProps) {
  const [owner] = useState(captureApplicationOwner);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<FabubloxImportPreview | null>(null);
  const [recipeFamilyId, setRecipeFamilyId] = useState("");
  const [families, setFamilies] = useState<ProcessTemplateFamilyOption[]>([]);
  const [saved] = useState(loadSavedFabubloxImport);
  const [operation, setOperation] = useState<ImportOperation | null>(saved ? { ...saved, status: "unknown" } : null);
  const operationRef = useRef(operation);
  const preparedRef = useRef<PreparedFabubloxImport | null>(null);
  const actionInFlight = useRef(Boolean(saved));
  const parseGeneration = useRef(0);
  const mounted = useRef(true);
  const isCurrentSession = () => owner.isCurrent() && mounted.current;
  const [busy, setBusy] = useState(Boolean(saved));
  const [error, setError] = useState("");
  const [familyError, setFamilyError] = useState("");
  const [conversionFormatId, setConversionFormatId] = useState<WorkbookFormatId>("classic-layer-stack");
  const [converting, setConverting] = useState(false);
  const [conversionError, setConversionError] = useState("");
  const [conversionWarnings, setConversionWarnings] = useState<ImportWarning[]>([]);
  const [converted, setConverted] = useState<{ url: string; filename: string } | null>(null);
  const conversionGeneration = useRef(0);
  const conversionJob = useRef<number | null>(null);
  const conversionUrl = useRef<string | null>(null);
  const images = useMemo(() => new Map(preview?.images.map((image) => [image.localId, image]) ?? []), [preview]);
  const importNotes = preview?.warnings.filter(warning => ["placeholder_step_name", "metrology_rows_retained"].includes(warning.code)) ?? [];
  const importWarnings = preview?.warnings.filter(warning => !["placeholder_step_name", "metrology_rows_retained"].includes(warning.code)) ?? [];
  const sourceSubstrateName = preview?.initialSubstrateStep?.rawCells["Source substrate name"];
  const initialSubstrateName = typeof sourceSubstrateName === "string" && sourceSubstrateName.trim()
    ? sourceSubstrateName : "Substrate Stack";

  useEffect(() => {
    const controller = new AbortController();
    if (!isCurrentSession()) return;
    api.listTemplateFamilyOptions(controller.signal).then(({ families }) => {
      if (!isCurrentSession() || controller.signal.aborted) return;
      setFamilies(families);
      setFamilyError("");
    }).catch((error: Error) => {
      if (isCurrentSession() && error.name !== "AbortError") setFamilyError(`Existing process templates could not be loaded: ${error.message}`);
    });
    return () => controller.abort();
  }, []);

  function updateOperation(next: ImportOperation | null) {
    operationRef.current = next;
    setOperation(next);
  }

  function releaseConversionDownload() {
    if (conversionUrl.current) URL.revokeObjectURL(conversionUrl.current);
    conversionUrl.current = null;
  }

  function resetConversion() {
    conversionGeneration.current += 1;
    conversionJob.current = null;
    releaseConversionDownload();
    setConverting(false); setConverted(null); setConversionError(""); setConversionWarnings([]);
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (saved && isCurrentSession()) {
      getFabubloxImportRequest(saved.requestId, controller.signal).then((state) => {
        if (isCurrentSession() && !controller.signal.aborted) updateOperation(observedOperation(saved, state));
      }).catch((error: Error) => {
        if (isCurrentSession() && !controller.signal.aborted) setError(error.message);
      }).finally(() => {
        if (isCurrentSession() && !controller.signal.aborted) { actionInFlight.current = false; setBusy(false); }
      });
    }
    return () => {
      mounted.current = false; parseGeneration.current += 1; controller.abort();
      conversionGeneration.current += 1; conversionJob.current = null; releaseConversionDownload();
    };
  }, [saved]);

  async function choose(nextFile: File | null) {
    if (!isCurrentSession()) return;
    if ((operationRef.current && operationRef.current.status !== "reselect") || actionInFlight.current) return;
    resetConversion();
    const generation = ++parseGeneration.current;
    if (!nextFile) { setFile(null); setPreview(null); setBusy(false); setError(""); return; }
    setFile(nextFile); setPreview(null); setBusy(true); setError("");
    try {
      const parsed = await parseFabuBloxWorkbook(nextFile);
      if (isCurrentSession() && parseGeneration.current === generation) {
        setPreview(parsed);
        setConversionFormatId(parsed.detected.formatId === "classic-layer-stack" ? "capability-flow" : "classic-layer-stack");
      }
    } catch (error) {
      if (isCurrentSession() && parseGeneration.current === generation) setError(`Could not read FabuBlox workbook: ${(error as Error).message}`);
    } finally {
      if (isCurrentSession() && parseGeneration.current === generation) setBusy(false);
    }
  }

  async function downloadConvertedWorkbook() {
    if (!isCurrentSession() || !file || !preview || busy || actionInFlight.current || conversionJob.current !== null
      || operationRef.current && operationRef.current.status !== "reselect") return;
    const job = ++conversionGeneration.current;
    conversionJob.current = job;
    const selectedGeneration = parseGeneration.current;
    const source = file, target = conversionFormatId;
    const current = () => isCurrentSession() && conversionGeneration.current === job
      && parseGeneration.current === selectedGeneration && !actionInFlight.current
      && (!operationRef.current || operationRef.current.status === "reselect");
    releaseConversionDownload();
    setConverting(true); setConverted(null); setConversionError(""); setConversionWarnings([]);
    try {
      const { convertFabuBloxWorkbook } = await import("../lib/fabublox-convert");
      if (!current()) return;
      const result = await convertFabuBloxWorkbook(source, target);
      if (!current()) return;
      const url = URL.createObjectURL(result.file);
      conversionUrl.current = url;
      setConverted({ url, filename: result.file.name });
      setConversionWarnings(result.warnings);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = result.file.name;
      document.body.append(anchor);
      try { anchor.click(); }
      catch { setConversionError("The automatic download could not start. Use the prepared workbook link below."); }
      finally { anchor.remove(); }
    } catch (error) {
      if (current()) setConversionError(`Could not convert workbook: ${(error as Error).message}`);
    } finally {
      if (conversionGeneration.current === job) {
        conversionJob.current = null;
        if (isCurrentSession()) setConverting(false);
      }
    }
  }

  async function openResult(result: FabubloxImportResult, title: string, requestId: string) {
    if (!isCurrentSession()) return;
    try {
      await onImported({ templateVersionId: result.templateVersionId, version: result.version, name: title });
    } catch (error) {
      if (isCurrentSession()) setError(`The import completed, but its process template could not be opened: ${(error as Error).message}`);
      return;
    }
    // Opening the result acknowledges this completed import. Navigation may
    // already have unmounted the importer; retire only this owner's checkpoint
    // so returning to Settings does not restore an old success notice.
    if (owner.isCurrent() && loadSavedFabubloxImport()?.requestId === requestId) {
      try { clearSavedFabubloxImport(); }
      catch {
        if (isCurrentSession()) setError("The process template opened, but this browser could not dismiss the completed import notice. Enable session storage before starting another import.");
      }
    }
  }

  async function submitPrepared(prepared: PreparedFabubloxImport) {
    if (!isCurrentSession()) return;
    updateOperation({ requestId: prepared.requestId, title: prepared.title, status: "unknown" });
    try {
      const result = await api.importFabublox(prepared);
      if (!isCurrentSession()) return;
      updateOperation({ requestId: prepared.requestId, title: prepared.title, status: "ready", result });
      await openResult(result, prepared.title, prepared.requestId);
    } catch (error) {
      if (!isCurrentSession()) return;
      if (error instanceof FabubloxImportRequestError && error.request) {
        updateOperation(observedOperation(prepared, error.request));
      }
      setError((error as Error).message);
    }
  }

  async function confirm() {
    if (!isCurrentSession()) return;
    if (!file || !preview || (operationRef.current && operationRef.current.status !== "reselect") || actionInFlight.current) return;
    resetConversion();
    actionInFlight.current = true;
    setBusy(true); setError("");
    try {
      const prepared = await prepareFabubloxImport(file, preview, recipeFamilyId || undefined, operationRef.current?.requestId);
      if (!isCurrentSession()) return;
      // Save the identity before any request can be accepted by the server.
      saveFabubloxImport(prepared);
      preparedRef.current = prepared;
      await submitPrepared(prepared);
    } catch (error) {
      if (isCurrentSession()) setError((error as Error).message);
    } finally {
      actionInFlight.current = false;
      if (isCurrentSession()) setBusy(false);
    }
  }

  async function checkStatus() {
    if (!isCurrentSession()) return;
    const current = operationRef.current;
    if (!current || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true); setError("");
    try {
      const state = await getFabubloxImportRequest(current.requestId);
      if (isCurrentSession()) updateOperation(observedOperation(current, state));
    } catch (error) {
      if (isCurrentSession()) setError((error as Error).message);
    } finally {
      actionInFlight.current = false;
      if (isCurrentSession()) setBusy(false);
    }
  }

  async function retryOriginal() {
    if (!isCurrentSession()) return;
    const prepared = preparedRef.current;
    if (operationRef.current?.status !== "not_found" || !prepared || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true); setError("");
    try {
      saveFabubloxImport(prepared);
      await submitPrepared(prepared);
    } catch (error) {
      if (isCurrentSession()) setError((error as Error).message);
    } finally {
      actionInFlight.current = false;
      if (isCurrentSession()) setBusy(false);
    }
  }

  async function openCompleted() {
    if (!isCurrentSession()) return;
    const current = operationRef.current;
    if (current?.status !== "ready" || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true); setError("");
    try { await openResult(current.result, current.title, current.requestId); }
    finally { actionInFlight.current = false; if (isCurrentSession()) setBusy(false); }
  }

  function reselectWorkbook() {
    if (!isCurrentSession()) return;
    const current = operationRef.current;
    if (actionInFlight.current || current?.status !== "not_found" || preparedRef.current) return;
    // A 404 can precede acceptance of an older POST. Preserve its identity even
    // when a refresh discarded the byte body and it must be prepared again.
    updateOperation({ requestId: current.requestId, title: current.title, status: "reselect" });
    resetConversion();
    setFile(null); setPreview(null); setError("");
  }

  function startNewImport() {
    if (!isCurrentSession()) return;
    if (actionInFlight.current || !["failed", "ready"].includes(operationRef.current?.status ?? "")) return;
    try { clearSavedFabubloxImport(); }
    catch { setError("The saved import request could not be cleared. Enable session storage before starting another import."); return; }
    preparedRef.current = null;
    resetConversion();
    parseGeneration.current += 1;
    updateOperation(null);
    setFile(null); setPreview(null); setRecipeFamilyId(""); setError("");
  }

  const inputsLocked = busy || Boolean(operation && operation.status !== "reselect");

  return <section className="template-import-section">
    <div className="section-heading import-section-heading">
      <div>
        <h2>Import FabuBlox workbook</h2>
        <p className="muted">Create a new process template or import the workbook directly as the next version of an existing one. Nothing is uploaded before confirmation.</p>
      </div>
    </div>
    <FileDropzone disabled={inputsLocked} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" file={file} onFile={(nextFile) => void choose(nextFile)} label={busy && !preview && !operation ? "Inspecting workbook…" : "Drop a FabuBlox .xlsx workbook"} hint="Cell values, drawing relationships, anchor rows, and embedded layer-stack diagrams are inspected in the browser." />
    {familyError && <p className="error-banner" role="alert">{familyError}</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {operation && <section className="card" aria-label="Import request">
      <p role="status">{busy ? "Checking or completing the import…" : operation.status === "ready"
        ? `Import completed: ${operation.title || "Process template"}, version ${operation.result.version}.`
        : operation.status === "pending" ? "The import is still in progress. Check its status again shortly."
          : operation.status === "failed" ? "This import failed. Start a new import to try again."
            : operation.status === "not_found" ? preparedRef.current
              ? "This request is not currently visible. It may still be starting. Retry only the original import, or check its status again."
              : "This request is not currently visible. It may still be starting. Reselect the workbook to continue the same request."
              : operation.status === "reselect" ? "Select the original workbook and import options to continue this request. Its original identity will be retained."
                : "The import result is not yet known. Check its status before taking another action."}</p>
      <div className="button-row">
        {!["ready", "failed"].includes(operation.status) && <button className="button" disabled={busy} onClick={() => void checkStatus()}>Check import status</button>}
        {operation.status === "not_found" && preparedRef.current && <button className="button primary" disabled={busy} onClick={() => void retryOriginal()}>Retry original import</button>}
        {operation.status === "not_found" && !preparedRef.current && <button className="button" disabled={busy} onClick={reselectWorkbook}>Reselect workbook for this request</button>}
        {operation.status === "ready" && <button className="button primary" disabled={busy} onClick={() => void openCompleted()}>Open completed process template</button>}
        {["ready", "failed"].includes(operation.status) && <button className="button" disabled={busy} onClick={startNewImport}>Start a new import</button>}
      </div>
    </section>}
    {preview && <div className="import-preview">
      <div className="card preview-summary">
        <div><small>Sheet</small><strong>{preview.source.sheetName}</strong></div>
        <div><small>Steps</small><strong>{preview.steps.length}</strong></div>
        <div><small>Images</small><strong>{preview.images.length}</strong></div>
        <div><small>Unassigned</small><strong>{preview.unassignedImageIds.length}</strong></div>
      </div>
      <div className="card form-grid">
        <label>Process template title<input value={preview.title} disabled={inputsLocked || Boolean(recipeFamilyId)} onChange={(event) => setPreview({ ...preview, title: event.target.value })} /></label>
        <label>Version relationship<select disabled={inputsLocked} value={recipeFamilyId} onChange={(event) => { const id = event.target.value; setRecipeFamilyId(id); const family = families.find((candidate) => candidate.recipeFamilyId === id); if (family) setPreview({ ...preview, title: family.name }); }}><option value="">New process template</option>{families.map((family) => <option key={family.recipeFamilyId} value={family.recipeFamilyId}>New version of {family.name}</option>)}</select><small>{recipeFamilyId ? "The imported workbook becomes the next immutable version immediately." : "Creates a distinct process-template family."}</small></label>
      </div>
      <details className="card settings-task-details">
        <summary>Convert workbook layout</summary>
        <p className="muted">Download a content-compatible copy of the selected workbook. This does not import it or change your original workbook or import options. Original formatting, formulas and other sheets, including Overview graphics, are not reproduced; keep the original workbook.</p>
        <div className="form-grid">
          <label>Converted workbook layout<select value={conversionFormatId} disabled={inputsLocked || converting}
            onChange={event => { resetConversion(); setConversionFormatId(event.target.value as WorkbookFormatId); }}>
            {FABUBLOX_WORKBOOK_FORMATS.map(format => <option key={format.id} value={format.id}>{format.label}</option>)}
          </select></label>
          <div className="button-row"><button type="button" className="button" disabled={inputsLocked || converting}
            onClick={() => void downloadConvertedWorkbook()}><ActionIcon name="export" />{converting ? "Converting workbook…" : "Download converted workbook"}</button></div>
        </div>
        {converted && <p role="status">Converted workbook ready. <a href={converted.url} download={converted.filename}>Download prepared workbook</a></p>}
        {conversionWarnings.length > 0 && <section className="warning-card" aria-label="Conversion notes"><strong>Conversion notes</strong>
          <ul>{conversionWarnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></section>}
        {conversionError && <p className="error-banner" role="alert">{conversionError}</p>}
      </details>
      <details className={`card workbook-substrate-details${preview.initialSubstrateStep ? "" : " missing-initial-state"}`}>
        <summary>Initial substrate · {preview.initialSubstrateStep ? initialSubstrateName : "Not detected"}<span className="card-meta"> · {substrateStatus(preview)}</span></summary>
        <div className={`initial-state-preview${preview.initialSubstrateStep ? "" : " missing-initial-state"}`}>
        <div className="card-copy">
          <div className="card-title-line"><h3 className="card-title">Initial substrate</h3><span className="meta-badge">Step 0</span></div>
          <p className="card-value">{preview.initialSubstrateStep ? initialSubstrateName : "Substrate Stack was not found"}</p>
          {preview.initialSubstrateStep ? <SubstrateStepDetails step={preview.initialSubstrateStep} /> : <p className="card-meta">The importer will not borrow a diagram from Step 1. This template cannot start a run, or update one before any process step has produced a recorded structure, until it is re-imported with Step 0.</p>}
        </div>
        <div className="initial-state-preview-images">
          {preview.initialStateImageIds.length
            ? preview.initialStateImageIds.map((id) => <LayerThumbnail key={id} image={images.get(id)} alt={`Step 0 ${initialSubstrateName}`} />)
            : <div className="layer-placeholder">{preview.initialSubstrateStep ? "Step 0 has no diagram" : "No Step 0 structure"}</div>}
        </div>
        </div>
      </details>
      {importWarnings.length > 0 && <section className="warning-card"><strong>Import warnings</strong><ul>{importWarnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></section>}
      {importNotes.length > 0 && <details className="settings-task-details"><summary>Import notes ({importNotes.length})</summary>
        <ul>{importNotes.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>
      </details>}
      <section className="step-preview-list">
        {preview.steps.map((step, index) => {
          const sectionLabel = sectionHeaderAtGroupStart(preview.steps, index);
          return <Fragment key={step.localId}>
            {sectionLabel && <div className="process-section-header import-section-header">{sectionLabel}</div>}
            <article className="card imported-step">
              <div className="step-position">{step.stepNumber ?? step.position + 1}</div>
              <div className="step-copy"><h3 className="card-title">{step.name}</h3><dl><dt>Tool</dt><dd>{step.toolName || "—"}</dd><dt>Parameters</dt><dd className="preline">{step.parametersText || "—"}</dd><dt>Comments</dt><dd className="preline">{step.commentsText || "—"}</dd></dl></div>
              <LayerThumbnail image={step.imageIds[0] ? images.get(step.imageIds[0]) : undefined} alt={`Layer stack for ${step.name}`} />
            </article>
          </Fragment>;
        })}
      </section>
      {(!operation || operation.status === "reselect") && <button className="button primary wide" disabled={busy || !preview.title.trim() || !preview.steps.length} onClick={() => void confirm()}>{busy ? "Preparing import…" : "Confirm process-template import"}</button>}
    </div>}
  </section>;
}
