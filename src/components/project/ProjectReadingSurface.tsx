import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../EmptyState";
import type { ProjectNodeDescriptor } from "../../lib/project-map-model";
import type { ProjectMapMarkdownEditorState } from "../../lib/project-owned-content";
import { projectMarkdownStartsWithHeading } from "../../lib/project-markdown";
import { buildProjectReadableArchive } from "../../lib/project-readable-export";
import { ProjectAttachmentPresentation } from "./ProjectAttachmentPresentation";
import { ProjectMarkdown } from "./ProjectMarkdown";
import "./project-rich-content.css";

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

export function ProjectReadingSurface({
  nodes,
  mobile = false,
  projectTitle = "Project Reading",
  focusedItemId = null,
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

  useEffect(() => {
    if (!focusedItemId) {
      lastFocusedItemIdRef.current = null;
      return;
    }
    if (lastFocusedItemIdRef.current === focusedItemId) return;
    const target = itemElementsRef.current.get(focusedItemId);
    if (!target) {
      lastFocusedItemIdRef.current = null;
      return;
    }
    lastFocusedItemIdRef.current = focusedItemId;
    target.scrollIntoView?.({ block: "center" });
  }, [focusedItemId, nodes]);

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
        <p className="card-meta">Items follow immutable creation order. Reading never changes Map positions, edges, or occurrence order.</p>
      </div>
      <div className="project-reading-export-actions">
        <button
          type="button"
          className="button compact-button"
          disabled={!nodes.length || interactionDisabled || editorBusy || exportState.status === "exporting"}
          onClick={exportReading}
        >{exportState.status === "exporting" ? "Exporting…" : "Export readable ZIP"}</button>
      </div>
      {exportState.message && <p className={`project-reading-export-message ${exportState.status === "error" ? "error" : exportState.message.includes("warning") ? "warning" : ""}`} role="status">
        {exportState.message}
      </p>}
    </div>
    {nodes.length ? nodes.map((node) => {
      const editingMarkdown = markdownEditor?.itemId === node.itemId;
      const editingAttachment = attachmentEditor?.itemId === node.itemId;
      const focused = focusedItemId === node.itemId;
      const showGeneratedTitle = node.kind !== "markdown" || !projectMarkdownStartsWithHeading(node.markdownSource);
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
        <header><span className="meta-badge">{node.kind}</span><small>#{node.createdSequence}</small></header>
        {showGeneratedTitle && <h2>{node.title}</h2>}
        {node.subtitle && node.kind !== "markdown" && <p className="card-meta">{node.subtitle}</p>}

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
          <div className="project-owned-content-pending-actions">
            <button
              type="button"
              className="button reading-edit-button"
              disabled={interactionDisabled || editorBusy}
              onClick={() => onMarkdownEditRequest?.(node.itemId)}
            >Edit Markdown</button>
            <button
              type="button"
              className="button reading-edit-button"
              disabled={interactionDisabled || editorBusy}
              onClick={() => onMarkdownDeleteRequest?.(node.itemId)}
            >Move Markdown to trash</button>
          </div>
        </>)}

        {node.kind === "attachment" && <>
          {editingAttachment ? <div className="project-attachment-meta-form project-reading-editor">
            <label>Caption
              <textarea
                aria-label="Reading attachment caption"
                value={attachmentEditor.caption}
                disabled={attachmentEditor.status !== "editing"}
                onChange={(event) => onAttachmentChange?.("caption", event.currentTarget.value)}
              />
            </label>
            <label>Source URL
              <input
                aria-label="Reading attachment source URL"
                type="url"
                placeholder="https://…"
                value={attachmentEditor.sourceUrl}
                disabled={attachmentEditor.status !== "editing"}
                onChange={(event) => onAttachmentChange?.("sourceUrl", event.currentTarget.value)}
              />
            </label>
            {attachmentEditor.message && <p className="error-banner">{attachmentEditor.message}</p>}
            <div className="project-owned-content-pending-actions">
              {(attachmentEditor.status === "editing" || attachmentEditor.status === "saving" || attachmentEditor.status === "uncertain") && <button
                type="button"
                className="button primary compact-button"
                disabled={attachmentEditor.status === "saving"}
                onClick={onAttachmentSave}
              >{attachmentEditor.status === "saving" ? "Saving…" : attachmentEditor.status === "uncertain" ? "Retry exact save" : "Save metadata"}</button>}
              {attachmentEditor.status !== "saving" && attachmentEditor.status !== "uncertain" && <button type="button" className="button compact-button" onClick={onAttachmentCancel}>Cancel</button>}
            </div>
          </div> : <>
            <ProjectAttachmentPresentation
              title={node.title}
              fileUrl={node.fileUrl}
              mimeType={node.mimeType}
              caption={node.attachmentCaption}
              sourceUrl={node.attachmentSourceUrl}
            />
            <div className="project-owned-content-pending-actions">
              <button
                type="button"
                className="button reading-edit-button"
                disabled={interactionDisabled || editorBusy}
                onClick={() => onAttachmentEditRequest?.(node.itemId)}
              >Edit attachment metadata</button>
              {onAttachmentDeleteRequest && <button
                type="button"
                className="button reading-edit-button"
                disabled={interactionDisabled || editorBusy}
                onClick={() => onAttachmentDeleteRequest(node.itemId)}
              >Move attachment to trash</button>}
            </div>
          </>}
        </>}

        {node.kind === "reference" && <>
          {node.excerpt && <p className="project-reading-excerpt">{node.excerpt}</p>}
          {node.openReferenceUrl && <Link className="button wide" to={node.openReferenceUrl}>Open reference</Link>}
        </>}
      </article>;
    }) : <EmptyState title="This Project is empty">
      Add references or Project-owned content from the desktop Map workspace.
    </EmptyState>}
  </section>;
}
