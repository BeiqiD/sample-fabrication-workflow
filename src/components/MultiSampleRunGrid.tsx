import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RunStep, RunStepComment, SampleRun, StepStatus } from "../../shared/types";
import { api } from "../lib/api";
import { visibleAlphaBounds } from "../lib/diagramImage";
import { compressCommentImage, compressLayerStackImage } from "../lib/images";
import { buildRunGrid, type RunGridColumn } from "../lib/runGrid";
import { runStepIsModified } from "../lib/runSteps";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { FileDropzone } from "./FileDropzone";
import { ProcessingActionIcon } from "./ProcessingActionIcon";
import { StepStatusIcon } from "./StepStatusIcon";

const STATUSES: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];

type DrawerState =
  | { mode: "edit"; column: RunGridColumn; step: RunStep }
  | { mode: "add"; column: RunGridColumn; afterStepId?: string }
  | null;

type DeleteRequest =
  | { kind: "comment"; comment: RunStepComment; common: boolean }
  | { kind: "comment_asset"; comment: RunStepComment; common: boolean }
  | { kind: "execution_asset"; assetKey: string; column: RunGridColumn; step: RunStep };

type RecipeDetailsState = { step: RunStep; number: number } | null;

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

function DiagramGallery({ keys, label, kind = "diagram", size = "compact", onDelete }: {
  keys: string[];
  label: string;
  kind?: GalleryKind;
  size?: GallerySize;
  onDelete?: (key: string) => void;
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
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setActiveIndex(null); }
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
      return <div className="grid-diagram-item" key={`${key}:${index}`} role="listitem"><button type="button" onClick={() => setActiveIndex(index)} aria-label={`Open ${label} ${index + 1} of ${keys.length}`}>
        {kind === "diagram" ? <DiagramThumbnail src={src} alt={label} /> : <img src={src} alt={label} loading="lazy" />}
      </button>{onDelete && <button type="button" className="diagram-delete-button" title="Delete image" onClick={() => onDelete(key)} aria-label={`Delete ${label} ${index + 1}`}>×</button>}</div>;
    })}</div>
    {lightbox}
  </>;
}

function RecipeDetailsSheet({ state, onClose }: { state: NonNullable<RecipeDetailsState>; onClose: () => void }) {
  const { step, number } = state;
  const hasPlannedCopy = Boolean(step.plannedParametersText || step.plannedCommentsText);
  const hasPlannedDiagrams = step.plannedImageKeys.length > 0;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return createPortal(<div className="recipe-details-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="recipe-details-sheet" role="dialog" aria-modal="true" aria-labelledby="recipe-details-title">
      <div className="recipe-details-handle" aria-hidden="true" />
      <div className="recipe-details-heading">
        <div><p className="eyebrow">Recipe step {number}</p><h2 id="recipe-details-title">{step.plannedTitle || step.title}</h2>{step.plannedToolName && <small>{step.plannedToolName}</small>}</div>
        <button ref={closeButtonRef} type="button" className="drawer-close" onClick={onClose} aria-label="Close recipe details">×</button>
      </div>
      <div className={`recipe-details-content${hasPlannedCopy && hasPlannedDiagrams ? " has-diagrams" : ""}`}>
        {hasPlannedCopy && <div className="recipe-details-copy">
          {step.plannedParametersText && <div className="recipe-field"><small>Parameters</small><p>{step.plannedParametersText}</p></div>}
          {step.plannedCommentsText && <div className="recipe-field"><small>Plan note</small><p>{step.plannedCommentsText}</p></div>}
        </div>}
        <DiagramGallery keys={step.plannedImageKeys} label={`Plan diagram for ${step.title}`} />
        {!hasPlannedCopy && !hasPlannedDiagrams && <p className="muted">No additional recipe details.</p>}
      </div>
    </section>
  </div>, document.body);
}

function CommentCard({ comment, meta, imageLabel, onDelete, onDeleteAsset, common = false }: {
  comment: RunStepComment;
  meta: string;
  imageLabel: string;
  onDelete?: () => void;
  onDeleteAsset?: () => void;
  common?: boolean;
}) {
  return <div className={`cell-comment${common ? " common-comment" : ""}`}>
    <div className="comment-card-content">
      <div className="comment-card-copy">{comment.body && <p>{comment.body}</p>}<small>{meta}</small></div>
      {comment.assetKey && <div className="comment-thumbnail-gallery"><DiagramGallery keys={[comment.assetKey]} label={imageLabel} kind="photo" onDelete={onDeleteAsset ? () => onDeleteAsset() : undefined} /></div>}
    </div>
    {onDelete && <button type="button" className="comment-delete-button" onClick={onDelete} aria-label="Delete comment">Delete</button>}
  </div>;
}

function CommentList({ comments, onDelete, onDeleteAsset }: { comments: RunStepComment[]; onDelete?: (comment: RunStepComment) => void; onDeleteAsset?: (comment: RunStepComment) => void }) {
  if (!comments.length) return null;
  return <div className="comment-history"><div className="cell-comments">{comments.map((comment) => <CommentCard
    key={comment.id}
    comment={comment}
    meta={`${comment.actorEmail || "Unknown user"} · ${new Date(comment.createdAt).toLocaleString()}`}
    imageLabel="Comment photo"
    onDelete={onDelete ? () => onDelete(comment) : undefined}
    onDeleteAsset={onDeleteAsset && comment.assetKey ? () => onDeleteAsset(comment) : undefined}
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
      <p className="muted">{editing ? "Record what actually happened. The assigned plan stays unchanged." : "This step belongs only to this sample run."}</p>
      <form className="drawer-form" onSubmit={save}>
        {isTemplateStep ? <div className="locked-step-title"><small>Recipe step</small><strong>{step?.plannedTitle || step?.title}</strong></div> : <label>Step name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>}
        {editing && <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as StepStatus)}>{STATUSES.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></label>}
        <label>Actual tool<input value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder={step?.plannedToolName || "Tool used"} /></label>
        <label>Actual parameters<textarea rows={4} value={parametersText} onChange={(event) => setParametersText(event.target.value)} placeholder={step?.plannedParametersText || "Time, temperature, settings…"} /></label>
        <label>What happened<textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} placeholder="Execution detail, not a plan edit" /></label>
        <label>Reason for deviation<textarea rows={3} value={deviationNote} onChange={(event) => setDeviationNote(event.target.value)} /></label>
        <FileDropzone compact accept="image/*" capture="environment" file={image} onFile={setImage} label="Add an execution image" />
        {error && <p className="error-banner">{error}</p>}
        <div className="form-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? "Saving…" : editing ? "Save correction" : "Add step"}</button></div>
      </form>
    </aside>
  </div>;
}

export function MultiSampleRunGrid({ columns, primaryRun, onSaved, readOnly = false }: { columns: RunGridColumn[]; primaryRun: SampleRun; onSaved: () => Promise<void>; readOnly?: boolean }) {
  const rows = useMemo(() => buildRunGrid(columns), [columns]);
  const [selected, setSelected] = useState(() => new Set(columns.filter((column) => column.run).map((column) => column.sample.id)));
  const [commonCommentRow, setCommonCommentRow] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [recipeDetails, setRecipeDetails] = useState<RecipeDetailsState>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [scrollState, setScrollState] = useState({ overflow: false, left: false, right: false });
  const [showStickyNames, setShowStickyNames] = useState(false);
  const card = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fullHeader = useRef<HTMLDivElement>(null);
  const stickySampleTrack = useRef<HTMLDivElement>(null);
  const closeRecipeDetails = useCallback(() => setRecipeDetails(null), []);

  useEffect(() => {
    const currentNode = scroller.current;
    const currentCard = card.current;
    const currentHeader = fullHeader.current;
    if (!currentNode || !currentCard || !currentHeader) return;
    const node: HTMLDivElement = currentNode;
    const cardNode: HTMLElement = currentCard;
    const headerNode: HTMLDivElement = currentHeader;
    function syncScrollState() {
      const overflow = node.scrollWidth > node.clientWidth + 1;
      const next = {
        overflow,
        left: overflow && node.scrollLeft > 1,
        right: overflow && node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      };
      setScrollState((current) => current.overflow === next.overflow && current.left === next.left && current.right === next.right ? current : next);
      stickySampleTrack.current?.style.setProperty("transform", `translate3d(${-node.scrollLeft}px, 0, 0)`);
    }
    function syncLayout() {
      const recipeHeader = node.querySelector<HTMLElement>(".run-grid-header.recipe-column");
      const sampleHeader = node.querySelector<HTMLElement>(".sample-column-header");
      const topbar = document.querySelector<HTMLElement>(".topbar");
      if (recipeHeader) cardNode.style.setProperty("--sticky-recipe-width", `${recipeHeader.getBoundingClientRect().width}px`);
      if (sampleHeader) cardNode.style.setProperty("--sticky-sample-width", `${sampleHeader.getBoundingClientRect().width}px`);
      cardNode.style.setProperty("--run-grid-sticky-top", `${Math.ceil(topbar?.getBoundingClientRect().bottom || 0)}px`);
      syncScrollState();
    }
    function syncStickyNames() {
      const topbar = document.querySelector<HTMLElement>(".topbar");
      const stickyTop = Math.ceil(topbar?.getBoundingClientRect().bottom || 0);
      const headerBottom = headerNode.getBoundingClientRect().bottom;
      const cardBottom = cardNode.getBoundingClientRect().bottom;
      const next = headerBottom <= stickyTop + 36 && cardBottom > stickyTop + 36;
      setShowStickyNames((current) => current === next ? current : next);
      cardNode.style.setProperty("--run-grid-sticky-top", `${stickyTop}px`);
    }
    let animationFrame = 0;
    function scheduleStickySync() {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        syncStickyNames();
      });
    }
    syncLayout();
    syncStickyNames();
    node.addEventListener("scroll", syncScrollState, { passive: true });
    window.addEventListener("scroll", scheduleStickySync, { passive: true });
    window.addEventListener("resize", syncLayout);
    window.addEventListener("resize", scheduleStickySync);
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      node.removeEventListener("scroll", syncScrollState);
      window.removeEventListener("scroll", scheduleStickySync);
      window.removeEventListener("resize", syncLayout);
      window.removeEventListener("resize", scheduleStickySync);
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

  async function confirmDelete() {
    if (!deleteRequest) return;
    const actionKey = deleteRequest.kind === "execution_asset"
      ? `delete-asset:${deleteRequest.step.id}:${deleteRequest.assetKey}`
      : `delete:${deleteRequest.comment.id}:${deleteRequest.kind}`;
    setPendingAction(actionKey); setDeleteError(""); setError("");
    try {
      if (deleteRequest.kind === "comment") await api.deleteRunStepComment(deleteRequest.comment.id);
      else if (deleteRequest.kind === "comment_asset") await api.deleteRunStepCommentAsset(deleteRequest.comment.id);
      else await api.deleteRunStepAsset(deleteRequest.column.sample.id, deleteRequest.column.run!.id, deleteRequest.step.id, deleteRequest.assetKey);
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
    const note = result === "mismatched" ? window.prompt("Describe how the observed state differs from the planned expectation:") : "";
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
      onDeleteComment={(comment) => { setDeleteError(""); setDeleteRequest({ kind: "comment", comment, common: false }); }}
      onDeleteCommentAsset={(comment) => { setDeleteError(""); setDeleteRequest({ kind: "comment_asset", comment, common: false }); }}
      onDeleteExecutionAsset={(assetKey) => { setDeleteError(""); setDeleteRequest({ kind: "execution_asset", assetKey, column, step }); }}
      onEdit={() => setDrawer({ mode: "edit", column, step })}
      onAddAfter={() => setDrawer({ mode: "add", column, afterStepId: step.id })}
      readOnly={readOnly}
    />;
  }

  const layoutClass = `sample-count-${Math.min(columns.length, 4)}`;
  return <article className={`run-grid-card ${layoutClass}`} ref={card}>
    <div className="run-grid-toolbar">
      <div><p className="eyebrow">{primaryRun.templateType} · run {primaryRun.sequenceNo} · plan r{primaryRun.planRevisionNumber}</p><h2>{primaryRun.templateName} v{primaryRun.templateVersion}</h2><small>{primaryRun.status === "active" ? "Plan on the left; actual execution stays in each sample column." : `${primaryRun.status} run · preserved in the sample chain`}</small></div>
      <div className="grid-scroll-buttons" aria-label="Sample columns">{scrollState.overflow && <button type="button" disabled={!scrollState.left} onClick={() => scrollColumns(-1)} aria-label="Scroll sample columns left">←</button>}<span>{columns.length} sample{columns.length === 1 ? "" : "s"}</span>{scrollState.overflow && <button type="button" disabled={!scrollState.right} onClick={() => scrollColumns(1)} aria-label="Scroll sample columns right">→</button>}</div>
    </div>
    {error && <p className="error-banner grid-error">{error}</p>}
    <div className={`run-grid-sticky-names${showStickyNames ? " visible" : ""}`} aria-hidden="true">
      <div className="sticky-recipe-name">Recipe</div>
      <div className="sticky-sample-viewport">
        <div className="sticky-sample-track" ref={stickySampleTrack}>
          {columns.map((column) => <div className="sticky-sample-name" key={`sticky:${column.sample.id}`} title={`${column.sample.title} · ${column.sample.code}`}>{column.sample.title}</div>)}
        </div>
      </div>
    </div>
    <div className="run-grid-scroll" ref={scroller}>
      <div className="run-grid" style={{ "--sample-columns": columns.length } as React.CSSProperties}>
        <div className="run-grid-header recipe-column" ref={fullHeader}>
          <strong>Recipe step</strong>
          <small>Common actions use checked samples</small>
        </div>
        {columns.map((column) => <div className="run-grid-header sample-column-header" key={column.sample.id}>
          <label><input type="checkbox" checked={selected.has(column.sample.id)} disabled={!column.run || readOnly} onChange={() => toggleColumn(column.sample.id)} /><span><strong>{column.sample.title}</strong><small>{column.sample.code}</small></span></label>
          {!column.run && <em>No matching run</em>}
        </div>)}

        <div className="bulk-selector recipe-column">
          <label><input type="checkbox" checked={allSelected} disabled={readOnly} onChange={() => setSelected(allSelected ? new Set() : new Set(availableColumns.map((column) => column.sample.id)))} />{readOnly ? "Read only" : allSelected ? "Clear all" : "Select all"}</label>
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
          const recipeNumber = rows.slice(0, rowIndex + 1).filter((candidate) => candidate.kind === "template").length;
          return <div className="run-grid-row" key={row.key} style={{ display: "contents" }}>
            <div className={`recipe-cell recipe-column${row.kind === "ad_hoc" ? " additional-step-recipe-cell" : ""}`}>
              {row.kind === "ad_hoc" ? <div className="recipe-step-heading additional-step-heading"><span>+</span><div><strong>Additional step</strong><small>Not part of the assigned recipe</small></div></div> : <>
              <div className="recipe-step-heading recipe-step-heading-desktop"><span>{recipeNumber}</span><div><strong>{row.recipeStep?.plannedTitle || row.recipeStep?.title}</strong>{row.recipeStep?.plannedToolName && <small>{row.recipeStep.plannedToolName}</small>}</div></div>
              {row.recipeStep && <button type="button" className="recipe-step-heading recipe-details-trigger" onClick={() => setRecipeDetails({ step: row.recipeStep!, number: recipeNumber })} aria-label={`View recipe details for ${row.recipeStep.plannedTitle || row.recipeStep.title}`}><span className="recipe-step-number">{recipeNumber}</span><strong>{row.recipeStep.plannedTitle || row.recipeStep.title}</strong><svg className="recipe-details-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6" /></svg></button>}
              <div className="recipe-content-split recipe-desktop-details"><div>{row.recipeStep?.plannedParametersText && <div className="recipe-field"><small>Parameters</small><p>{row.recipeStep.plannedParametersText}</p></div>}{row.recipeStep?.plannedCommentsText && <div className="recipe-field"><small>Plan note</small><p>{row.recipeStep.plannedCommentsText}</p></div>}</div>{row.recipeStep && <DiagramGallery keys={row.recipeStep.plannedImageKeys} label={`Plan diagram for ${row.recipeStep.title}`} size="wide" />}</div>
              {commonGroups.size > 0 && <div className="common-comments"><small>Common execution comments</small>{[...commonGroups.values()].map(({ comment, codes }) => <CommentCard
                key={comment.operationGroupId || comment.id}
                comment={comment}
                common
                meta={`${codes.join(", ")} · ${comment.actorEmail || "Unknown user"} · ${new Date(comment.createdAt).toLocaleString()}`}
                imageLabel="Common comment photo"
                onDelete={() => { setDeleteError(""); setDeleteRequest({ kind: "comment", comment, common: true }); }}
                onDeleteAsset={comment.assetKey ? () => { setDeleteError(""); setDeleteRequest({ kind: "comment_asset", comment, common: true }); } : undefined}
              />)}</div>}
              {!readOnly && <><div className="recipe-actions"><button type="button" className="button primary compact-button recipe-icon-action" title={pendingAction === `confirm:${row.key}` ? "Saving…" : `Confirm ${eligibleCount} selected sample step${eligibleCount === 1 ? "" : "s"} as done`} aria-label={pendingAction === `confirm:${row.key}` ? "Saving confirmed steps" : `Confirm ${eligibleCount} selected sample step${eligibleCount === 1 ? "" : "s"} as done`} aria-busy={pendingAction === `confirm:${row.key}`} disabled={!eligibleCount || pendingAction !== null} onClick={() => void confirmSteps(row.key, entries)}><ProcessingActionIcon name="done" /><span className="recipe-action-label">{pendingAction === `confirm:${row.key}` ? "Saving…" : `Done · ${eligibleCount}`}</span></button><button type="button" className="button compact-button recipe-icon-action" title="Comment on selected samples" aria-label="Comment on selected samples" aria-expanded={commonCommentRow === row.key} disabled={!entries.some(({ column }) => selected.has(column.sample.id))} onClick={() => setCommonCommentRow(commonCommentRow === row.key ? null : row.key)}><ProcessingActionIcon name="comment" /><span className="recipe-action-label">Comment</span></button></div>
              {commonCommentRow === row.key && <CommentComposer label="Add to checked samples" saving={pendingAction === `common:${row.key}`} onCancel={() => setCommonCommentRow(null)} onSave={(body, image) => addComment("common", entries, body, image, `common:${row.key}`)} />}</>}</>}
            </div>
            {columns.map((column, columnIndex) => {
              const step = row.steps[columnIndex];
              return <div className={`sample-step-cell${step ? ` step-status-${step.status}` : " empty-cell"}${row.kind === "ad_hoc" ? " additional-step-cell" : ""}`} key={`${row.key}:${column.sample.id}`}>
                {step ? renderStepContent(column, step) : <span className="not-applicable">—</span>}
              </div>;
            })}
          </div>;
        })}
      </div>
    </div>
    {drawer && <StepDrawer key={`${drawer.mode}:${drawer.mode === "edit" ? drawer.step.id : `${drawer.column.sample.id}:${drawer.afterStepId || "first"}`}`} state={drawer} onClose={() => setDrawer(null)} onSaved={onSaved} />}
    {recipeDetails && <RecipeDetailsSheet state={recipeDetails} onClose={closeRecipeDetails} />}
    {deleteRequest && <ConfirmDeleteDialog
      title={deleteRequest.kind === "comment" ? "Delete this comment?" : deleteRequest.kind === "comment_asset" ? "Delete this comment attachment?" : "Delete this execution image?"}
      description={deleteRequest.kind === "comment"
        ? (deleteRequest.common ? "This common comment will be removed from every sample included when it was added. The audit history will remain." : "This comment will be removed from this sample step. The audit history will remain.")
        : deleteRequest.kind === "comment_asset"
          ? (deleteRequest.common ? "The attached image will be removed from every copy of this common comment; the text and audit history will remain." : "The attached image will be removed; the comment text and audit history will remain.")
          : "The image will be detached from this execution step; the Timeline will retain a text-only deletion event."}
      summary={deleteRequest.kind === "execution_asset" ? deleteRequest.step.title : deleteRequest.comment.body.trim() || "Image attachment"}
      deleting={pendingAction !== null && pendingAction.startsWith("delete")}
      error={deleteError}
      eyebrow={deleteRequest.kind === "comment" ? "Delete comment" : "Delete image"}
      confirmLabel={deleteRequest.kind === "comment" ? "Delete comment" : "Delete image"}
      onCancel={() => { setDeleteRequest(null); setDeleteError(""); }}
      onConfirm={() => void confirmDelete()}
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

function StepCell({ column, step, pendingAction, onDone, onVerify, onSaveComment, onDeleteComment, onDeleteCommentAsset, onDeleteExecutionAsset, onEdit, onAddAfter, readOnly }: {
  column: RunGridColumn; step: RunStep; pendingAction: string | null;
  onDone: () => void; onVerify: (result: "matched" | "mismatched") => void; onSaveComment: (body: string, image: File | null) => Promise<boolean>; onDeleteComment: (comment: RunStepComment) => void; onDeleteCommentAsset: (comment: RunStepComment) => void; onDeleteExecutionAsset: (assetKey: string) => void; onEdit: () => void; onAddAfter: () => void; readOnly: boolean;
}) {
  const individualComments = step.comments.filter((comment) => comment.scope === "individual");
  const [showStateActions, setShowStateActions] = useState(false);
  const busy = pendingAction !== null;
  return <>
    <div className="cell-status-row">
      <div className={`cell-state cell-state-${step.status}`}><span className={step.status === "done" ? "done-mark" : "state-symbol"}><StepStatusIcon status={step.status} /></span><strong>{step.status.replace("_", " ")}</strong></div>
      <div className="cell-badges">{step.origin === "ad_hoc" && <span className="change-badge">Ad hoc</span>}{step.stateVerification && <span className={`verification-badge ${step.stateVerification.result}`}>{step.stateVerification.result === "matched" ? "Verified" : "Mismatch"} · {step.stateVerification.coveredRunStepIds.length}</span>}</div>
    </div>
    {!readOnly && <div className="cell-actions">
      <button type="button" className="done-action" disabled={busy || step.status === "done"} onClick={onDone}>{pendingAction === `done:${step.id}` ? "Saving…" : "Done"}</button>
      <button type="button" disabled={busy} onClick={onEdit}>Correct</button>
      <button type="button" disabled={busy || column.run?.status !== "active"} onClick={onAddAfter}>+ Step</button>
      <button type="button" disabled={busy} aria-expanded={showStateActions} onClick={() => setShowStateActions((shown) => !shown)}>{pendingAction === `verify:${step.id}` ? "Saving…" : "State ▾"}</button>
    </div>}
    {!readOnly && showStateActions && <div className="state-action-panel"><button type="button" disabled={busy} onClick={() => { setShowStateActions(false); onVerify("matched"); }}>State verified</button><button type="button" disabled={busy} onClick={() => { setShowStateActions(false); onVerify("mismatched"); }}>State mismatch</button></div>}
    {step.origin === "ad_hoc" && <strong className="ad-hoc-title">{step.title}</strong>}
    <div className="cell-content-split"><div><ActualDifferences step={step} /></div><DiagramGallery keys={step.executionImageKeys} label={`Execution image for ${step.title}`} onDelete={onDeleteExecutionAsset} /></div>
    <CommentList comments={individualComments} onDelete={onDeleteComment} onDeleteAsset={onDeleteCommentAsset} />
    {!readOnly && <CommentComposer label="Individual comment" saving={pendingAction === `comment:${step.id}`} onSave={onSaveComment} />}
  </>;
}
