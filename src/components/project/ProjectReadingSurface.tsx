
import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../EmptyState";
import type { ProjectNodeDescriptor } from "../../lib/project-map-model";
import { projectAttachmentCanPreviewImage, type ProjectMapMarkdownEditorState } from "../../lib/project-owned-content";

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
  markdownEditor?: ProjectMapMarkdownEditorState | null;
  attachmentEditor?: ProjectReadingAttachmentEditorState | null;
  interactionDisabled?: boolean;
  onMarkdownEditRequest?: (itemId: string) => void;
  onMarkdownDeleteRequest?: (itemId: string) => void;
  onMarkdownChange?: (value: string) => void;
  onMarkdownSave?: () => void;
  onMarkdownCancel?: () => void;
  onAttachmentEditRequest?: (itemId: string) => void;
  onAttachmentChange?: (field: "caption" | "sourceUrl", value: string) => void;
  onAttachmentSave?: () => void;
  onAttachmentCancel?: () => void;
}

function ReadingAttachmentPreview({ fileUrl, mimeType, alt }: {
  fileUrl: string | null;
  mimeType: string | null;
  alt: string;
}) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  if (!fileUrl || !projectAttachmentCanPreviewImage(mimeType) || failedPreviewUrl === fileUrl) return null;
  return <img
    className="project-reading-image"
    src={fileUrl}
    alt={alt}
    onError={() => setFailedPreviewUrl(fileUrl)}
  />;
}

export function ProjectReadingSurface({
  nodes,
  mobile = false,
  markdownEditor = null,
  attachmentEditor = null,
  interactionDisabled = false,
  onMarkdownEditRequest,
  onMarkdownDeleteRequest,
  onMarkdownChange,
  onMarkdownSave,
  onMarkdownCancel,
  onAttachmentEditRequest,
  onAttachmentChange,
  onAttachmentSave,
  onAttachmentCancel,
}: ProjectReadingSurfaceProps) {
  const editorBusy = markdownEditor !== null || attachmentEditor !== null;
  return <section className={`project-reading-surface${mobile ? " mobile" : " desktop"}`} aria-label="Project Reading">
    <div className="project-reading-heading">
      <p className="card-label">Reading</p>
      <p className="card-meta">Items follow immutable creation order. Reading never changes Map positions, edges, or occurrence order.</p>
    </div>
    {nodes.length ? nodes.map((node) => {
      const editingMarkdown = markdownEditor?.itemId === node.itemId;
      const editingAttachment = attachmentEditor?.itemId === node.itemId;
      return <article className="card project-reading-item" key={node.itemId} data-project-item-id={node.itemId}>
        <header><span className="meta-badge">{node.kind}</span><small>#{node.createdSequence}</small></header>
        <h2>{node.title}</h2>
        {node.subtitle && <p className="card-meta">{node.subtitle}</p>}

        {node.kind === "markdown" && (editingMarkdown ? <div className="project-reading-editor">
          <textarea
            aria-label="Reading Markdown editor"
            value={markdownEditor.value}
            disabled={markdownEditor.status !== "editing"}
            onChange={(event) => onMarkdownChange?.(event.currentTarget.value)}
          />
          {markdownEditor.message && <p className="error-banner">{markdownEditor.message}</p>}
          <div className="project-owned-content-pending-actions">
            {(markdownEditor.status === "editing" || markdownEditor.status === "saving" || markdownEditor.status === "uncertain") && <button
              type="button"
              className="button primary compact-button"
              disabled={markdownEditor.status === "saving" || !markdownEditor.value.trim()}
              onClick={onMarkdownSave}
            >{markdownEditor.status === "saving" ? "Saving…" : markdownEditor.status === "uncertain" ? "Retry exact save" : "Save Markdown"}</button>}
            {markdownEditor.status !== "saving" && markdownEditor.status !== "uncertain" && <button type="button" className="button compact-button" onClick={onMarkdownCancel}>Cancel</button>}
          </div>
        </div> : <>
          <div className="project-reading-markdown-source">{node.markdownSource || ""}</div>
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
          <ReadingAttachmentPreview
            fileUrl={node.fileUrl}
            mimeType={node.mimeType}
            alt={node.attachmentCaption || node.title}
          />
          {node.attachmentCaption && <p className="project-reading-caption">{node.attachmentCaption}</p>}
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
          </div> : <button
            type="button"
            className="button reading-edit-button"
            disabled={interactionDisabled || editorBusy}
            onClick={() => onAttachmentEditRequest?.(node.itemId)}
          >Edit attachment metadata</button>}
          {node.attachmentSourceUrl && <a className="button wide" href={node.attachmentSourceUrl} target="_blank" rel="noreferrer">Open source URL</a>}
          {node.fileUrl && <a className="button wide" href={node.fileUrl}>Open attachment</a>}
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
