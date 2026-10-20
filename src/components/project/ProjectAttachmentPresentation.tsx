import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { projectAttachmentCanPreviewImage } from "../../lib/project-owned-content";
import { projectMarkdownSafeHref } from "../../lib/project-markdown";
import { useModalDialog } from "../../lib/use-modal-dialog";
import { formatAttachmentBytes, safeAttachmentHref } from "../../lib/attachment-presentation";
import { AttachmentCard } from "../AttachmentCard";
import "./project-rich-content.css";

export interface ProjectAttachmentPresentationProps {
  title: string;
  fileUrl: string | null;
  mimeType: string | null;
  byteSize?: number | null;
  caption: string | null;
  sourceUrl: string | null;
  density?: "comfortable" | "compact";
  captionRegionLabel?: string;
}

function ProjectImagePreviewDialog({
  title,
  alt,
  imagePreviewUrl,
  onClose,
  onPreviewError,
  returnFocusRef,
}: {
  title: string;
  alt: string;
  imagePreviewUrl: string;
  onClose: () => void;
  onPreviewError: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useModalDialog({
    dialogRef,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
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
      <img src={imagePreviewUrl} alt={alt} onError={onPreviewError} />
    </div>
  </div>, document.body);
}

export function ProjectAttachmentPresentation({
  title,
  fileUrl,
  mimeType,
  byteSize,
  caption,
  sourceUrl,
  density = "comfortable",
  captionRegionLabel,
}: ProjectAttachmentPresentationProps) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const [previewOpenUrl, setPreviewOpenUrl] = useState<string | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const imageButtonRef = useRef<HTMLButtonElement>(null);
  const presentationRef = useRef<HTMLDivElement>(null);
  const previewReturnFocusRef = useMemo(() => ({
    get current() {
      return retryButtonRef.current ?? imageButtonRef.current ?? presentationRef.current;
    },
  }), []);
  const retryRequestedRef = useRef(false);
  const failureFocusRequestedRef = useRef(false);
  const safeFileUrl = safeAttachmentHref(fileUrl);
  const safeSourceUrl = sourceUrl ? projectMarkdownSafeHref(sourceUrl) : null;
  const imagePreviewUrl = safeFileUrl
    && projectAttachmentCanPreviewImage(mimeType)
    && failedPreviewUrl !== safeFileUrl
    ? safeFileUrl
    : null;
  const alt = caption?.trim() || title;
  const fileMetadata = [mimeType?.trim(), formatAttachmentBytes(byteSize)].filter(Boolean).join(" · ");

  useEffect(() => {
    setFailedPreviewUrl(null);
    setPreviewOpenUrl(null);
    retryRequestedRef.current = false;
    failureFocusRequestedRef.current = false;
  }, [safeFileUrl, mimeType]);

  useEffect(() => {
    if (!imagePreviewUrl) setPreviewOpenUrl(null);
    if (!imagePreviewUrl && failureFocusRequestedRef.current) {
      failureFocusRequestedRef.current = false;
      retryButtonRef.current?.focus();
    }
    if (imagePreviewUrl && retryRequestedRef.current) {
      retryRequestedRef.current = false;
      imageButtonRef.current?.focus();
    }
  }, [imagePreviewUrl]);

  return <div
    ref={presentationRef}
    className={`project-attachment-presentation ${density}`}
    role="group"
    aria-label={`Project attachment: ${title}`}
    tabIndex={-1}
  >
    {imagePreviewUrl ? <button
      ref={imageButtonRef}
      type="button"
      className="project-reading-image-button"
      aria-label={`Preview image: ${alt}`}
      onClick={() => setPreviewOpenUrl(imagePreviewUrl)}
    >
      <img
        className="project-reading-image"
        src={imagePreviewUrl}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => {
          failureFocusRequestedRef.current = document.activeElement === imageButtonRef.current;
          setFailedPreviewUrl(imagePreviewUrl);
        }}
      />
    </button> : <AttachmentCard
      filename={title}
      mimeType={mimeType}
      byteSize={byteSize}
      href={safeFileUrl}
      actionLabel="Open attachment"
      actionAriaLabel="Open attachment"
      density={density}
      description={safeFileUrl && failedPreviewUrl !== safeFileUrl
        ? "No browser preview is available for this file." : undefined}
      status={!safeFileUrl ? {
        kind: "unavailable",
        label: "Attachment unavailable",
        message: "The attachment file is unavailable.",
      } : failedPreviewUrl === safeFileUrl ? {
        kind: "failed",
        label: "Image preview unavailable",
        message: "The image preview could not be loaded. You can retry the preview or open the attachment.",
      } : undefined}
      actions={safeFileUrl && failedPreviewUrl === safeFileUrl ? <button
        ref={retryButtonRef}
        type="button"
        className="button compact-button"
        onClick={() => {
          retryRequestedRef.current = true;
          setFailedPreviewUrl(null);
        }}
      >Retry image preview</button> : undefined}
    />}

    {imagePreviewUrl && fileMetadata && <p className="project-attachment-file-meta">{fileMetadata}</p>}

    {caption && <p
      className={`project-reading-caption${captionRegionLabel ? " project-inspector-excerpt" : ""}`}
      role={captionRegionLabel ? "region" : undefined}
      aria-label={captionRegionLabel}
      tabIndex={captionRegionLabel ? 0 : undefined}
      data-project-reading-content={captionRegionLabel ? "true" : undefined}
    >{caption}</p>}
    <div className="project-attachment-actions">
      {safeSourceUrl && <a
        className="button wide"
        href={safeSourceUrl}
        target="_blank"
        rel="noopener noreferrer"
      >Open source URL</a>}
      {safeFileUrl && imagePreviewUrl && <a className="button wide" href={safeFileUrl}>Open attachment</a>}
    </div>

    {previewOpenUrl === imagePreviewUrl && imagePreviewUrl && <ProjectImagePreviewDialog
      title={caption || title}
      alt={alt}
      imagePreviewUrl={imagePreviewUrl}
      onClose={() => setPreviewOpenUrl(null)}
      onPreviewError={() => setFailedPreviewUrl(imagePreviewUrl)}
      returnFocusRef={previewReturnFocusRef}
    />}
  </div>;
}
