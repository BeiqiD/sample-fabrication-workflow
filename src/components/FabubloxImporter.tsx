import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FabubloxImportPreview, ParsedFabubloxImage } from "../../shared/types";
import { api, type ProcessTemplateFamilyOption } from "../lib/api";
import { parseFabuBloxWorkbook } from "../lib/fabublox";
import type { FabubloxImportRequestState, FabubloxImportResult } from "../../shared/contracts/fabublox-import";
import {
  clearSavedFabubloxImport, FabubloxImportRequestError, getFabubloxImportRequest,
  loadSavedFabubloxImport, prepareFabubloxImport, saveFabubloxImport,
  type PreparedFabubloxImport, type SavedFabubloxImport,
} from "../lib/fabublox-import-client";
import { sectionHeaderAtGroupStart } from "../lib/template-sections";
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
  const [busy, setBusy] = useState(Boolean(saved));
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

  function updateOperation(next: ImportOperation | null) {
    operationRef.current = next;
    setOperation(next);
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (saved) {
      getFabubloxImportRequest(saved.requestId, controller.signal).then((state) => {
        if (!controller.signal.aborted) updateOperation(observedOperation(saved, state));
      }).catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      }).finally(() => {
        if (!controller.signal.aborted) { actionInFlight.current = false; setBusy(false); }
      });
    }
    return () => { mounted.current = false; parseGeneration.current += 1; controller.abort(); };
  }, [saved]);

  async function choose(nextFile: File | null) {
    if ((operationRef.current && operationRef.current.status !== "reselect") || actionInFlight.current) return;
    const generation = ++parseGeneration.current;
    if (!nextFile) { setFile(null); setPreview(null); setBusy(false); setError(""); return; }
    setFile(nextFile); setPreview(null); setBusy(true); setError("");
    try {
      const parsed = await parseFabuBloxWorkbook(nextFile);
      if (mounted.current && parseGeneration.current === generation) setPreview(parsed);
    } catch (error) {
      if (mounted.current && parseGeneration.current === generation) setError(`Could not read FabuBlox workbook: ${(error as Error).message}`);
    } finally {
      if (mounted.current && parseGeneration.current === generation) setBusy(false);
    }
  }

  async function openResult(result: FabubloxImportResult, title: string) {
    try {
      await onImported({ templateVersionId: result.templateVersionId, version: result.version, name: title });
    } catch (error) {
      if (mounted.current) setError(`The import completed, but its process template could not be opened: ${(error as Error).message}`);
    }
  }

  async function submitPrepared(prepared: PreparedFabubloxImport) {
    updateOperation({ requestId: prepared.requestId, title: prepared.title, status: "unknown" });
    try {
      const result = await api.importFabublox(prepared);
      if (!mounted.current) return;
      updateOperation({ requestId: prepared.requestId, title: prepared.title, status: "ready", result });
      await openResult(result, prepared.title);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof FabubloxImportRequestError && error.request) {
        updateOperation(observedOperation(prepared, error.request));
      }
      setError((error as Error).message);
    }
  }

  async function confirm() {
    if (!file || !preview || (operationRef.current && operationRef.current.status !== "reselect") || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true); setError("");
    try {
      const prepared = await prepareFabubloxImport(file, preview, recipeFamilyId || undefined, operationRef.current?.requestId);
      if (!mounted.current) return;
      // Save the identity before any request can be accepted by the server.
      saveFabubloxImport(prepared);
      preparedRef.current = prepared;
      await submitPrepared(prepared);
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function checkStatus() {
    const current = operationRef.current;
    if (!current || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true); setError("");
    try {
      const state = await getFabubloxImportRequest(current.requestId);
      if (mounted.current) updateOperation(observedOperation(current, state));
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function retryOriginal() {
    const prepared = preparedRef.current;
    if (operationRef.current?.status !== "not_found" || !prepared || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true); setError("");
    try {
      saveFabubloxImport(prepared);
      await submitPrepared(prepared);
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function openCompleted() {
    const current = operationRef.current;
    if (current?.status !== "ready" || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true); setError("");
    try { await openResult(current.result, current.title); }
    finally { actionInFlight.current = false; if (mounted.current) setBusy(false); }
  }

  function reselectWorkbook() {
    const current = operationRef.current;
    if (actionInFlight.current || current?.status !== "not_found" || preparedRef.current) return;
    // A 404 can precede acceptance of an older POST. Preserve its identity even
    // when a refresh discarded the byte body and it must be prepared again.
    updateOperation({ requestId: current.requestId, title: current.title, status: "reselect" });
    setFile(null); setPreview(null); setError("");
  }

  function startNewImport() {
    if (actionInFlight.current || !["failed", "ready"].includes(operationRef.current?.status ?? "")) return;
    try { clearSavedFabubloxImport(); }
    catch { setError("The saved import request could not be cleared. Enable session storage before starting another import."); return; }
    preparedRef.current = null;
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
    {familyError && <p className="error-banner">{familyError}</p>}
    {error && <p className="error-banner">{error}</p>}
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
      {!["ready", "failed"].includes(operation.status) && <button className="button" disabled={busy} onClick={() => void checkStatus()}>Check import status</button>}
      {operation.status === "not_found" && preparedRef.current && <button className="button primary" disabled={busy} onClick={() => void retryOriginal()}>Retry original import</button>}
      {operation.status === "not_found" && !preparedRef.current && <button className="button" disabled={busy} onClick={reselectWorkbook}>Reselect workbook for this request</button>}
      {operation.status === "ready" && <button className="button primary" disabled={busy} onClick={() => void openCompleted()}>Open completed process template</button>}
      {["ready", "failed"].includes(operation.status) && <button className="button" disabled={busy} onClick={startNewImport}>Start a new import</button>}
    </section>}
    {preview && <div className="import-preview">
      <div className="card preview-summary">
        <div><small>Sheet</small><strong>{preview.source.sheetName}</strong></div>
        <div><small>Steps</small><strong>{preview.steps.length}</strong></div>
        <div><small>Images</small><strong>{preview.images.length}</strong></div>
        <div><small>Initial substrate</small><strong>{substrateStatus(preview)}</strong></div>
        <div><small>Unassigned</small><strong>{preview.unassignedImageIds.length}</strong></div>
      </div>
      <div className="card form-grid">
        <label>Process template title<input value={preview.title} disabled={inputsLocked || Boolean(recipeFamilyId)} onChange={(event) => setPreview({ ...preview, title: event.target.value })} /></label>
        <label>Version relationship<select disabled={inputsLocked} value={recipeFamilyId} onChange={(event) => { const id = event.target.value; setRecipeFamilyId(id); const family = families.find((candidate) => candidate.recipeFamilyId === id); if (family) setPreview({ ...preview, title: family.name }); }}><option value="">New process template</option>{families.map((family) => <option key={family.recipeFamilyId} value={family.recipeFamilyId}>New version of {family.name}</option>)}</select><small>{recipeFamilyId ? "The imported workbook becomes the next immutable version immediately." : "Creates a distinct process-template family."}</small></label>
      </div>
      <section className={`card initial-state-preview${preview.initialSubstrateStep ? "" : " missing-initial-state"}`}>
        <div className="card-copy">
          <div className="card-title-line"><h3 className="card-title">Initial substrate</h3><span className="meta-badge">Step 0</span></div>
          <p className="card-value">{preview.initialSubstrateStep ? "Substrate Stack" : "Substrate Stack was not found"}</p>
          {preview.initialSubstrateStep ? <SubstrateStepDetails step={preview.initialSubstrateStep} /> : <p className="card-meta">The importer will not borrow a diagram from Step 1. This template cannot start a run, or update one before any process step has produced a recorded structure, until it is re-imported with Step 0.</p>}
        </div>
        <div className="initial-state-preview-images">
          {preview.initialStateImageIds.length
            ? preview.initialStateImageIds.map((id) => <LayerThumbnail key={id} image={images.get(id)} alt="Step 0 Substrate Stack" />)
            : <div className="layer-placeholder">{preview.initialSubstrateStep ? "Step 0 has no diagram" : "No Step 0 structure"}</div>}
        </div>
      </section>
      {preview.warnings.length > 0 && <section className="warning-card"><strong>Import warnings</strong><ul>{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></section>}
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
