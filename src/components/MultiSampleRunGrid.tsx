import { Fragment, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommentSubmission, CreateCommentSubmissionInput, RunStep, RunStepComment, SampleRun, StepStatus } from "../../shared/types";
import { api, type MetrologyTemplateInput, type MetrologyTemplateSummary } from "../lib/api";
import { visibleAlphaBounds } from "../lib/diagramImage";
import { compressLayerStackImage } from "../lib/images";
import {
  buildRunGrid,
  findCurrentRunGridRow,
  runGridSectionProgress,
  visibleRunGridSections,
  type RunGridColumn,
} from "../lib/runGrid";
import { runStepIsModified, runStepIsReadOnly } from "../lib/runSteps";
import { pendingRunStepActionTargets } from "../lib/runGridActions";
import { CommentAttachmentList } from "./CommentAttachmentList";
import { CommentComposer, CommentSubmissionRecovery } from "./CommentComposer";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { DialogCloseIcon } from "./DialogCloseIcon";
import { FileDropzone } from "./FileDropzone";
import { MetrologyTemplateForm } from "./MetrologyTemplateForm";
import { ProcessPlanCommentButton } from "./ProcessPlanCommentButton";
import { ProcessingActionIcon } from "./ProcessingActionIcon";
import { StepStatusIcon } from "./StepStatusIcon";

const STATUSES: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];

type DrawerState =
  | { mode: "edit"; column: RunGridColumn; step: RunStep }
  | { mode: "add"; column: RunGridColumn; afterStepId?: string }
  | null;

type MetrologyDrawerState = { column: RunGridColumn; afterStepId?: string } | null;

type DeleteRequest =
  | { kind: "comment"; comment: RunStepComment; common: boolean }
  | { kind: "comment_asset"; comment: RunStepComment; common: boolean }
  | { kind: "execution_asset"; assetKey: string; column: RunGridColumn; step: RunStep };

type RecipeDetailsState = { step: RunStep; number: number } | null;
type CommonCommentGroup = { comment: RunStepComment; codes: string[] };
type RunStepCommentContext = Extract<CreateCommentSubmissionInput["context"], { kind: "run_steps" }>;
type JumpButtonGeometry = { baseEligible: boolean; overlapsGrid: boolean };

const JUMP_SCROLL_DOWN_THRESHOLD = 30;
const JUMP_SCROLL_UP_THRESHOLD = 14;
const JUMP_HIGHLIGHT_DURATION = 1000;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function JumpToCurrentIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="3.25" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
  </svg>;
}

function waitForScrollToSettle(scroller: HTMLDivElement) {
  return new Promise<void>((resolve) => {
    const startedAt = performance.now();
    let lastWindowY = window.scrollY;
    let lastScrollerX = scroller.scrollLeft;
    let stableFrames = 0;
    let moved = false;

    function check(now: number) {
      const windowY = window.scrollY;
      const scrollerX = scroller.scrollLeft;
      const stable = Math.abs(windowY - lastWindowY) < .5 && Math.abs(scrollerX - lastScrollerX) < .5;
      if (stable) stableFrames += 1;
      else {
        moved = true;
        stableFrames = 0;
      }
      lastWindowY = windowY;
      lastScrollerX = scrollerX;

      if ((now - startedAt > 120 && stableFrames >= 4 && (moved || now - startedAt > 250)) || now - startedAt > 1600) {
        resolve();
        return;
      }
      window.requestAnimationFrame(check);
    }

    window.requestAnimationFrame(check);
  });
}

function target(column: RunGridColumn, step: RunStep) {
  if (!column.run) throw new Error("This sample has no matching run");
  return {
    sampleId: column.sample.id,
    runId: column.run.id,
    stepId: step.id,
    expectedUpdatedAt: step.updatedAt,
  };
}

function useMobileRunGrid() {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const sync = () => setMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return mobile;
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

export function DiagramGallery({ keys, label, kind = "diagram", size = "compact", onDelete, className = "" }: {
  keys: string[];
  label: string;
  kind?: GalleryKind;
  size?: GallerySize;
  onDelete?: (key: string) => void;
  className?: string;
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
        <button ref={closeButtonRef} type="button" className="lightbox-close" onClick={() => setActiveIndex(null)} aria-label="Close image viewer"><DialogCloseIcon /></button>
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
    <div className={`grid-diagrams ${kind}-thumbnails ${size}-thumbnails ${className}`.trim()} role="list">{keys.map((key, index) => {
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
        <div><p className="dialog-kicker">Process step {number}</p><h2 id="recipe-details-title">{step.plannedTitle || step.title}</h2>{step.plannedToolName && <small>{step.plannedToolName}</small>}</div>
        <button ref={closeButtonRef} type="button" className="drawer-close" onClick={onClose} aria-label="Close process-step details"><DialogCloseIcon /></button>
      </div>
      <div className={`recipe-details-content${hasPlannedCopy && hasPlannedDiagrams ? " has-diagrams" : ""}`}>
        {hasPlannedCopy && <div className="recipe-details-copy">
          {step.plannedParametersText && <div className="recipe-field"><small>Parameters</small><p>{step.plannedParametersText}</p></div>}
          {step.plannedCommentsText && <div className="recipe-field"><small>Plan note</small><p>{step.plannedCommentsText}</p></div>}
        </div>}
        <DiagramGallery keys={step.plannedImageKeys} label={`Plan diagram for ${step.title}`} />
        {!hasPlannedCopy && !hasPlannedDiagrams && <p className="muted">No additional process-step details.</p>}
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
  const imageKeys = (comment.images ?? []).flatMap((image) => image.assetKey ? [image.assetKey] : []);
  const attachments = comment.attachments ?? [];
  const incomplete = comment.status && comment.status !== "ready";
  return <div className={`cell-comment${common ? " common-comment" : ""}`}>
    <div className="comment-card-content">
      <div className="comment-card-copy">
        {incomplete && <strong className={`comment-upload-state status-${comment.status}`}>{comment.status === "failed" ? "Upload incomplete" : "Uploading…"}</strong>}
        {comment.body && <p>{comment.body}</p>}
        <small>{meta}</small>
      </div>
      {(imageKeys.length > 0 || comment.assetKey) && <div className="comment-thumbnail-gallery"><DiagramGallery keys={imageKeys.length ? imageKeys : [comment.assetKey!]} label={imageLabel} kind="photo" onDelete={onDeleteAsset && !comment.submissionId ? () => onDeleteAsset() : undefined} /></div>}
    </div>
    <CommentAttachmentList attachments={attachments} />
    {onDelete && !incomplete && <button type="button" className="comment-delete-button" onClick={onDelete} aria-label="Delete comment">Delete</button>}
  </div>;
}

function recoverableFromComments(comments: RunStepComment[]) {
  const submissions = new Map<string, CommentSubmission>();
  for (const comment of comments) {
    if (!comment.submissionId || !comment.status || ["ready", "cancelled"].includes(comment.status)) continue;
    submissions.set(comment.submissionId, {
      id: comment.submissionId,
      contextKind: "run_steps",
      scope: comment.scope,
      body: comment.body,
      status: comment.status,
      error: null,
      images: comment.images ?? [],
      attachments: comment.attachments ?? [],
      actorEmail: comment.actorEmail,
      createdAt: comment.createdAt,
      updatedAt: comment.createdAt,
    });
  }
  return [...submissions.values()];
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

function ProcessPlanCommentDialog({
  stepName,
  commentContext,
  targets,
  comments,
  recovery,
  readOnly,
  onClose,
  onSubmitted,
  onDelete,
  onDeleteAsset,
}: {
  stepName: string;
  commentContext: "process-plan" | "metrology";
  targets: RunStepCommentContext["targets"];
  comments: CommonCommentGroup[];
  recovery: CommentSubmission[];
  readOnly: boolean;
  onClose: () => void;
  onSubmitted: () => Promise<void>;
  onDelete: (comment: RunStepComment) => void;
  onDeleteAsset: (comment: RunStepComment) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const metrology = commentContext === "metrology";
  const dialogLabel = metrology ? "Metrology comment" : "Process plan comment";
  const commentSubject = metrology ? "metrology record" : "process step";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return createPortal(<div className="process-plan-comment-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="process-plan-comment-dialog" role="dialog" aria-modal="true" aria-labelledby="process-plan-comment-title">
      <div className="process-plan-comment-handle" aria-hidden="true" />
      <div className="process-plan-comment-heading">
        <div>
          <p className="dialog-kicker">{dialogLabel}</p>
          <h2 id="process-plan-comment-title">{stepName}</h2>
          <small>{targets.length} checked sample{targets.length === 1 ? "" : "s"}</small>
        </div>
        <button ref={closeButtonRef} type="button" className="drawer-close" onClick={onClose} aria-label={`Close ${commentContext} comments`}><DialogCloseIcon /></button>
      </div>
      <div className="process-plan-comment-content">
        {!readOnly && targets.length > 0 && <CommentComposer
          label="Add to checked samples"
          context={{ kind: "run_steps", scope: "common", targets }}
          onCancel={onClose}
          onSubmitted={async () => {
            onClose();
            await onSubmitted();
          }}
        />}
        {!readOnly && targets.length === 0 && <p className="muted process-plan-comment-empty-selection">Check one or more samples in the grid to add a common comment.</p>}
        <CommentSubmissionRecovery submissions={recovery} onSubmitted={onSubmitted} />
        <section className="process-plan-comment-history" aria-label={`Existing ${commentContext} comments`}>
          <div className="process-plan-comment-history-heading">
            <small>Execution comments</small>
            {comments.length > 0 && <span className="section-count">{comments.length}</span>}
          </div>
          {comments.length > 0
            ? <div className="cell-comments">{comments.map(({ comment, codes }) => <CommentCard
              key={comment.operationGroupId || comment.id}
              comment={comment}
              common
              meta={`${codes.join(", ")} · ${comment.actorEmail || "Unknown user"} · ${new Date(comment.createdAt).toLocaleString()}`}
              imageLabel="Common comment photo"
              onDelete={() => onDelete(comment)}
              onDeleteAsset={comment.assetKey ? () => onDeleteAsset(comment) : undefined}
            />)}</div>
            : <p className="muted process-plan-comment-empty">No comments on this {commentSubject} yet.</p>}
        </section>
      </div>
    </section>
  </div>, document.body);
}

function ActualDifferences({ step }: { step: RunStep }) {
  if (step.entryKind === "metrology") {
    const details = [
      step.toolName || step.plannedToolName ? ["Tool", step.toolName || step.plannedToolName || "—"] : null,
      step.parametersText || step.plannedParametersText ? ["Parameters", step.parametersText || step.plannedParametersText || "—"] : null,
      step.commentsText || step.plannedCommentsText ? ["Template comment", step.commentsText || step.plannedCommentsText || "—"] : null,
    ].filter((entry): entry is string[] => Boolean(entry));
    return details.length ? <div className="actual-differences metrology-details">{details.map(([label, value]) => <p key={label}><span>{label}</span>{value}</p>)}</div> : null;
  }
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
  const metrology = step?.entryKind === "metrology";
  const isTemplateStep = step?.origin === "template" && !metrology;

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
      <div className="step-drawer-heading"><div><p className="dialog-kicker">{state.column.sample.code}</p><h2 id="step-drawer-title">{editing ? metrology ? "Edit metrology record" : "Correct execution" : "Add fabrication step"}</h2></div><button type="button" className="drawer-close" aria-label="Close" onClick={onClose}><DialogCloseIcon /></button></div>
      <p className="muted">{editing ? metrology ? "Keep the result in comments and attachments; tool and parameters remain optional." : "Record what actually happened. The process plan stays unchanged." : "This fabrication step belongs only to this sample run."}</p>
      <form className="drawer-form" onSubmit={save}>
        {isTemplateStep ? <div className="locked-step-title"><small>Process step</small><strong>{step?.plannedTitle || step?.title}</strong></div> : <label>{metrology ? "Record title" : "Step name"}<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>}
        {editing && <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as StepStatus)}>{STATUSES.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></label>}
        <label>{metrology ? "Tool" : "Actual tool"}<input value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder={step?.plannedToolName || "Tool used"} /></label>
        <label>{metrology ? "Parameters" : "Actual parameters"}<textarea rows={4} value={parametersText} onChange={(event) => setParametersText(event.target.value)} placeholder={step?.plannedParametersText || "Time, temperature, settings…"} /></label>
        <label>{metrology ? "Result note" : "What happened"}<textarea rows={3} value={commentsText} onChange={(event) => setCommentsText(event.target.value)} placeholder={metrology ? "Optional result summary" : "Execution detail, not a plan edit"} /></label>
        {!metrology && <label>Reason for deviation<textarea rows={3} value={deviationNote} onChange={(event) => setDeviationNote(event.target.value)} /></label>}
        <FileDropzone compact accept="image/*" capture="environment" file={image} onFile={setImage} label={metrology ? "Add a result image" : "Add an execution image"} />
        {error && <p className="error-banner">{error}</p>}
        <div className="form-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? "Saving…" : editing ? "Save correction" : "Add step"}</button></div>
      </form>
    </aside>
  </div>;
}

function MetrologyPickerDrawer({ state, onClose, onSaved }: {
  state: NonNullable<MetrologyDrawerState>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [templates, setTemplates] = useState<MetrologyTemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timeout = window.setTimeout(() => {
      api.listMetrologyTemplates({ query, pageSize: 50, signal: controller.signal }).then(({ templates }) => {
        setTemplates(templates);
        setError("");
      }).catch((error: Error) => {
        if (error.name !== "AbortError") setError(error.message);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, query.trim() ? 160 : 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  async function add(templateVersionId: string) {
    if (!state.column.run) return;
    setSavingId(templateVersionId); setError("");
    try {
      await api.createMetrologyRunEntry(state.column.sample.id, state.column.run.id, {
        templateVersionId,
        afterStepId: state.afterStepId,
      });
      await onSaved();
      onClose();
    } catch (error) { setError((error as Error).message); }
    finally { setSavingId(""); }
  }

  async function createAndAdd(input: MetrologyTemplateInput) {
    const created = await api.createMetrologyTemplate(input);
    await add(created.id);
  }

  return <div className="step-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingId) onClose(); }}>
    <aside className="step-drawer metrology-picker-drawer" role="dialog" aria-modal="true" aria-labelledby="metrology-picker-title">
      <div className="step-drawer-heading"><div><p className="dialog-kicker">{state.column.sample.code}</p><h2 id="metrology-picker-title">Add metrology</h2></div><button type="button" className="drawer-close" aria-label="Close" onClick={onClose}><DialogCloseIcon /></button></div>
      <p className="muted">Choose a saved record type, or create a new metrology template and add it here.</p>
      {creating ? <MetrologyTemplateForm embedded title="New metrology template" submitLabel="Save and add" onCancel={() => setCreating(false)} onSubmit={createAndAdd} /> : <>
        <label className="search-box metrology-template-search"><span>Search templates</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SEM, AFM, XRD…" /></label>
        <div className="metrology-picker-list">
          {templates.map((template) => <button type="button" key={template.id} disabled={Boolean(savingId)} onClick={() => void add(template.id)}>
            <span><strong>{template.name}</strong><small>{template.toolName || "No default tool"}{template.hasDefaultContent ? " · default content" : ""}</small></span>
            <span>{savingId === template.id ? "Adding…" : "Add"}</span>
          </button>)}
          {loading && !templates.length && <p className="muted">Loading metrology templates…</p>}
          {!loading && !templates.length && <p className="muted">No matching metrology templates.</p>}
        </div>
        <button type="button" className="button wide" disabled={Boolean(savingId)} onClick={() => setCreating(true)}>Create new metrology template</button>
      </>}
      {error && <p className="error-banner">{error}</p>}
    </aside>
  </div>;
}

export function MultiSampleRunGrid({ columns, primaryRun, onSaved, readOnly = false }: { columns: RunGridColumn[]; primaryRun: SampleRun; onSaved: () => Promise<void>; readOnly?: boolean }) {
  const rows = useMemo(() => buildRunGrid(columns), [columns]);
  const currentRow = useMemo(() => findCurrentRunGridRow(rows), [rows]);
  const currentRowSignature = currentRow ? `${currentRow.row.key}:${currentRow.unfinishedColumnIndexes.join(",")}` : "";
  const sectionByStart = useMemo(
    () => new Map(visibleRunGridSections(rows).map((section, index) => [
      section.startIndex,
      { ...section, number: index + 1 },
    ])),
    [rows],
  );
  const mobileRunGrid = useMobileRunGrid();
  const [selected, setSelected] = useState(() => new Set(columns.filter((column) => column.run).map((column) => column.sample.id)));
  const [commonCommentRow, setCommonCommentRow] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [metrologyDrawer, setMetrologyDrawer] = useState<MetrologyDrawerState>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [recipeDetails, setRecipeDetails] = useState<RecipeDetailsState>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [scrollState, setScrollState] = useState({ overflow: false, left: false, right: false });
  const [showStickyNames, setShowStickyNames] = useState(false);
  const [jumpButtonGeometry, setJumpButtonGeometry] = useState<JumpButtonGeometry>({ baseEligible: false, overlapsGrid: false });
  const [jumpDirectionAllowed, setJumpDirectionAllowed] = useState(true);
  const [highlightedCellKey, setHighlightedCellKey] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fullHeader = useRef<HTMLDivElement>(null);
  const stickySampleTrack = useRef<HTMLDivElement>(null);
  const jumpButtonAnchor = useRef<HTMLDivElement>(null);
  const rowAnchors = useRef(new Map<string, HTMLElement>());
  const stepCellAnchors = useRef(new Map<string, HTMLElement>());
  const jumpBaseEligible = useRef(false);
  const jumpScrollDirection = useRef<{ direction: -1 | 0 | 1; distance: number }>({ direction: 0, distance: 0 });
  const lastWindowScrollY = useRef(typeof window === "undefined" ? 0 : window.scrollY);
  const programmaticJump = useRef(false);
  const jumpSequence = useRef(0);
  const highlightTimer = useRef<number | null>(null);
  const closeRecipeDetails = useCallback(() => setRecipeDetails(null), []);

  const setDirectionAllowed = useCallback((allowed: boolean) => {
    setJumpDirectionAllowed((current) => current === allowed ? current : allowed);
  }, []);

  const resetJumpScrollDirection = useCallback(() => {
    jumpScrollDirection.current = { direction: 0, distance: 0 };
  }, []);

  const jumpOverlapsGrid = useCallback(() => {
    const node = scroller.current;
    const buttonNode = jumpButtonAnchor.current;
    const gridNode = node?.querySelector<HTMLElement>(".run-grid");
    if (!node || !buttonNode || !gridNode) return false;

    const buttonRect = buttonNode.getBoundingClientRect();
    const scrollerRect = node.getBoundingClientRect();
    const gridRect = gridNode.getBoundingClientRect();
    const contentLeft = Math.max(0, scrollerRect.left, gridRect.left);
    const contentRight = Math.min(window.innerWidth, scrollerRect.right, gridRect.right);
    const contentTop = Math.max(0, scrollerRect.top, gridRect.top);
    const contentBottom = Math.min(window.innerHeight, scrollerRect.bottom, gridRect.bottom);
    const overlapWidth = Math.min(buttonRect.right, contentRight) - Math.max(buttonRect.left, contentLeft);
    const overlapHeight = Math.min(buttonRect.bottom, contentBottom) - Math.max(buttonRect.top, contentTop);
    return overlapWidth > 6 && overlapHeight > 6;
  }, []);

  const syncJumpButton = useCallback(() => {
    const node = scroller.current;
    const target = currentRow;
    const rowNode = target ? rowAnchors.current.get(target.row.key) : null;
    const topbar = document.querySelector<HTMLElement>(".topbar");
    const stickyNames = card.current?.querySelector<HTMLElement>(".run-grid-sticky-names");
    const modalOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'));
    const activeElement = document.activeElement;
    const mobileEditorActive = mobileRunGrid && activeElement instanceof HTMLElement
      && activeElement.matches('textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])');
    let baseEligible = false;

    if (node && target && rowNode && !modalOpen && !mobileEditorActive) {
      const scrollerRect = node.getBoundingClientRect();
      const rowRect = rowNode.getBoundingClientRect();
      const viewportTop = Math.max(0, topbar?.getBoundingClientRect().bottom || 0)
        + (showStickyNames ? stickyNames?.offsetHeight || 36 : 0);
      const gridIntersectsViewport = scrollerRect.bottom > viewportTop + 1 && scrollerRect.top < window.innerHeight - 1;
      const sampleViewportLeft = Math.max(0, scrollerRect.left, Math.min(rowRect.right, scrollerRect.right));
      const sampleViewportRight = Math.min(window.innerWidth, scrollerRect.right);
      const unfinishedCells = target.unfinishedColumnIndexes.flatMap((columnIndex) => {
        const cell = stepCellAnchors.current.get(`${target.row.key}:${columns[columnIndex]?.sample.id}`);
        return cell ? [cell] : [];
      });
      const horizontallyClear = sampleViewportRight > sampleViewportLeft
        && unfinishedCells.some((cell) => {
          const rect = cell.getBoundingClientRect();
          const center = rect.left + rect.width / 2;
          return center >= sampleViewportLeft && center <= sampleViewportRight;
        });
      const usableHeight = Math.max(0, window.innerHeight - viewportTop);
      const tallRow = rowRect.height >= usableHeight - 32;
      const maximumWindowScroll = Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight);
      const tallRowTarget = clamp(window.scrollY + rowRect.top - viewportTop - 16, 0, maximumWindowScroll);
      const verticallyClear = tallRow
        ? Math.abs(window.scrollY - tallRowTarget) <= 2
        : rowRect.top >= viewportTop - 1 && rowRect.bottom <= window.innerHeight + 1;
      baseEligible = gridIntersectsViewport && unfinishedCells.length > 0 && !(verticallyClear && horizontallyClear);
    }

    const overlapsGrid = baseEligible && jumpOverlapsGrid();
    const wasBaseEligible = jumpBaseEligible.current;
    jumpBaseEligible.current = baseEligible;
    if ((baseEligible && !wasBaseEligible) || !overlapsGrid || window.scrollY <= 8) {
      resetJumpScrollDirection();
      setDirectionAllowed(true);
    }
    setJumpButtonGeometry((current) => (
      current.baseEligible === baseEligible && current.overlapsGrid === overlapsGrid
        ? current
        : { baseEligible, overlapsGrid }
    ));
  }, [columns, currentRow, jumpOverlapsGrid, mobileRunGrid, resetJumpScrollDirection, setDirectionAllowed, showStickyNames]);

  useEffect(() => {
    jumpSequence.current += 1;
    programmaticJump.current = false;
    setDirectionAllowed(true);
    resetJumpScrollDirection();
    setHighlightedCellKey(null);
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = null;
  }, [currentRow?.row.key, resetJumpScrollDirection, setDirectionAllowed]);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    let animationFrame = 0;
    const scheduleSync = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        syncJumpButton();
      });
    };
    const onWindowScroll = () => {
      const nextScrollY = window.scrollY;
      const delta = nextScrollY - lastWindowScrollY.current;
      lastWindowScrollY.current = nextScrollY;
      scheduleSync();
      if (programmaticJump.current || !jumpBaseEligible.current || Math.abs(delta) < .5) return;

      const overlapsGrid = jumpOverlapsGrid();
      if (!overlapsGrid || nextScrollY <= 8) {
        resetJumpScrollDirection();
        setDirectionAllowed(true);
        return;
      }
      const button = jumpButtonAnchor.current?.querySelector("button");
      const preciseHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches
        && Boolean(jumpButtonAnchor.current?.matches(":hover"));
      const keyboardFocus = Boolean(button?.matches(":focus-visible"));
      const buttonEngaged = preciseHover || keyboardFocus;
      if (buttonEngaged) return;

      const direction: -1 | 1 = delta > 0 ? 1 : -1;
      const accumulated = jumpScrollDirection.current.direction === direction
        ? jumpScrollDirection.current.distance + Math.abs(delta)
        : Math.abs(delta);
      jumpScrollDirection.current = { direction, distance: accumulated };
      if (direction === 1 && accumulated >= JUMP_SCROLL_DOWN_THRESHOLD) setDirectionAllowed(false);
      if (direction === -1 && accumulated >= JUMP_SCROLL_UP_THRESHOLD) setDirectionAllowed(true);
    };
    const onFocusChange = () => window.requestAnimationFrame(scheduleSync);
    const resizeObserver = new ResizeObserver(scheduleSync);
    const mutationObserver = new MutationObserver(scheduleSync);
    const rowNode = currentRow ? rowAnchors.current.get(currentRow.row.key) : null;
    const gridNode = node.querySelector<HTMLElement>(".run-grid");
    [card.current, node, gridNode, rowNode, jumpButtonAnchor.current].forEach((element) => {
      if (element) resizeObserver.observe(element);
    });
    currentRow?.unfinishedColumnIndexes.forEach((columnIndex) => {
      const cell = stepCellAnchors.current.get(`${currentRow.row.key}:${columns[columnIndex]?.sample.id}`);
      if (cell) resizeObserver.observe(cell);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    lastWindowScrollY.current = window.scrollY;
    window.addEventListener("scroll", onWindowScroll, { passive: true });
    window.addEventListener("resize", scheduleSync);
    window.visualViewport?.addEventListener("resize", scheduleSync);
    node.addEventListener("scroll", scheduleSync, { passive: true });
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
    scheduleSync();
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("scroll", onWindowScroll);
      window.removeEventListener("resize", scheduleSync);
      window.visualViewport?.removeEventListener("resize", scheduleSync);
      node.removeEventListener("scroll", scheduleSync);
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
    };
  }, [columns, currentRow, currentRowSignature, jumpOverlapsGrid, resetJumpScrollDirection, setDirectionAllowed, syncJumpButton]);

  useEffect(() => () => {
    jumpSequence.current += 1;
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
  }, []);

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

  async function jumpToCurrent() {
    const node = scroller.current;
    const freshTarget = findCurrentRunGridRow(rows);
    const rowNode = freshTarget ? rowAnchors.current.get(freshTarget.row.key) : null;
    if (!node || !freshTarget || !rowNode) return;

    const unfinishedCells = freshTarget.unfinishedColumnIndexes.flatMap((columnIndex) => {
      const column = columns[columnIndex];
      const key = column ? `${freshTarget.row.key}:${column.sample.id}` : "";
      const cell = key ? stepCellAnchors.current.get(key) : null;
      return cell ? [{ cell, columnIndex, key }] : [];
    });
    if (!unfinishedCells.length) return;

    const scrollerRect = node.getBoundingClientRect();
    const rowRect = rowNode.getBoundingClientRect();
    const sampleViewportLeft = Math.max(0, scrollerRect.left, Math.min(rowRect.right, scrollerRect.right));
    const sampleViewportRight = Math.min(window.innerWidth, scrollerRect.right);
    if (sampleViewportRight <= sampleViewportLeft) return;
    const sampleViewportCenter = (sampleViewportLeft + sampleViewportRight) / 2;
    const visibleCells = unfinishedCells.filter(({ cell }) => {
      const rect = cell.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      return center >= sampleViewportLeft && center <= sampleViewportRight;
    });
    const candidates = visibleCells.length ? visibleCells : unfinishedCells;
    let chosenCell = candidates[0];
    let chosenDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const rect = candidate.cell.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const distance = visibleCells.length
        ? Math.abs(center - sampleViewportCenter)
        : center < sampleViewportLeft
          ? sampleViewportLeft - center
          : center > sampleViewportRight
            ? center - sampleViewportRight
            : 0;
      if (distance < chosenDistance) {
        chosenCell = candidate;
        chosenDistance = distance;
      }
    }

    const topbarBottom = Math.max(0, document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect().bottom || 0);
    const stickyNames = card.current?.querySelector<HTMLElement>(".run-grid-sticky-names");
    const stickyNamesHeight = stickyNames?.offsetHeight || 36;
    const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const maximumWindowScroll = Math.max(0, documentHeight - window.innerHeight);
    const absoluteRowTop = window.scrollY + rowRect.top;
    const fullHeaderRect = fullHeader.current?.getBoundingClientRect();
    const cardRect = card.current?.getBoundingClientRect();
    const absoluteHeaderBottom = fullHeaderRect ? window.scrollY + fullHeaderRect.bottom : 0;
    const absoluteCardBottom = cardRect ? window.scrollY + cardRect.bottom : 0;

    function verticalTarget(stickyNamesVisible: boolean) {
      const usableTop = topbarBottom + (stickyNamesVisible ? stickyNamesHeight : 0);
      const usableHeight = Math.max(0, window.innerHeight - usableTop);
      const tallRow = rowRect.height >= usableHeight - 32;
      const desired = tallRow
        ? absoluteRowTop - usableTop - 16
        : absoluteRowTop + rowRect.height / 2 - (usableTop + window.innerHeight) / 2;
      return clamp(desired, 0, maximumWindowScroll);
    }

    function stickyNamesWillShowAt(windowScrollY: number) {
      if (!fullHeaderRect || !cardRect) return false;
      return absoluteHeaderBottom - windowScrollY <= topbarBottom + stickyNamesHeight
        && absoluteCardBottom - windowScrollY > topbarBottom + stickyNamesHeight;
    }

    let windowTarget = verticalTarget(false);
    let predictedStickyNames = stickyNamesWillShowAt(windowTarget);
    windowTarget = verticalTarget(predictedStickyNames);
    const revisedStickyNames = stickyNamesWillShowAt(windowTarget);
    if (revisedStickyNames !== predictedStickyNames) {
      predictedStickyNames = revisedStickyNames;
      windowTarget = verticalTarget(predictedStickyNames);
    }

    const chosenRect = chosenCell.cell.getBoundingClientRect();
    const chosenCenter = chosenRect.left + chosenRect.width / 2;
    const shouldScrollHorizontally = visibleCells.length === 0;
    const horizontalTarget = shouldScrollHorizontally
      ? clamp(node.scrollLeft + chosenCenter - sampleViewportCenter, 0, Math.max(0, node.scrollWidth - node.clientWidth))
      : node.scrollLeft;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
    const sequence = jumpSequence.current + 1;
    jumpSequence.current = sequence;
    programmaticJump.current = true;
    setHighlightedCellKey(null);
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = null;

    window.scrollTo({ top: windowTarget, behavior });
    if (shouldScrollHorizontally) node.scrollTo({ left: horizontalTarget, behavior });

    if (reducedMotion) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
    } else {
      await waitForScrollToSettle(node);
    }
    if (jumpSequence.current !== sequence) return;

    programmaticJump.current = false;
    lastWindowScrollY.current = window.scrollY;
    resetJumpScrollDirection();
    setHighlightedCellKey(chosenCell.key);
    highlightTimer.current = window.setTimeout(() => {
      setHighlightedCellKey((current) => current === chosenCell.key ? null : current);
      highlightTimer.current = null;
    }, JUMP_HIGHLIGHT_DURATION);
    window.requestAnimationFrame(syncJumpButton);
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

  async function confirmDelete() {
    if (!deleteRequest) return;
    const actionKey = deleteRequest.kind === "execution_asset"
      ? `delete-asset:${deleteRequest.step.id}:${deleteRequest.assetKey}`
      : `delete:${deleteRequest.comment.id}:${deleteRequest.kind}`;
    setPendingAction(actionKey); setDeleteError(""); setError("");
    try {
      if (deleteRequest.kind === "comment") {
        if (deleteRequest.comment.submissionId) await api.deleteCommentSubmission(deleteRequest.comment.submissionId);
        else await api.deleteRunStepComment(deleteRequest.comment.id);
      }
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
      commentContext={{ kind: "run_steps", scope: "individual", targets: [target(column, step)] }}
      onCommentSubmitted={onSaved}
      onDeleteComment={(comment) => { setDeleteError(""); setDeleteRequest({ kind: "comment", comment, common: false }); }}
      onDeleteCommentAsset={(comment) => { setDeleteError(""); setDeleteRequest({ kind: "comment_asset", comment, common: false }); }}
      onDeleteExecutionAsset={(assetKey) => { setDeleteError(""); setDeleteRequest({ kind: "execution_asset", assetKey, column, step }); }}
      onEdit={() => setDrawer({ mode: "edit", column, step })}
      onAddFabrication={() => setDrawer({ mode: "add", column, afterStepId: step.id })}
      onAddMetrology={() => setMetrologyDrawer({ column, afterStepId: step.id })}
      allowAdd={primaryRun.runKind === "process"}
      readOnly={runStepIsReadOnly(readOnly, primaryRun.status === "complete", step)}
    />;
  }

  const layoutClass = `sample-count-${Math.min(columns.length, 4)}`;
  const jumpButtonVisible = Boolean(currentRow && jumpButtonGeometry.baseEligible
    && (!jumpButtonGeometry.overlapsGrid || jumpDirectionAllowed));
  const jumpButton = typeof document === "undefined" || !currentRow ? null : createPortal(
    <div
      ref={jumpButtonAnchor}
      className={`jump-to-current-anchor${jumpButtonVisible ? " is-visible" : ""}`}
      aria-hidden={!jumpButtonVisible}
    >
      <button
        type="button"
        title="Jump to current"
        aria-label="Jump to current"
        tabIndex={jumpButtonVisible ? 0 : -1}
        onClick={(event) => {
          if (event.detail > 0) event.currentTarget.blur();
          void jumpToCurrent();
        }}
      >
        <JumpToCurrentIcon />
      </button>
    </div>,
    document.body,
  );
  return <>
  <article className={`run-grid-card ${layoutClass}`} ref={card}>
    <div className="run-grid-toolbar">
      <div><p className="card-label">{primaryRun.runKind === "metrology" ? "Metrology" : `${primaryRun.templateType} · plan r${primaryRun.planRevisionNumber}`} · run {primaryRun.sequenceNo}</p><h3 className="card-title">{primaryRun.templateName}{primaryRun.runKind === "process" ? ` v${primaryRun.templateVersion}` : ""}</h3><small>{primaryRun.runKind === "metrology" ? "A standalone result record; it does not change the sample structure." : primaryRun.status === "active" ? "Plan on the left; actual execution stays in each sample column." : `${primaryRun.status} run · preserved in the sample chain`}</small></div>
      <div className="grid-scroll-buttons" aria-label="Sample columns">{scrollState.overflow && <button type="button" disabled={!scrollState.left} onClick={() => scrollColumns(-1)} aria-label="Scroll sample columns left">←</button>}<span>{columns.length} sample{columns.length === 1 ? "" : "s"}</span>{scrollState.overflow && <button type="button" disabled={!scrollState.right} onClick={() => scrollColumns(1)} aria-label="Scroll sample columns right">→</button>}</div>
    </div>
    {error && <p className="error-banner grid-error">{error}</p>}
    <div className={`run-grid-sticky-names${showStickyNames ? " visible" : ""}`} aria-hidden="true">
      <div className="sticky-recipe-name">{primaryRun.runKind === "metrology" ? "Metrology" : "Process plan"}</div>
      <div className="sticky-sample-viewport">
        <div className="sticky-sample-track" ref={stickySampleTrack}>
          {columns.map((column) => <div className="sticky-sample-name" key={`sticky:${column.sample.id}`} title={`${column.sample.title} · ${column.sample.code}`}>{column.sample.title}</div>)}
        </div>
      </div>
    </div>
    <div className="run-grid-scroll" ref={scroller}>
      <div className="run-grid" style={{ "--sample-columns": columns.length } as React.CSSProperties}>
        <div className="run-grid-header recipe-column" ref={fullHeader}>
          <strong>{primaryRun.runKind === "metrology" ? "Record type" : "Process plan"}</strong>
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
          const section = sectionByStart.get(rowIndex);
          const entries = row.steps.flatMap((step, columnIndex) => step ? [{ step, column: columns[columnIndex] }] : []);
          const commonGroups = new Map<string, CommonCommentGroup>();
          entries.forEach(({ step, column }) => step.comments.filter((comment) => comment.scope === "common").forEach((comment) => {
            const key = comment.operationGroupId || comment.id;
            const existing = commonGroups.get(key);
            if (existing) existing.codes.push(column.sample.code); else commonGroups.set(key, { comment, codes: [column.sample.code] });
          }));
          const commonRecovery = recoverableFromComments([...commonGroups.values()].map(({ comment }) => comment));
          const readyCommonGroups = [...commonGroups.values()].filter(({ comment }) => (comment.status ?? "ready") === "ready");
          const commonTargets = entries.filter(({ column }) => selected.has(column.sample.id)).map(({ column, step }) => target(column, step));
          const hasCommonContent = readyCommonGroups.length > 0 || commonRecovery.length > 0;
          const commonCommentsOpen = commonCommentRow === row.key;
          const eligibleCount = entries.filter(({ column, step }) => selected.has(column.sample.id) && ["pending", "in_progress"].includes(step.status)).length;
          const recipeNumber = rows.slice(0, rowIndex + 1).filter((candidate) => candidate.kind === "template").length;
          const rowLeadStep = row.steps.find((step): step is RunStep => Boolean(step));
          const stepName = row.recipeStep?.plannedTitle || row.recipeStep?.title || rowLeadStep?.title || "Process step";
          const supportsCommonActions = row.kind === "template" || row.kind === "metrology";
          const commonCommentContext = row.kind === "metrology" ? "metrology" : "process-plan";
          return <Fragment key={row.key}>
            {section && <>
              <div className="run-grid-section-mobile-index recipe-column">Section {section.number}</div>
              <div className="run-grid-section-mobile-name" title={section.label}>{section.label}</div>
              <div className="run-grid-section-name recipe-column" title={section.label}>{section.label}</div>
              {columns.map((column, columnIndex) => {
                const progress = runGridSectionProgress(rows, section, columnIndex);
                const complete = progress.total > 0 && progress.completed === progress.total && !progress.blocked;
                const label = progress.total
                  ? `${section.label}: ${progress.completed} of ${progress.total} steps complete${progress.blocked ? "; blocked" : ""}`
                  : `${section.label}: no matching steps`;
                return <div
                  className={`run-grid-section-progress${progress.blocked ? " blocked" : ""}${complete ? " complete" : ""}${progress.total ? "" : " empty"}`}
                  key={`section:${section.key}:${column.sample.id}`}
                  role="progressbar"
                  aria-label={label}
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.completed}
                  title={label}
                  style={{ "--section-progress": `${progress.percent}%` } as React.CSSProperties}
                >
                  <span className="run-grid-section-progress-track">
                    {progress.total > 0 && <span className="run-grid-section-progress-label">{progress.percent}%</span>}
                  </span>
                </div>;
              })}
            </>}
            <div className="run-grid-row" style={{ display: "contents" }}>
            <div
              ref={(node) => {
                if (node) rowAnchors.current.set(row.key, node);
                else rowAnchors.current.delete(row.key);
              }}
              className={`recipe-cell recipe-column${row.kind === "ad_hoc" ? " additional-step-recipe-cell" : ""}${row.kind === "metrology" ? " metrology-recipe-cell" : ""}`}
            >
              {row.kind !== "template" ? <div className={`recipe-step-heading additional-step-heading${row.kind === "metrology" ? " metrology-step-heading" : ""}`}><span>{row.kind === "metrology" ? "M" : "+"}</span><div><strong>{row.kind === "metrology" ? "Metrology" : "Additional step"}</strong><small>{row.kind === "metrology" ? rowLeadStep?.title : "Not part of the process template"}</small></div></div> : <>
              <div className="recipe-step-heading recipe-step-heading-desktop"><span>{recipeNumber}</span><div><strong>{row.recipeStep?.plannedTitle || row.recipeStep?.title}</strong>{row.recipeStep?.plannedToolName && <small>{row.recipeStep.plannedToolName}</small>}</div></div>
              {row.recipeStep && <button type="button" className="recipe-step-heading recipe-details-trigger" onClick={() => setRecipeDetails({ step: row.recipeStep!, number: recipeNumber })} aria-label={`View process-step details for ${row.recipeStep.plannedTitle || row.recipeStep.title}`}><span className="recipe-step-number">{recipeNumber}</span><strong>{row.recipeStep.plannedTitle || row.recipeStep.title}</strong><svg className="recipe-details-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6" /></svg></button>}
              <div className="recipe-content-split recipe-desktop-details"><div>{row.recipeStep?.plannedParametersText && <div className="recipe-field"><small>Parameters</small><p>{row.recipeStep.plannedParametersText}</p></div>}{row.recipeStep?.plannedCommentsText && <div className="recipe-field"><small>Plan note</small><p>{row.recipeStep.plannedCommentsText}</p></div>}</div>{row.recipeStep && <DiagramGallery keys={row.recipeStep.plannedImageKeys} label={`Plan diagram for ${row.recipeStep.title}`} size="wide" />}</div>
              </>}
              {supportsCommonActions && <>
              {!readOnly && <div className="recipe-actions">
                <button type="button" className="button primary compact-button recipe-icon-action" title={pendingAction === `confirm:${row.key}` ? "Saving…" : `Confirm ${eligibleCount} selected sample step${eligibleCount === 1 ? "" : "s"} as done`} aria-label={pendingAction === `confirm:${row.key}` ? "Saving confirmed steps" : `Confirm ${eligibleCount} selected sample step${eligibleCount === 1 ? "" : "s"} as done`} aria-busy={pendingAction === `confirm:${row.key}`} disabled={!eligibleCount || pendingAction !== null} onClick={() => void confirmSteps(row.key, entries)}><ProcessingActionIcon name="done" /><span className="recipe-action-label">{pendingAction === `confirm:${row.key}` ? "Saving…" : `Done · ${eligibleCount}`}</span></button>
                <ProcessPlanCommentButton
                  commentCount={readyCommonGroups.length}
                  hasContent={hasCommonContent}
                  expanded={commonCommentsOpen}
                  disabled={!commonTargets.length && !(mobileRunGrid && hasCommonContent)}
                  context={commonCommentContext}
                  onClick={() => setCommonCommentRow(commonCommentsOpen ? null : row.key)}
                />
              </div>}
              {readOnly && hasCommonContent && <div className="mobile-recipe-comment-action">
                <ProcessPlanCommentButton
                  commentCount={readyCommonGroups.length}
                  hasContent
                  expanded={commonCommentsOpen}
                  disabled={false}
                  context={commonCommentContext}
                  onClick={() => setCommonCommentRow(commonCommentsOpen ? null : row.key)}
                />
              </div>}
              {!mobileRunGrid && <div className="process-plan-comment-inline">
                {!readOnly && commonCommentsOpen && <CommentComposer
                  label="Add to checked samples"
                  context={{ kind: "run_steps", scope: "common", targets: commonTargets }}
                  adaptiveToolbarLayout
                  onCancel={() => setCommonCommentRow(null)}
                  onSubmitted={async () => {
                    setCommonCommentRow(null);
                    await onSaved();
                  }}
                />}
                <CommentSubmissionRecovery submissions={commonRecovery} onSubmitted={onSaved} />
                {readyCommonGroups.length > 0 && <div className="common-comments">
                  <small>Common execution comments</small>
                  {readyCommonGroups.map(({ comment, codes }) => <CommentCard
                  key={comment.operationGroupId || comment.id}
                  comment={comment}
                  common
                  meta={`${codes.join(", ")} · ${comment.actorEmail || "Unknown user"} · ${new Date(comment.createdAt).toLocaleString()}`}
                  imageLabel="Common comment photo"
                  onDelete={() => { setDeleteError(""); setDeleteRequest({ kind: "comment", comment, common: true }); }}
                  onDeleteAsset={comment.assetKey ? () => { setDeleteError(""); setDeleteRequest({ kind: "comment_asset", comment, common: true }); } : undefined}
                  />)}
                </div>}
              </div>}
              {mobileRunGrid && commonCommentsOpen && <ProcessPlanCommentDialog
                stepName={stepName}
                commentContext={commonCommentContext}
                targets={commonTargets}
                comments={readyCommonGroups}
                recovery={commonRecovery}
                readOnly={readOnly}
                onClose={() => setCommonCommentRow(null)}
                onSubmitted={onSaved}
                onDelete={(comment) => { setDeleteError(""); setDeleteRequest({ kind: "comment", comment, common: true }); }}
                onDeleteAsset={(comment) => { setDeleteError(""); setDeleteRequest({ kind: "comment_asset", comment, common: true }); }}
              />}
              </>}
            </div>
            {columns.map((column, columnIndex) => {
              const step = row.steps[columnIndex];
              const cellKey = `${row.key}:${column.sample.id}`;
              return <div
                ref={(node) => {
                  if (node) stepCellAnchors.current.set(cellKey, node);
                  else stepCellAnchors.current.delete(cellKey);
                }}
                className={`sample-step-cell${step ? ` step-status-${step.status}` : " empty-cell"}${row.kind === "ad_hoc" ? " additional-step-cell" : ""}${row.kind === "metrology" ? " metrology-step-cell" : ""}${highlightedCellKey === cellKey ? " jump-current-highlight" : ""}`}
                key={cellKey}
              >
                {step ? renderStepContent(column, step) : <span className="not-applicable">—</span>}
              </div>;
            })}
            </div>
          </Fragment>;
        })}
      </div>
    </div>
    {drawer && <StepDrawer key={`${drawer.mode}:${drawer.mode === "edit" ? drawer.step.id : `${drawer.column.sample.id}:${drawer.afterStepId || "first"}`}`} state={drawer} onClose={() => setDrawer(null)} onSaved={onSaved} />}
    {metrologyDrawer && <MetrologyPickerDrawer key={`${metrologyDrawer.column.sample.id}:${metrologyDrawer.afterStepId || "first"}`} state={metrologyDrawer} onClose={() => setMetrologyDrawer(null)} onSaved={onSaved} />}
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
  </article>
  {jumpButton}
  </>;
}

function StepCell({ column, step, pendingAction, onDone, onVerify, commentContext, onCommentSubmitted, onDeleteComment, onDeleteCommentAsset, onDeleteExecutionAsset, onEdit, onAddFabrication, onAddMetrology, allowAdd, readOnly }: {
  column: RunGridColumn; step: RunStep; pendingAction: string | null;
  onDone: () => void; onVerify: (result: "matched" | "mismatched") => void;
  commentContext: Extract<CreateCommentSubmissionInput["context"], { kind: "run_steps" }>;
  onCommentSubmitted: () => Promise<void>;
  onDeleteComment: (comment: RunStepComment) => void; onDeleteCommentAsset: (comment: RunStepComment) => void; onDeleteExecutionAsset: (assetKey: string) => void; onEdit: () => void;
  onAddFabrication: () => void; onAddMetrology: () => void; allowAdd: boolean; readOnly: boolean;
}) {
  const individualComments = step.comments.filter((comment) => comment.scope === "individual");
  const recoverableComments = recoverableFromComments(individualComments);
  const readyComments = individualComments.filter((comment) => (comment.status ?? "ready") === "ready");
  const [showStateActions, setShowStateActions] = useState(false);
  const [showAddActions, setShowAddActions] = useState(false);
  const actionsLocked = pendingAction !== null;
  const pendingForStep = pendingRunStepActionTargets(pendingAction, step.id);
  const lockedByAnotherStep = actionsLocked && !pendingForStep;
  const metrology = step.entryKind === "metrology";
  return <>
    <div className="cell-status-row">
      <div className={`cell-state cell-state-${step.status}`}><span className={step.status === "done" ? "done-mark" : "state-symbol"}><StepStatusIcon status={step.status} /></span><strong>{step.status.replace("_", " ")}</strong></div>
      <div className="cell-badges">{metrology ? <span className="change-badge metrology-badge">Metrology</span> : step.origin === "ad_hoc" && <span className="change-badge">Ad hoc</span>}{step.stateVerification && <span className={`verification-badge ${step.stateVerification.result}`}>{step.stateVerification.result === "matched" ? "Verified" : "Mismatch"} · {step.stateVerification.coveredRunStepIds.length}</span>}</div>
    </div>
    {!readOnly && <div className={`cell-actions${metrology ? " metrology-cell-actions" : ""}`}>
      <button type="button" className="done-action" aria-busy={pendingAction === `done:${step.id}`} data-background-locked={lockedByAnotherStep && step.status !== "done" || undefined} disabled={actionsLocked || step.status === "done"} onClick={onDone}>{pendingAction === `done:${step.id}` ? "Saving…" : "Done"}</button>
      <button type="button" data-background-locked={lockedByAnotherStep || undefined} disabled={actionsLocked} onClick={onEdit}>Correct</button>
      {allowAdd && <button type="button" className="add-entry-action" title="Add after this entry" aria-label="Add after this entry" aria-expanded={showAddActions} data-background-locked={lockedByAnotherStep && column.run?.status === "active" || undefined} disabled={actionsLocked || column.run?.status !== "active"} onClick={() => { setShowStateActions(false); setShowAddActions((shown) => !shown); }}>Add ▾</button>}
      {!metrology && <button type="button" aria-busy={pendingAction === `verify:${step.id}`} data-background-locked={lockedByAnotherStep || undefined} disabled={actionsLocked} aria-expanded={showStateActions} onClick={() => { setShowAddActions(false); setShowStateActions((shown) => !shown); }}>{pendingAction === `verify:${step.id}` ? "Saving…" : "State ▾"}</button>}
    </div>}
    {!readOnly && showAddActions && <div className="state-action-panel add-action-panel"><button type="button" disabled={actionsLocked} onClick={() => { setShowAddActions(false); onAddFabrication(); }}>Fabrication</button><button type="button" disabled={actionsLocked} onClick={() => { setShowAddActions(false); onAddMetrology(); }}>Metrology</button></div>}
    {!readOnly && showStateActions && <div className="state-action-panel"><button type="button" disabled={actionsLocked} onClick={() => { setShowStateActions(false); onVerify("matched"); }}>State verified</button><button type="button" disabled={actionsLocked} onClick={() => { setShowStateActions(false); onVerify("mismatched"); }}>State mismatch</button></div>}
    {(step.origin === "ad_hoc" || metrology) && <strong className="ad-hoc-title">{step.title}</strong>}
    <div className="cell-content-split"><div><ActualDifferences step={step} /></div><DiagramGallery keys={step.executionImageKeys} label={`Execution image for ${step.title}`} onDelete={onDeleteExecutionAsset} /></div>
    {!readOnly && <CommentComposer label="Individual comment" context={commentContext} adaptiveToolbarLayout onSubmitted={onCommentSubmitted} />}
    <CommentSubmissionRecovery submissions={recoverableComments} onSubmitted={onCommentSubmitted} />
    <CommentList comments={readyComments} onDelete={onDeleteComment} onDeleteAsset={onDeleteCommentAsset} />
  </>;
}
