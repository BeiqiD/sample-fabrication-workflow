import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { projectAttachmentCanPreviewImage } from "../../lib/project-owned-content";
import { projectMarkdownSafeHref, projectMarkdownSafeImageSrc } from "../../lib/project-markdown";
import { useModalDialog } from "../../lib/use-modal-dialog";
import "./project-rich-content.css";

export interface ProjectAttachmentPresentationProps {
  title: string;
  fileUrl: string | null;
  mimeType: string | null;
  caption: string | null;
  sourceUrl: string | null;
}

function ProjectImagePreviewDialog({
  title,
  alt,
  imagePreviewUrl,
  onClose,
}: {
  title: string;
  alt: string;
  imagePreviewUrl: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useModalDialog({
    dialogRef,
    initialFocusRef: closeButtonRef,
    onClose,
  });

  return createPortal(<div
    className="project-image-preview-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    <div
      ref={dialogRef}
      className="project-image-preview-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${alt}`}
    >
      <div className="project-image-preview-toolbar">
        <p>{title}</p>
        <button
          ref={closeButtonRef}
          type="button"
          className="button compact-button"
          onClick={onClose}
        >Close</button>
      </div>
      <img src={imagePreviewUrl} alt={alt} />
    </div>
  </div>, document.body);
}

export function ProjectAttachmentPresentation({
  title,
  fileUrl,
  mimeType,
  caption,
  sourceUrl,
}: ProjectAttachmentPresentationProps) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const safeFileUrl = fileUrl ? projectMarkdownSafeImageSrc(fileUrl) : null;
  const safeSourceUrl = sourceUrl ? projectMarkdownSafeHref(sourceUrl) : null;
  const imagePreviewUrl = safeFileUrl
    && projectAttachmentCanPreviewImage(mimeType)
    && failedPreviewUrl !== safeFileUrl
    ? safeFileUrl
    : null;
  const alt = caption?.trim() || title;

  useEffect(() => {
    if (!imagePreviewUrl) setPreviewOpen(false);
  }, [imagePreviewUrl]);

  return <div className="project-attachment-presentation">
    {imagePreviewUrl ? <button
      type="button"
      className="project-reading-image-button"
      aria-label={`Preview image: ${alt}`}
      onClick={() => setPreviewOpen(true)}
    >
      <img
        className="project-reading-image"
        src={imagePreviewUrl}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailedPreviewUrl(imagePreviewUrl)}
      />
    </button> : <div className="project-reading-file-card">
      <span className="project-reading-file-mark" aria-hidden="true">FILE</span>
      <div>
        <strong>{title}</strong>
        <small>{mimeType || "Generic file"}</small>
      </div>
      {safeFileUrl && <a className="button compact-button" href={safeFileUrl}>Open file</a>}
    </div>}

    {caption && <p className="project-reading-caption">{caption}</p>}
    <div className="project-attachment-actions">
      {safeSourceUrl && <a
        className="button wide"
        href={safeSourceUrl}
        target="_blank"
        rel="noopener noreferrer"
      >Open source URL</a>}
      {safeFileUrl && imagePreviewUrl && <a className="button wide" href={safeFileUrl}>Open attachment</a>}
    </div>

    {previewOpen && imagePreviewUrl && <ProjectImagePreviewDialog
      title={caption || title}
      alt={alt}
      imagePreviewUrl={imagePreviewUrl}
      onClose={() => setPreviewOpen(false)}
    />}
  </div>;
}
