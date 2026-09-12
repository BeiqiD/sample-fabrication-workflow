import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { isProjectAttachmentSourceUrl } from "../../../shared/project-api";
import { EmptyState } from "../EmptyState";
import { ReferenceExcerpt } from "../ReferenceExcerpt";
import { projectNodeKindLabel, type ProjectNodeDescriptor } from "../../lib/project-map-model";
import type { ProjectMapMarkdownEditorState } from "../../lib/project-owned-content";
import { buildProjectReadableArchive } from "../../lib/project-readable-export";
import { ProjectAttachmentPresentation } from "./ProjectAttachmentPresentation";
import { ProjectEditorFeedback } from "./ProjectEditorFeedback";
import { ProjectMarkdown } from "./ProjectMarkdown";
import "./project-rich-content.css";
import "./project-reading-surface.css";

const LazyProjectMarkdownEditor = lazy(() => import("./ProjectMarkdownEditor"));

export type ProjectReadingAttachmentEditorState = {
  itemId: string;
  contentId: string;
  caption: string;
  sourceUrl: string;
  status: "editing" | "saving" | "error" | "conflict" | "uncertain";
  message: string | null;
};

export interface ProjectReadingSurfaceProps {
  nodes: ProjectNodeDescriptor[];
  mobile?: boolean;
  projectTitle?: string;
  focusedItemId?: string | null;
  focusRequestSequence?: number;
  inspectedItemId?: string | null;
  onDetailsRequest?: (itemId: string) => void;
  markdownEditor?: ProjectMapMarkdownEditorState | null;
  attachmentEditor?: ProjectReadingAttachmentEditorState | null;
  interactionDisabled?: boolean;
  onMarkdownEditRequest?: (itemId: string) => void;
  onMarkdownDeleteRequest?: (itemId: string) => void;
  onMarkdownChange?: (value: string) => void;
  onMarkdownSave?: () => void;
  onMarkdownCancel?: () => void;
  onAttachmentEditRequest?: (itemId: string) => void;
  onAttachmentDeleteRequest?: (itemId: string) => void;
  onAttachmentChange?: (field: "caption" | "sourceUrl", value: string) => void;
  onAttachmentSave?: () => void;
  onAttachmentCancel?: () => void;
}

type ExportState = {
  status: "idle" | "exporting" | "complete" | "error";
  message: string | null;
};

function archiveBlobBuffer(archive: Uint8Array): ArrayBuffer {
  if (archive.buffer instanceof ArrayBuffer
    && archive.byteOffset === 0
    && archive.byteLength === archive.buffer.byteLength) {
    return archive.buffer;
  }
  const copy = new Uint8Array(archive.byteLength);
  copy.set(archive);
  return copy.buffer;
}

function downloadArchive(archive: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([archiveBlobBuffer(archive)], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportFilename(projectTitle: string) {
  const slug = projectTitle.normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "project";
  return `${slug}-reading-${new Date().toISOString().slice(0, 10)}.zip`;
}

function ReadingMore({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details
    className="project-reading-more"
    open={open}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      event.currentTarget.querySelector("summary")?.focus();
    }}
    onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("button, a")) setOpen(false);
    }}
  >
    <summary aria-label={label} aria-expanded={open} onClick={(event) => {
      event.preventDefault();
      setOpen((current) => !current);
    }}>More</summary>
    <div className="project-reading-more-actions" hidden={!open}>{children}</div>
  </details>;
}

function ReadingReferenceLink({ node }: { node: ProjectNodeDescriptor }) {
  const href = node.openSourceUrl || node.openReferenceUrl;
  if (!href) return null;
  const label = node.openSourceUrl ? "Open source" : "Open reference";
  return /^https?:\/\//i.test(href)
    ? <a className="button compact-button" href={href} target="_blank" rel="noreferrer">{label}</a>
    : <Link className="button compact-button" to={href}>{label}</Link>;
}

export function ProjectReadingSurface({
  nodes,
  mobile = false,
  projectTitle = "Project Reading",
  focusedItemId = null,
  focusRequestSequence = 0,
  inspectedItemId = null,
  onDetailsRequest,
  markdownEditor = null,
  attachmentEditor = null,
  interactionDisabled = false,
  onMarkdownEditRequest,
  onMarkdownDeleteRequest,
  onMarkdownChange,
  onMarkdownSave,
  onMarkdownCancel,
  onAttachmentEditRequest,
  onAttachmentDeleteRequest,
  onAttachmentChange,
  onAttachmentSave,
  onAttachmentCancel,
}: ProjectReadingSurfaceProps) {
  const editorBusy = markdownEditor !== null || attachmentEditor !== null;
  const [exportState, setExportState] = useState<ExportState>({ status: "idle", message: null });
  const itemElementsRef = useRef(new Map<string, HTMLElement>());
  const lastFocusedItemIdRef = useRef<string | null>(null);
  const lastFocusRequestSequenceRef = useRef(focusRequestSequence);

  useEffect(() => {
    const explicitFocusRequested = lastFocusRequestSequenceRef.current !== focusRequestSequence;
    if (!focusedItemId) {
      lastFocusedItemIdRef.current = null;
      lastFocusRequestSequenceRef.current = focusRequestSequence;
      return;
    }
    if (lastFocusedItemIdRef.current === focusedItemId && !explicitFocusRequested) return;
    const target = itemElementsRef.current.get(focusedItemId);
    if (!target) {
      lastFocusedItemIdRef.current = null;
      return;
    }
    lastFocusedItemIdRef.current = focusedItemId;
    lastFocusRequestSequenceRef.current = focusRequestSequence;
    target.scrollIntoView?.({ block: "center" });
    // Focus links may scroll on entry, but only an explicit interaction should
    // move keyboard focus out of the control the reader is currently using.
    if (explicitFocusRequested) {
      const editor = target.querySelector<HTMLElement>("textarea:not([disabled]), input:not([disabled])");
      (editor ?? target).focus({ preventScroll: true });
    }
  }, [focusedItemId, focusRequestSequence, nodes]);

  const exportReading = async () => {
    setExportState({ status: "exporting", message: null });
    try {
      const result = await buildProjectReadableArchive(nodes, { projectTitle });
      downloadArchive(result.archive, exportFilename(projectTitle));
      setExportState({
        status: "complete",
        message: result.manifest.warnings.length
          ? `Exported with ${result.manifest.warnings.length} attachment warning${result.manifest.warnings.length === 1 ? "" : "s"}. See WARNINGS.md in the archive.`
          : "Readable ZIP exported.",
      });
    } catch (error) {
      setExportState({
        status: "error",
        message: error instanceof Error ? error.message : "Readable export failed.",
      });
    }
  };

  return <section className={`project-reading-surface${mobile ? " mobile" : " desktop"}`} aria-label="Project Reading">
    <div className="project-reading-heading">
      <div>
        <p className="card-label">Reading</p>
      </div>
      <ReadingMore label="Reading options">
        <button
          type="button"
          className="button compact-button"
          disabled={!nodes.length || interactionDisabled || editorBusy || exportState.status === "exporting"}
          onClick={exportReading}
        >{exportState.status === "exporting" ? "Exporting…" : "Export readable ZIP"}</button>
      </ReadingMore>
      {exportState.message && <p className={`project-reading-export-message ${exportState.status === "error" ? "error" : exportState.message.includes("warning") ? "warning" : ""}`} role="status">
        {exportState.message}
      </p>}
    </div>
    {markdownEditor?.isNew && <article className="card project-reading-item project-reading-new-note">
      <header><span className="meta-badge">New note</span></header>
      <Suspense fallback={<div className="project-rich-editor-loading">Loading editor…</div>}>
        <LazyProjectMarkdownEditor
          key={markdownEditor.itemId}
          editor={markdownEditor}
          ariaLabel="New Markdown editor"
          onChange={(value) => onMarkdownChange?.(value)}
          onSave={() => onMarkdownSave?.()}
          onCancel={() => onMarkdownCancel?.()}
        />
      </Suspense>
    </article>}
    {nodes.length ? nodes.map((node) => {
      const editingMarkdown = markdownEditor?.itemId === node.itemId;
      const editingAttachment = attachmentEditor?.itemId === node.itemId;
      const focused = focusedItemId === node.itemId;
      const showGeneratedTitle = node.kind !== "markdown";
      return <article
        ref={(element) => {
          if (element) itemElementsRef.current.set(node.itemId, element);
          else itemElementsRef.current.delete(node.itemId);
        }}
        className={`card project-reading-item${focused ? " focused" : ""}`}
        key={node.itemId}
        data-project-item-id={node.itemId}
        aria-current={focused ? "location" : undefined}
        tabIndex={focused ? -1 : undefined}
      >
        <header>
          <span className="meta-badge">{projectNodeKindLabel(node.kind)}</span>
          <div className="project-reading-item-actions">
            {node.kind === "markdown" && !editingMarkdown && onMarkdownEditRequest && <button
              type="button"
              className="button compact-button reading-edit-button"
              aria-label="Edit Markdown"
              disabled={interactionDisabled || editorBusy}
              onClick={() => onMarkdownEditRequest(node.itemId)}
            >Edit</button>}
            {node.kind === "attachment" && !editingAttachment && onAttachmentEditRequest && <button
              type="button"
              className="button compact-button reading-edit-button"
              aria-label="Edit attachment metadata"
              disabled={interactionDisabled || editorBusy}
              onClick={() => onAttachmentEditRequest(node.itemId)}
            >Edit</button>}
            {node.kind === "reference" && <ReadingReferenceLink node={node} />}
            {onDetailsRequest && <button
              type="button"
              className="button compact-button"
              aria-label={`Details for ${node.title}`}
              aria-expanded={inspectedItemId === node.itemId}
              aria-controls="project-inspector-panel"
              data-project-details-trigger={node.itemId}
              disabled={interactionDisabled || editorBusy}
              onClick={(event) => {
                event.currentTarget.focus();
                onDetailsRequest(node.itemId);
              }}
            >Details</button>}
            {node.kind === "markdown" && !editingMarkdown && onMarkdownDeleteRequest && <ReadingMore label={`More actions for ${node.title}`}>
              <button
                type="button"
                className="button compact-button danger"
                disabled={interactionDisabled || editorBusy}
                onClick={() => onMarkdownDeleteRequest(node.itemId)}
              >Move Markdown to trash</button>
            </ReadingMore>}
            {node.kind === "attachment" && !editingAttachment && onAttachmentDeleteRequest && <ReadingMore label={`More actions for ${node.title}`}>
              <button
                type="button"
                className="button compact-button danger"
                disabled={interactionDisabled || editorBusy}
                onClick={() => onAttachmentDeleteRequest(node.itemId)}
              >Move attachment to trash</button>
            </ReadingMore>}
          </div>
        </header>
        {showGeneratedTitle && <h2>{node.title}</h2>}
        {node.subtitle && <p className="card-meta">{node.subtitle}</p>}

        {node.kind === "markdown" && (editingMarkdown ? <Suspense fallback={<div className="project-rich-editor-loading">Loading editor…</div>}>
          <LazyProjectMarkdownEditor
            key={markdownEditor.itemId}
            editor={markdownEditor}
            ariaLabel="Reading Markdown editor"
            onChange={(value) => onMarkdownChange?.(value)}
            onSave={() => onMarkdownSave?.()}
            onCancel={() => onMarkdownCancel?.()}
          />
        </Suspense> : <>
          <ProjectMarkdown source={node.markdownSource || ""} className="project-reading-markdown-source" />
        </>)}

        {node.kind === "attachment" && <>
          {editingAttachment ? <div className="project-attachment-meta-form project-reading-editor">
            <label>Caption
              <textarea
                aria-label="Reading attachment caption"
                value={attachmentEditor.caption}
                disabled={attachmentEditor.status !== "editing" && attachmentEditor.status !== "error"}
                onChange={(event) => onAttachmentChange?.("caption", event.currentTarget.value)}
              />
            </label>
            <label>Source URL
              <input
                aria-label="Reading attachment source URL"
                type="url"
                placeholder="https://…"
                value={attachmentEditor.sourceUrl}
                aria-invalid={attachmentEditor.status === "error" && !isProjectAttachmentSourceUrl(attachmentEditor.sourceUrl.trim() || null)}
                disabled={attachmentEditor.status !== "editing" && attachmentEditor.status !== "error"}
                onChange={(event) => onAttachmentChange?.("sourceUrl", event.currentTarget.value)}
              />
            </label>
            {attachmentEditor.message && <ProjectEditorFeedback
              status={attachmentEditor.status}
              message={attachmentEditor.message}
            />}
            <div className="project-owned-content-pending-actions">
              {(attachmentEditor.status === "editing" || attachmentEditor.status === "error" || attachmentEditor.status === "saving" || attachmentEditor.status === "uncertain") && <button
                type="button"
                className="button primary compact-button"
                disabled={attachmentEditor.status === "saving"}
                onClick={onAttachmentSave}
              >{attachmentEditor.status === "saving" ? "Saving…" : attachmentEditor.status === "uncertain" ? "Retry exact save" : "Save metadata"}</button>}
              {attachmentEditor.status !== "saving" && attachmentEditor.status !== "uncertain" && <button type="button" className="button compact-button" onClick={onAttachmentCancel}>{attachmentEditor.status === "conflict" ? "Discard draft and reload" : "Cancel"}</button>}
            </div>
          </div> : <>
            <ProjectAttachmentPresentation
              title={node.title}
              fileUrl={node.fileUrl}
              mimeType={node.mimeType}
              caption={node.attachmentCaption}
              sourceUrl={node.attachmentSourceUrl}
            />
          </>}
        </>}

        {node.kind === "reference" && <>
          <ReferenceExcerpt source={node.excerpt} format={node.excerptFormat} className="project-reading-excerpt" />
        </>}
      </article>;
    }) : !markdownEditor?.isNew && <EmptyState title="This Project is empty">
      Add a note, attachment, or reference to get started.
    </EmptyState>}
  </section>;
}
