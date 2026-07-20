import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { RunStep, RunStepComment, SampleRun, StepStatus } from "../../shared/types";
import { api } from "../lib/api";
import { compressCommentImage, compressLayerStackImage } from "../lib/images";
import { buildRunGrid, type RunGridColumn } from "../lib/runGrid";
import { runStepIsModified } from "../lib/runSteps";
import { FileDropzone } from "./FileDropzone";

const STATUSES: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];

type DrawerState =
  | { mode: "edit"; column: RunGridColumn; step: RunStep }
  | { mode: "add"; column: RunGridColumn; afterStepId?: string }
  | null;

function target(column: RunGridColumn, step: RunStep) {
  if (!column.run) throw new Error("This sample has no matching run");
  return {
    sampleId: column.sample.id,
    runId: column.run.id,
    stepId: step.id,
    expectedUpdatedAt: step.updatedAt,
  };
}

function DiagramGallery({ keys, label }: { keys: string[]; label: string }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  useEffect(() => {
    if (activeIndex === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setActiveIndex(null);
      if (event.key === "ArrowLeft") setActiveIndex((current) => current === null ? null : (current - 1 + keys.length) % keys.length);
      if (event.key === "ArrowRight") setActiveIndex((current) => current === null ? null : (current + 1) % keys.length);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, keys.length]);
  if (!keys.length) return null;
  return <>
    <div className="grid-diagrams" role="list">{keys.map((key, index) => <button type="button" key={key} role="listitem" onClick={() => setActiveIndex(index)} aria-label={`Open ${label} ${index + 1} of ${keys.length}`}><img src={`/api/assets/${key}`} alt={label} loading="lazy" /></button>)}</div>
    {activeIndex !== null && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveIndex(null); }}>
      <div className="image-lightbox-toolbar"><span>{activeIndex + 1} / {keys.length}</span><a href={`/api/assets/${keys[activeIndex]}`} target="_blank" rel="noreferrer">Open original</a><button type="button" onClick={() => setActiveIndex(null)} aria-label="Close image viewer">×</button></div>
      <img src={`/api/assets/${keys[activeIndex]}`} alt={`${label} ${activeIndex + 1}`} />
      {keys.length > 1 && <><button type="button" className="lightbox-arrow previous" onClick={() => setActiveIndex((activeIndex - 1 + keys.length) % keys.length)} aria-label="Previous image">←</button><button type="button" className="lightbox-arrow next" onClick={() => setActiveIndex((activeIndex + 1) % keys.length)} aria-label="Next image">→</button></>}
    </div>}
  </>;
}

function CommentList({ comments }: { comments: RunStepComment[] }) {
  if (!comments.length) return null;
  const imageKeys = comments.flatMap((comment) => comment.assetKey ? [comment.assetKey] : []);
  return <div className="comment-history"><div className="cell-comments">{comments.map((comment) => <div key={comment.id} className="cell-comment">{comment.body && <p>{comment.body}</p>}<small>{comment.assetKey ? "Photo · " : ""}{comment.actorEmail || "Unknown user"} · {new Date(comment.createdAt).toLocaleString()}</small></div>)}</div>{imageKeys.length > 0 && <div className="comment-thumbnail-gallery"><DiagramGallery keys={imageKeys} label="Comment photo" /></div>}</div>;
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

  const layoutClass = `sample-count-${Math.min(columns.length, 4)}`;
  return <article className={`run-grid-card ${layoutClass}`}>
    <div className="run-grid-toolbar">
      <div><p className="eyebrow">{primaryRun.templateType} · assigned v{primaryRun.templateVersion}</p><h2>{primaryRun.templateName}</h2><small>Recipe on the left; actual execution stays in each sample column.</small></div>
      <div className="grid-scroll-buttons" aria-label="Sample columns">{scrollState.overflow && <button type="button" disabled={!scrollState.left} onClick={() => scroller.current?.scrollBy({ left: -340, behavior: "smooth" })} aria-label="Scroll sample columns left">←</button>}<span>{columns.length} sample{columns.length === 1 ? "" : "s"}</span>{scrollState.overflow && <button type="button" disabled={!scrollState.right} onClick={() => scroller.current?.scrollBy({ left: 340, behavior: "smooth" })} aria-label="Scroll sample columns right">→</button>}</div>
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
          if (row.kind === "ad_hoc") return <div className="run-grid-row ad-hoc-grid-row" key={row.key} style={{ display: "contents" }}>
            <div className="recipe-cell recipe-column ad-hoc-recipe-gap" aria-hidden="true" />
            {columns.map((column, columnIndex) => {
              const step = row.steps[columnIndex];
              return <div className={`sample-step-cell${step ? ` ad-hoc-cell step-status-${step.status}` : " empty-cell"}`} key={`${row.key}:${column.sample.id}`}>
                {step ? <StepCell column={column} step={step} pendingAction={pendingAction} onDone={() => void markDone(column, step)} onSaveComment={(body, image) => addComment("individual", [{ column, step }], body, image, `comment:${step.id}`)} onEdit={() => setDrawer({ mode: "edit", column, step })} onAddAfter={() => setDrawer({ mode: "add", column, afterStepId: step.id })} /> : <span className="not-applicable">—</span>}
              </div>;
            })}
          </div>;

          const commonGroups = new Map<string, { comment: RunStepComment; codes: string[] }>();
          entries.forEach(({ step, column }) => step.comments.filter((comment) => comment.scope === "common").forEach((comment) => {
            const key = comment.operationGroupId || comment.id;
            const existing = commonGroups.get(key);
            if (existing) existing.codes.push(column.sample.code); else commonGroups.set(key, { comment, codes: [column.sample.code] });
          }));
          const eligibleCount = entries.filter(({ column, step }) => selected.has(column.sample.id) && ["pending", "in_progress"].includes(step.status)).length;
          const recipeNumber = rows.slice(0, rowIndex + 1).filter((candidate) => candidate.kind === "template").length;
          return <div className="run-grid-row" key={row.key} style={{ display: "contents" }}>
            <div className="recipe-cell recipe-column">
              <div className="recipe-step-heading"><span>{recipeNumber}</span><div><strong>{row.recipeStep?.plannedTitle || row.recipeStep?.title}</strong>{row.recipeStep?.plannedToolName && <small>{row.recipeStep.plannedToolName}</small>}</div></div>
              <div className="recipe-content-split"><div>{row.recipeStep?.plannedParametersText && <div className="recipe-field"><small>Parameters</small><p>{row.recipeStep.plannedParametersText}</p></div>}{row.recipeStep?.plannedCommentsText && <div className="recipe-field"><small>Recipe note</small><p>{row.recipeStep.plannedCommentsText}</p></div>}</div>{row.recipeStep && <DiagramGallery keys={row.recipeStep.plannedImageKeys} label={`Recipe diagram for ${row.recipeStep.title}`} />}</div>
              {commonGroups.size > 0 && <div className="common-comments"><small>Common execution comments</small>{[...commonGroups.values()].map(({ comment, codes }) => <div key={comment.operationGroupId || comment.id}>{comment.body && <p>{comment.body}</p>}{comment.assetKey && <div className="comment-thumbnail-gallery"><DiagramGallery keys={[comment.assetKey]} label="Common comment photo" /></div>}<span>{codes.join(", ")} · {new Date(comment.createdAt).toLocaleString()}</span></div>)}</div>}
              <div className="recipe-actions"><button type="button" className="button primary compact-button" disabled={!eligibleCount || pendingAction !== null} onClick={() => void confirmSteps(row.key, entries)}>{pendingAction === `confirm:${row.key}` ? "Confirming…" : `Confirm ${eligibleCount || ""} done`.replace("  ", " ")}</button><button type="button" className="button compact-button" disabled={!entries.some(({ column }) => selected.has(column.sample.id))} onClick={() => setCommonCommentRow(commonCommentRow === row.key ? null : row.key)}>Common comment</button></div>
              {commonCommentRow === row.key && <CommentComposer label="Add to checked samples" saving={pendingAction === `common:${row.key}`} onCancel={() => setCommonCommentRow(null)} onSave={(body, image) => addComment("common", entries, body, image, `common:${row.key}`)} />}
            </div>
            {columns.map((column, columnIndex) => {
              const step = row.steps[columnIndex];
              return <div className={`sample-step-cell${step ? ` step-status-${step.status}` : " empty-cell"}`} key={`${row.key}:${column.sample.id}`}>
                {step ? <StepCell column={column} step={step} pendingAction={pendingAction} onDone={() => void markDone(column, step)} onSaveComment={(body, image) => addComment("individual", [{ column, step }], body, image, `comment:${step.id}`)} onEdit={() => setDrawer({ mode: "edit", column, step })} onAddAfter={() => setDrawer({ mode: "add", column, afterStepId: step.id })} /> : <span className="not-applicable">—</span>}
              </div>;
            })}
          </div>;
        })}
      </div>
    </div>
    {drawer && <StepDrawer key={`${drawer.mode}:${drawer.mode === "edit" ? drawer.step.id : `${drawer.column.sample.id}:${drawer.afterStepId || "first"}`}`} state={drawer} onClose={() => setDrawer(null)} onSaved={onSaved} />}
  </article>;
}

function CommentComposer({ label, saving, onSave, onCancel }: { label: string; saving: boolean; onSave: (body: string, image: File | null) => Promise<boolean>; onCancel?: () => void }) {
  const [body, setBody] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imageError, setImageError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  return <form className={`grid-comment-composer${dragging ? " dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseImage(event.dataTransfer.files[0]); }} onSubmit={(event) => { event.preventDefault(); void onSave(body, image).then((saved) => { if (saved) { setBody(""); setImage(null); } }); }}>
    {dragging && <div className="comment-drop-overlay">Drop photo here</div>}
    <textarea rows={2} aria-label={label} value={body} onChange={(event) => setBody(event.target.value)} onPaste={(event) => { const pastedImage = [...event.clipboardData.files].find((file) => file.type.startsWith("image/")); if (pastedImage) chooseImage(pastedImage); }} placeholder={`${label} — type, paste, or drop a photo…`} />
    <div className="comment-composer-footer">
      <input ref={inputRef} className="comment-file-input" type="file" accept="image/*" capture="environment" onChange={(event) => { chooseImage(event.target.files?.[0]); event.target.value = ""; }} />
      {image && previewUrl ? <div className="pending-comment-image"><img src={previewUrl} alt="Pending comment attachment" /><span>{image.name}</span><button type="button" onClick={() => setImage(null)} aria-label="Remove attached photo">×</button></div> : <button type="button" className="comment-attach-button" onClick={() => inputRef.current?.click()} title="Attach a photo, or drop it anywhere in the comment box"><span>＋</span> Photo</button>}
      <div className="comment-submit-actions">{onCancel && <button type="button" className="text-button" onClick={onCancel}>Cancel</button>}<button className="button primary compact-button" disabled={saving || (!body.trim() && !image)}>{saving ? "Saving…" : "Add"}</button></div>
    </div>
    {imageError && <small className="comment-image-error">{imageError}</small>}
  </form>;
}

function StepCell({ column, step, pendingAction, onDone, onSaveComment, onEdit, onAddAfter }: {
  column: RunGridColumn; step: RunStep; pendingAction: string | null;
  onDone: () => void; onSaveComment: (body: string, image: File | null) => Promise<boolean>; onEdit: () => void; onAddAfter: () => void;
}) {
  const individualComments = step.comments.filter((comment) => comment.scope === "individual");
  const busy = pendingAction !== null;
  return <>
    <div className="cell-command-bar">
      <div className="cell-actions">
        {step.status !== "done" && <button type="button" className="done-action" disabled={busy} onClick={onDone}>{pendingAction === `done:${step.id}` ? "Saving…" : "Done"}</button>}
        <button type="button" disabled={busy} onClick={onEdit}>Correct</button>
        <button type="button" disabled={busy || !column.run} onClick={onAddAfter}>+ Step</button>
      </div>
      {step.origin === "ad_hoc" && <span className="change-badge">Ad hoc</span>}
      <div className={`cell-state cell-state-${step.status}`}><span className={step.status === "done" ? "done-mark" : "state-symbol"}>{step.status === "done" ? "✓" : step.status === "in_progress" ? "↻" : step.status === "skipped" ? "—" : step.status === "blocked" ? "!" : "○"}</span><strong>{step.status.replace("_", " ")}</strong></div>
    </div>
    {step.origin === "ad_hoc" && <strong className="ad-hoc-title">{step.title}</strong>}
    <div className="cell-content-split"><div><ActualDifferences step={step} /></div><DiagramGallery keys={step.executionImageKeys} label={`Execution image for ${step.title}`} /></div>
    <CommentList comments={individualComments} />
    <CommentComposer label="Individual comment" saving={pendingAction === `comment:${step.id}`} onSave={onSaveComment} />
  </>;
}
