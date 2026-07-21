import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RunStep, RunStepComment, SampleRun, StepStatus } from "../../shared/types";
import { api } from "../lib/api";
import { visibleAlphaBounds } from "../lib/diagramImage";
import { compressCommentImage, compressLayerStackImage } from "../lib/images";
import { buildRunGrid, type RunGridColumn } from "../lib/runGrid";
import { runStepIsModified } from "../lib/runSteps";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { FileDropzone } from "./FileDropzone";

const STATUSES: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];

type DrawerState =
  | { mode: "edit"; column: RunGridColumn; step: RunStep }
  | { mode: "add"; column: RunGridColumn; afterStepId?: string }
  | null;

type DeleteCommentRequest = {
  comment: RunStepComment;
  common: boolean;
};

function target(column: RunGridColumn, step: RunStep) {
  if (!column.run) throw new Error("This sample has no matching run");
  return {
    sampleId: column.sample.id,
    runId: column.run.id,
    stepId: step.id,
    expectedUpdatedAt: step.updatedAt,
  };
}

type GalleryKind = "diagram" | "photo";
type GallerySize = "compact" | "wide";

type DiagramViewport = {
  naturalWidth: number;
  naturalHeight: number;
  viewBox: string;
};

const diagramViewportCache = new Map<string, DiagramViewport | null>();

function DiagramThumbnail({ src, alt }: { src: string; alt: string }) {
  const cached = diagramViewportCache.get(src);
  const [viewport, setViewport] = useState<DiagramViewport | null | undefined>(cached);

  function measure(image: HTMLImageElement) {
    if (diagramViewportCache.has(src)) {
      setViewport(diagramViewportCache.get(src));
      return;
    }
    if (!image.naturalWidth || !image.naturalHeight) return;
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    try {
      context.drawImage(image, 0, 0, width, height);
      const bounds = visibleAlphaBounds(context.getImageData(0, 0, width, height).data, width, height);
      const fillsCanvas = bounds && bounds.width >= width * .96 && bounds.height >= height * .96;
      if (!bounds || fillsCanvas) {
        diagramViewportCache.set(src, null);
        setViewport(null);
        return;
      }

      const inverseScale = 1 / scale;
      const x = bounds.x * inverseScale;
      const y = bounds.y * inverseScale;
      const contentWidth = bounds.width * inverseScale;
      const contentHeight = bounds.height * inverseScale;
      const padding = Math.max(8, Math.max(contentWidth, contentHeight) * .03);
      const next = {
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        viewBox: `${x - padding} ${y - padding} ${contentWidth + padding * 2} ${contentHeight + padding * 2}`,
      };
      diagramViewportCache.set(src, next);
      setViewport(next);
    } catch {
      diagramViewportCache.set(src, null);
      setViewport(null);
    }
  }

  return <>
    <img
      className={viewport ? "diagram-thumbnail-source measured" : "diagram-thumbnail-source"}
      src={src}
      alt={viewport ? "" : alt}
      aria-hidden={Boolean(viewport)}
      loading="lazy"
      onLoad={(event) => measure(event.currentTarget)}
    />
    {viewport && <svg className="diagram-thumbnail-svg" viewBox={viewport.viewBox} role="img" aria-label={alt}>
      <image href={src} width={viewport.naturalWidth} height={viewport.naturalHeight} />
    </svg>}
  </>;
}

function DiagramGallery({ keys, label, kind = "diagram", size = "compact" }: {
  keys: string[];
  label: string;
  kind?: GalleryKind;
  size?: GallerySize;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);

  function setImageZoom(nextZoom: number) {
    const limited = Math.min(5, Math.max(1, nextZoom));
    setZoom(limited);
    if (limited === 1) setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    if (activeIndex === null) return;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setActiveIndex(null);
      if (event.key === "ArrowLeft") setActiveIndex((current) => current === null ? null : (current - 1 + keys.length) % keys.length);
      if (event.key === "ArrowRight") setActiveIndex((current) => current === null ? null : (current + 1) % keys.length);
      if (["+", "="].includes(event.key)) { event.preventDefault(); setZoom((current) => Math.min(5, current + .25)); }
      if (event.key === "-") { event.preventDefault(); setZoom((current) => Math.max(1, current - .25)); }
      if (event.key === "0") { setZoom(1); setPan({ x: 0, y: 0 }); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeIndex, keys.length]);
  if (!keys.length) return null;
  const lightbox = activeIndex === null ? null : createPortal(<div className={`image-lightbox ${kind}-lightbox`} role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveIndex(null); }}>
    <div className="image-lightbox-panel">
      <div className="image-lightbox-toolbar">
        <span className="image-lightbox-caption"><strong>{label}</strong><small>{activeIndex + 1} / {keys.length}</small></span>
        <div className="image-zoom-controls" aria-label="Image zoom controls">
          <button type="button" onClick={() => setImageZoom(zoom - .25)} disabled={zoom === 1} aria-label="Zoom out">−</button>
          <button type="button" className="zoom-level" onClick={() => setImageZoom(1)} aria-label="Reset image zoom">{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setImageZoom(zoom + .25)} disabled={zoom === 5} aria-label="Zoom in">+</button>
        </div>
        <a href={`/api/assets/${keys[activeIndex]}`} target="_blank" rel="noreferrer">Original</a>
        <button ref={closeButtonRef} type="button" className="lightbox-close" onClick={() => setActiveIndex(null)} aria-label="Close image viewer">×</button>
      </div>
      <div
        className={`image-lightbox-stage${zoom > 1 ? " zoomed" : ""}`}
        onWheel={(event) => { event.preventDefault(); setImageZoom(zoom + (event.deltaY < 0 ? .25 : -.25)); }}
        onDoubleClick={() => setImageZoom(zoom === 1 ? 2 : 1)}
        onPointerDown={(event) => {
          if (zoom === 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
        }}
        onPointerUp={(event) => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <img
          src={`/api/assets/${keys[activeIndex]}`}
          alt={`${label} ${activeIndex + 1}`}
          draggable={false}
          style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
        />
      </div>
      {keys.length > 1 && <><button type="button" className="lightbox-arrow previous" onClick={() => setActiveIndex((activeIndex - 1 + keys.length) % keys.length)} aria-label="Previous image">←</button><button type="button" className="lightbox-arrow next" onClick={() => setActiveIndex((activeIndex + 1) % keys.length)} aria-label="Next image">→</button></>}
    </div>
  </div>, document.body);
  return <>
    <div className={`grid-diagrams ${kind}-thumbnails ${size}-thumbnails`} role="list">{keys.map((key, index) => {
      const src = `/api/assets/${key}`;
      return <button type="button" key={`${key}:${index}`} role="listitem" onClick={() => setActiveIndex(index)} aria-label={`Open ${label} ${index + 1} of ${keys.length}`}>
        {kind === "diagram" ? <DiagramThumbnail src={src} alt={label} /> : <img src={src} alt={label} loading="lazy" />}
      </button>;
    })}</div>
    {lightbox}
  </>;
}

function CommentCard({ comment, meta, imageLabel, onDelete, common = false }: {
  comment: RunStepComment;
  meta: string;
  imageLabel: string;
  onDelete: () => void;
  common?: boolean;
}) {
  return <div className={`cell-comment${common ? " common-comment" : ""}`}>
    <div className="comment-card-content">
      <div className="comment-card-copy">{comment.body && <p>{comment.body}</p>}<small>{meta}</small></div>
      {comment.assetKey && <div className="comment-thumbnail-gallery"><DiagramGallery keys={[comment.assetKey]} label={imageLabel} kind="photo" /></div>}
    </div>
    <button type="button" className="comment-delete-button" onClick={onDelete} aria-label="Delete comment">Delete</button>
  </div>;
}

function CommentList({ comments, onDelete }: { comments: RunStepComment[]; onDelete: (comment: RunStepComment) => void }) {
  if (!comments.length) return null;
  return <div className="comment-history"><div className="cell-comments">{comments.map((comment) => <CommentCard
    key={comment.id}
    comment={comment}
    meta={`${comment.actorEmail || "Unknown user"} · ${new Date(comment.createdAt).toLocaleString()}`}
    imageLabel="Comment photo"
    onDelete={() => onDelete(comment)}
  />)}</div></div>;
}

function ActualDifferences({ step }: { step: RunStep }) {
  if (step.origin === "ad_hoc") return <div className="actual-differences">
    {step.toolName && <p><span>Tool</span>{step.toolName}</p>}
    {step.parametersText && <p><span>Parameters</span>{step.parametersText}</p>}
    {step.commentsText && <p><span>Instructions</span>{step.commentsText}</p>}
    {step.deviationNote && <p className="deviation-copy"><span>Reason</span>{step.deviationNote}</p>}
  </div>;
  if (!runStepIsModified(step)) return null;
  const changes = [
    step.title.trim() !== (step.plannedTitle || "").trim() ? ["Step", step.title] : null,
    (step.toolName || "").trim() !== (step.plannedToolName || "").trim() ? ["Tool", step.toolName || "—"] : null,
    (step.parametersText || "").trim() !== (step.plannedParametersText || "").trim() ? ["Parameters", step.parametersText || "—"] : null,
    (step.commentsText || "").trim() !== (step.plannedCommentsText || "").trim() ? ["What happened", step.commentsText || "—"] : null,
    step.deviationNote?.trim() ? ["Deviation", step.deviationNote] : null,
  ].filter((entry): entry is string[] => Boolean(entry));
  return <div className="actual-differences"><strong>Actual difference</strong>{changes.map(([label, value]) => <p key={label}><span>{label}</span>{value}</p>)}</div>;
}

function StepDrawer({ state, onClose, onSaved }: { state: Exclude<DrawerState, null>; onClose: () => void; onSaved: () => Promise<void> }) {
  const editing = state.mode === "edit";
  const step = editing ? state.step : null;
  const [title, setTitle] = useState(step?.title || "");
  const [status, setStatus] = useState<StepStatus>(step?.status || "pending");
  const [toolName, setToolName] = useState(step?.toolName || "");
  const [parametersText, setParametersText] = useState(step?.parametersText || "");
  const [commentsText, setCommentsText] = useState(step?.commentsText || "");
  const [deviationNote, setDeviationNote] = useState(step?.deviationNote || "");
  const [image, setImage] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isTemplateStep = step?.origin === "template";

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!state.column.run) return;
    if (!isTemplateStep && !title.trim()) { setError("Step name is required."); return; }
    setSaving(true); setError("");
    try {
      let assetKey: string | undefined;
      if (image) {
        const compressed = await compressLayerStackImage(image);
        assetKey = (await api.uploadAsset(compressed, compressed.name)).key;
      }
      if (editing) {
        await api.updateRunStep(state.column.sample.id, state.column.run.id, state.step.id, {
          status,
          title: isTemplateStep ? state.step.title : title,
          toolName,
          parametersText,
          commentsText,
          deviationNote,
          notes: state.step.notes || "",
          expectedUpdatedAt: state.step.updatedAt,
          assetKey,
        });
      } else {
        await api.createRunStep(state.column.sample.id, state.column.run.id, {
          afterStepId: state.afterStepId,
          title,
          toolName,
          parametersText,
          commentsText,
          deviationNote,
          assetKey,
        });
      }
      await onSaved();
      onClose();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  return <div className="step-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="step-drawer" role="dialog" aria-modal="true" aria-labelledby="step-drawer-title">
      <div className="step-drawer-heading"><div><p className="eyebrow">{state.column.sample.code}</p><h2 id="step-drawer-title">{editing ? "Correct execution" : "Add an individual step"}</h2></div><button type="button" className="drawer-close" aria-label="Close" onClick={onClose}>×</button></div>
      <p className="muted">{editing ? "Record what actually happened. The assigned recipe stays unchanged." : "This step belongs only to this sample run."}</p>
      <form className="drawer-form" onSubmit={save}>
        {isTemplateStep ? <div className="locked-step-title"><small>Recipe step</small><strong>{step?.plannedTitle || step?.title}</strong></div> : <label>Step name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>}
        {editing && <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as StepStatus)}>{STATUSES.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></label>}
        <label>Actual tool<input value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder={step?.plannedToolName || "Tool used"} /></label>
        <label>Actual parameters<textarea rows={4} value={parametersText} onChange={(event) => setParametersText(event.target.value)} placeholder={step?.plannedParametersText || "Time, temperature, settings…"} /></label>
        <label>What happened<textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} placeholder="Execution detail, not a recipe edit" /></label>
        <label>Reason for deviation<textarea rows={3} value={deviationNote} onChange={(event) => setDeviationNote(event.target.value)} /></label>
        <FileDropzone compact accept="image/*" capture="environment" file={image} onFile={setImage} label="Add an execution image" />
        {error && <p className="error-banner">{error}</p>}
        <div className="form-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? "Saving…" : editing ? "Save correction" : "Add step"}</button></div>
      </form>
    </aside>
  </div>;
}

export function MultiSampleRunGrid({ columns, primaryRun, onSaved }: { columns: RunGridColumn[]; primaryRun: SampleRun; onSaved: () => Promise<void> }) {
  const rows = useMemo(() => buildRunGrid(columns), [columns]);
  const [selected, setSelected] = useState(() => new Set(columns.filter((column) => column.run).map((column) => column.sample.id)));
  const [commonCommentRow, setCommonCommentRow] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteCommentRequest | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [scrollState, setScrollState] = useState({ overflow: false, left: false, right: false });
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const currentNode = scroller.current;
    if (!currentNode) return;
    const node: HTMLDivElement = currentNode;
    function syncScrollState() {
      const overflow = node.scrollWidth > node.clientWidth + 1;
      setScrollState({
        overflow,
        left: overflow && node.scrollLeft > 1,
        right: overflow && node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      });
    }
    syncScrollState();
    node.addEventListener("scroll", syncScrollState, { passive: true });
    window.addEventListener("resize", syncScrollState);
    return () => {
      node.removeEventListener("scroll", syncScrollState);
      window.removeEventListener("resize", syncScrollState);
    };
  }, [columns.length]);

  const availableColumns = columns.filter((column) => column.run);
  const allSelected = availableColumns.length > 0 && availableColumns.every((column) => selected.has(column.sample.id));

  function toggleColumn(sampleId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sampleId)) next.delete(sampleId); else next.add(sampleId);
      return next;
    });
  }

  function scrollColumns(direction: -1 | 1) {
    const node = scroller.current;
    const sampleHeader = node?.querySelector<HTMLElement>(".sample-column-header");
    if (!node || !sampleHeader) return;
    const columnWidth = sampleHeader.getBoundingClientRect().width;
    const nextColumn = Math.round(node.scrollLeft / columnWidth) + direction;
    node.scrollTo({ left: Math.max(0, nextColumn * columnWidth), behavior: "smooth" });
  }

  async function confirmSteps(rowKey: string, entries: Array<{ column: RunGridColumn; step: RunStep }>) {
    const eligible = entries.filter(({ column, step }) => selected.has(column.sample.id) && ["pending", "in_progress"].includes(step.status));
    if (!eligible.length) return;
    setPendingAction(`confirm:${rowKey}`); setError("");
    try {
      await api.confirmRunSteps({ targets: eligible.map(({ column, step }) => target(column, step)) });
      await onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setPendingAction(null); }
  }

  async function addComment(scope: "common" | "individual", entries: Array<{ column: RunGridColumn; step: RunStep }>, body: string, image: File | null, actionKey: string) {
    const trimmed = body.trim();
    const targets = entries.filter(({ column }) => scope === "individual" || selected.has(column.sample.id));
    if ((!trimmed && !image) || !targets.length) return false;
    setPendingAction(actionKey); setError("");
    try {
      let assetKey: string | undefined;
      if (image) {
        const compressed = await compressCommentImage(image);
        assetKey = (await api.uploadAsset(compressed.main, compressed.main.name)).key;
      }
      await api.addRunStepComments({ scope, body: trimmed, assetKey, targets: targets.map(({ column, step }) => target(column, step)) });
      setCommonCommentRow(null);
      await onSaved();
      return true;
    } catch (error) { setError((error as Error).message); return false; }
    finally { setPendingAction(null); }
  }

  async function deleteComment() {
    if (!deleteRequest) return;
    const actionKey = `delete:${deleteRequest.comment.id}`;
    setPendingAction(actionKey); setDeleteError(""); setError("");
    try {
      await api.deleteRunStepComment(deleteRequest.comment.id);
      setDeleteRequest(null);
      await onSaved();
    } catch (error) { setDeleteError((error as Error).message); }
    finally { setPendingAction(null); }
  }

  async function markDone(column: RunGridColumn, step: RunStep) {
    setPendingAction(`done:${step.id}`); setError("");
    try {
      await api.updateRunStep(column.sample.id, column.run!.id, step.id, {
        status: "done",
        title: step.title,
        toolName: step.toolName || "",
        parametersText: step.parametersText || "",
        commentsText: step.commentsText || "",
        deviationNote: step.deviationNote || "",
        notes: step.notes || "",
        expectedUpdatedAt: step.updatedAt,
      });
      await onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setPendingAction(null); }
  }

  async function verifyState(column: RunGridColumn, step: RunStep, result: "matched" | "mismatched") {
    if (!column.run) return;
    const note = result === "mismatched" ? window.prompt("Describe how the observed state differs from the recipe expectation:") : "";
    if (result === "mismatched" && note === null) return;
    setPendingAction(`verify:${step.id}`); setError("");
    try {
      await api.verifyState(column.sample.id, column.run.id, step.id, {
        result, note: note || "", expectedUpdatedAt: step.updatedAt,
        completeStep: ["pending", "in_progress"].includes(step.status),
      });
      await onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setPendingAction(null); }
  }

  function renderStepContent(column: RunGridColumn, step: RunStep) {
    return <StepCell
      column={column}
      step={step}
      pendingAction={pendingAction}
      onDone={() => void markDone(column, step)}
      onVerify={(result) => void verifyState(column, step, result)}
      onSaveComment={(body, image) => addComment("individual", [{ column, step }], body, image, `comment:${step.id}`)}
      onDeleteComment={(comment) => { setDeleteError(""); setDeleteRequest({ comment, common: false }); }}
      onEdit={() => setDrawer({ mode: "edit", column, step })}
      onAddAfter={() => setDrawer({ mode: "add", column, afterStepId: step.id })}
    />;
  }

  const layoutClass = `sample-count-${Math.min(columns.length, 4)}`;
  return <article className={`run-grid-card ${layoutClass}`}>
    <div className="run-grid-toolbar">
      <div><p className="eyebrow">{primaryRun.templateType} · run {primaryRun.sequenceNo} · plan r{primaryRun.planRevisionNumber}</p><h2>{primaryRun.templateName} v{primaryRun.templateVersion}</h2><small>{primaryRun.status === "active" ? "Recipe on the left; actual execution stays in each sample column." : `${primaryRun.status} run · preserved in the sample chain`}</small></div>
      <div className="grid-scroll-buttons" aria-label="Sample columns">{scrollState.overflow && <button type="button" disabled={!scrollState.left} onClick={() => scrollColumns(-1)} aria-label="Scroll sample columns left">←</button>}<span>{columns.length} sample{columns.length === 1 ? "" : "s"}</span>{scrollState.overflow && <button type="button" disabled={!scrollState.right} onClick={() => scrollColumns(1)} aria-label="Scroll sample columns right">→</button>}</div>
    </div>
    {error && <p className="error-banner grid-error">{error}</p>}
    <div className="run-grid-scroll" ref={scroller}>
      <div className="run-grid" style={{ "--sample-columns": columns.length } as React.CSSProperties}>
        <div className="run-grid-header recipe-column">
          <strong>Recipe step</strong>
          <small>Common actions use checked samples</small>
        </div>
        {columns.map((column) => <div className="run-grid-header sample-column-header" key={column.sample.id}>
          <label><input type="checkbox" checked={selected.has(column.sample.id)} disabled={!column.run} onChange={() => toggleColumn(column.sample.id)} /><span><strong>{column.sample.code}</strong><small>{column.sample.title}</small></span></label>
          {!column.run && <em>No matching run</em>}
        </div>)}

        <div className="bulk-selector recipe-column">
          <label><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(availableColumns.map((column) => column.sample.id)))} />{allSelected ? "Clear all" : "Select all"}</label>
        </div>
        {columns.map((column) => <div className="bulk-selector" key={`selected:${column.sample.id}`}>{column.run && <small>{selected.has(column.sample.id) ? "Included in common actions" : "Individual only"}</small>}</div>)}

        {rows.map((row, rowIndex) => {
          const entries = row.steps.flatMap((step, columnIndex) => step ? [{ step, column: columns[columnIndex] }] : []);
          const commonGroups = new Map<string, { comment: RunStepComment; codes: string[] }>();
          entries.forEach(({ step, column }) => step.comments.filter((comment) => comment.scope === "common").forEach((comment) => {
            const key = comment.operationGroupId || comment.id;
            const existing = commonGroups.get(key);
            if (existing) existing.codes.push(column.sample.code); else commonGroups.set(key, { comment, codes: [column.sample.code] });
          }));
          const eligibleCount = entries.filter(({ column, step }) => selected.has(column.sample.id) && ["pending", "in_progress"].includes(step.status)).length;
          const recipeNumber = rowIndex + 1;
          return <div className="run-grid-row" key={row.key} style={{ display: "contents" }}>
            <div className="recipe-cell recipe-column">
              <div className="recipe-step-heading"><span>{recipeNumber}</span><div><strong>{row.recipeStep?.plannedTitle || row.recipeStep?.title}</strong>{row.recipeStep?.plannedToolName && <small>{row.recipeStep.plannedToolName}</small>}</div></div>
              <div className="recipe-content-split"><div>{row.recipeStep?.plannedParametersText && <div className="recipe-field"><small>Parameters</small><p>{row.recipeStep.plannedParametersText}</p></div>}{row.recipeStep?.plannedCommentsText && <div className="recipe-field"><small>Recipe note</small><p>{row.recipeStep.plannedCommentsText}</p></div>}</div>{row.recipeStep && <DiagramGallery keys={row.recipeStep.plannedImageKeys} label={`Recipe diagram for ${row.recipeStep.title}`} size="wide" />}</div>
              {commonGroups.size > 0 && <div className="common-comments"><small>Common execution comments</small>{[...commonGroups.values()].map(({ comment, codes }) => <CommentCard
                key={comment.operationGroupId || comment.id}
                comment={comment}
                common
                meta={`${codes.join(", ")} · ${comment.actorEmail || "Unknown user"} · ${new Date(comment.createdAt).toLocaleString()}`}
                imageLabel="Common comment photo"
                onDelete={() => { setDeleteError(""); setDeleteRequest({ comment, common: true }); }}
              />)}</div>}
              <div className="recipe-actions"><button type="button" className="button primary compact-button" title={`Confirm ${eligibleCount} selected sample step${eligibleCount === 1 ? "" : "s"} as done`} disabled={!eligibleCount || pendingAction !== null} onClick={() => void confirmSteps(row.key, entries)}>{pendingAction === `confirm:${row.key}` ? "Saving…" : `Done · ${eligibleCount}`}</button><button type="button" className="button compact-button" disabled={!entries.some(({ column }) => selected.has(column.sample.id))} onClick={() => setCommonCommentRow(commonCommentRow === row.key ? null : row.key)}>Comment</button></div>
              {commonCommentRow === row.key && <CommentComposer label="Add to checked samples" saving={pendingAction === `common:${row.key}`} onCancel={() => setCommonCommentRow(null)} onSave={(body, image) => addComment("common", entries, body, image, `common:${row.key}`)} />}
            </div>
            {columns.map((column, columnIndex) => {
              const step = row.steps[columnIndex];
              const before = row.adHocBefore[columnIndex];
              const after = row.adHocAfter[columnIndex];
              const hasNestedSteps = before.length > 0 || after.length > 0;
              return <div className={`sample-step-cell${step ? ` step-status-${step.status}` : hasNestedSteps ? " has-nested-steps" : " empty-cell"}`} key={`${row.key}:${column.sample.id}`}>
                {before.length > 0 && <div className="ad-hoc-step-stack before-recipe-step" aria-label="Individual steps before this recipe step">{before.map((adHocStep) => <section className={`ad-hoc-inline step-status-${adHocStep.status}`} key={adHocStep.id}>{renderStepContent(column, adHocStep)}</section>)}</div>}
                {step ? renderStepContent(column, step) : !hasNestedSteps && <span className="not-applicable">—</span>}
                {after.length > 0 && <div className="ad-hoc-step-stack" aria-label="Individual steps after this recipe step">{after.map((adHocStep) => <section className={`ad-hoc-inline step-status-${adHocStep.status}`} key={adHocStep.id}>{renderStepContent(column, adHocStep)}</section>)}</div>}
              </div>;
            })}
          </div>;
        })}
      </div>
    </div>
    {drawer && <StepDrawer key={`${drawer.mode}:${drawer.mode === "edit" ? drawer.step.id : `${drawer.column.sample.id}:${drawer.afterStepId || "first"}`}`} state={drawer} onClose={() => setDrawer(null)} onSaved={onSaved} />}
    {deleteRequest && <ConfirmDeleteDialog
      title="Remove this comment?"
      description={deleteRequest.common ? "This common comment will be removed from every sample included when it was added." : "This comment will be removed from this sample step."}
      summary={deleteRequest.comment.body.trim() || (deleteRequest.comment.assetKey ? "Photo comment" : "Empty comment")}
      deleting={pendingAction === `delete:${deleteRequest.comment.id}`}
      error={deleteError}
      onCancel={() => { setDeleteRequest(null); setDeleteError(""); }}
      onConfirm={() => void deleteComment()}
    />}
  </article>;
}

function CommentComposer({ label, saving, onSave, onCancel }: { label: string; saving: boolean; onSave: (body: string, image: File | null) => Promise<boolean>; onCancel?: () => void }) {
  const [body, setBody] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imageError, setImageError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!image) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(image);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  function chooseImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setImageError("Only image files can be attached."); return; }
    setImageError(""); setImage(file);
  }

  function resizeTextarea() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(112, textarea.scrollHeight)}px`;
  }

  return <form className={`grid-comment-composer${dragging ? " dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseImage(event.dataTransfer.files[0]); }} onSubmit={(event) => { event.preventDefault(); void onSave(body, image).then((saved) => { if (saved) { setBody(""); setImage(null); requestAnimationFrame(resizeTextarea); } }); }}>
    {dragging && <div className="comment-drop-overlay">Drop photo here</div>}
    <div className="comment-composer-row">
      <textarea ref={textareaRef} rows={1} aria-label={label} value={body} onInput={resizeTextarea} onChange={(event) => setBody(event.target.value)} onPaste={(event) => { const pastedImage = [...event.clipboardData.files].find((file) => file.type.startsWith("image/")); if (pastedImage) chooseImage(pastedImage); }} placeholder={onCancel ? "Add to checked samples…" : "Add a comment…"} />
      <input ref={inputRef} className="comment-file-input" type="file" accept="image/*" capture="environment" onChange={(event) => { chooseImage(event.target.files?.[0]); event.target.value = ""; }} />
      {image && previewUrl ? <div className="pending-comment-image" title={image.name}><img src={previewUrl} alt="Pending comment attachment" /><button type="button" onClick={() => setImage(null)} aria-label="Remove attached photo">×</button></div> : <button type="button" className="comment-attach-button" onClick={() => inputRef.current?.click()} title="Attach a photo, or drop it anywhere in this comment"><span className="comment-attach-icon" aria-hidden="true" /><span className="visually-hidden">Attach photo</span></button>}
      {onCancel && <button type="button" className="comment-cancel-button" onClick={onCancel} aria-label="Cancel common comment" title="Cancel">×</button>}
      <button className="button primary compact-button comment-add-button" disabled={saving || (!body.trim() && !image)}>{saving ? "…" : "Add"}</button>
    </div>
    {imageError && <small className="comment-image-error">{imageError}</small>}
  </form>;
}

function StepCell({ column, step, pendingAction, onDone, onVerify, onSaveComment, onDeleteComment, onEdit, onAddAfter }: {
  column: RunGridColumn; step: RunStep; pendingAction: string | null;
  onDone: () => void; onVerify: (result: "matched" | "mismatched") => void; onSaveComment: (body: string, image: File | null) => Promise<boolean>; onDeleteComment: (comment: RunStepComment) => void; onEdit: () => void; onAddAfter: () => void;
}) {
  const individualComments = step.comments.filter((comment) => comment.scope === "individual");
  const [showStateActions, setShowStateActions] = useState(false);
  const busy = pendingAction !== null;
  return <>
    <div className="cell-status-row">
      <div className={`cell-state cell-state-${step.status}`}><span className={step.status === "done" ? "done-mark" : "state-symbol"}>{step.status === "done" ? "✓" : step.status === "in_progress" ? "↻" : step.status === "skipped" ? "—" : step.status === "blocked" ? "!" : "○"}</span><strong>{step.status.replace("_", " ")}</strong></div>
      <div className="cell-badges">{step.origin === "ad_hoc" && <span className="change-badge">Ad hoc</span>}{step.stateVerification && <span className={`verification-badge ${step.stateVerification.result}`}>{step.stateVerification.result === "matched" ? "Verified" : "Mismatch"} · {step.stateVerification.coveredRunStepIds.length}</span>}</div>
    </div>
    <div className="cell-actions">
      <button type="button" className="done-action" disabled={busy || step.status === "done"} onClick={onDone}>{pendingAction === `done:${step.id}` ? "Saving…" : "Done"}</button>
      <button type="button" disabled={busy} onClick={onEdit}>Correct</button>
      <button type="button" disabled={busy || column.run?.status !== "active"} onClick={onAddAfter}>+ Step</button>
      <button type="button" disabled={busy} aria-expanded={showStateActions} onClick={() => setShowStateActions((shown) => !shown)}>{pendingAction === `verify:${step.id}` ? "Saving…" : "State ▾"}</button>
    </div>
    {showStateActions && <div className="state-action-panel"><button type="button" disabled={busy} onClick={() => { setShowStateActions(false); onVerify("matched"); }}>State verified</button><button type="button" disabled={busy} onClick={() => { setShowStateActions(false); onVerify("mismatched"); }}>State mismatch</button></div>}
    {step.origin === "ad_hoc" && <strong className="ad-hoc-title">{step.title}</strong>}
    <div className="cell-content-split"><div><ActualDifferences step={step} /></div><DiagramGallery keys={step.executionImageKeys} label={`Execution image for ${step.title}`} /></div>
    <CommentList comments={individualComments} onDelete={onDeleteComment} />
    <CommentComposer label="Individual comment" saving={pendingAction === `comment:${step.id}`} onSave={onSaveComment} />
  </>;
}
