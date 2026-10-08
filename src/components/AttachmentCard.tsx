import type { ReactNode } from "react";
import { formatAttachmentBytes, safeAttachmentHref } from "../lib/attachment-presentation";
import "./attachment-card.css";

export interface AttachmentCardStatus {
  kind: "pending" | "failed" | "unavailable";
  label: string;
  message?: string;
}

export interface AttachmentCardProps {
  filename: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  byteSize?: number | null;
  href?: string | null;
  actionLabel?: string;
  actionAriaLabel?: string;
  download?: string;
  external?: boolean;
  status?: AttachmentCardStatus;
  density: "comfortable" | "compact" | "dense";
  actions?: ReactNode;
  className?: string;
}

/** Presentation only. Domain adapters supply read availability and every mutation action. */
export function AttachmentCard({
  filename,
  title,
  description,
  mimeType,
  byteSize,
  href,
  actionLabel = "Open attachment",
  actionAriaLabel,
  download,
  external = false,
  status,
  density,
  actions,
  className = "",
}: AttachmentCardProps) {
  const displayFilename = filename || "Unnamed attachment";
  const contextTitle = title?.trim() && title.trim() !== displayFilename.trim() ? title : null;
  const size = formatAttachmentBytes(byteSize);
  const typeLabel = mimeType?.trim() || "Generic file";
  // A failed browser preview can still have an authorized original read. A
  // transfer failure supplies no href; pending/unavailable reads stay blocked.
  const primaryHref = status?.kind === "pending" || status?.kind === "unavailable"
    ? null : safeAttachmentHref(href);

  return <div
    className={`attachment-card attachment-card--${density} ${className}`.trim()}
    data-density={density}
    data-attachment-state={status?.kind}
    role="group"
    aria-label={`Attachment: ${displayFilename}`}
  >
    <span className="attachment-card__mark" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" focusable="false">
        <path d="m8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3a2 2 0 0 1 3 3L5 17" />
      </svg>
    </span>
    <div className="attachment-card__copy">
      {contextTitle && <strong className="attachment-card__title" title={contextTitle}>{contextTitle}</strong>}
      <span className="attachment-card__filename" title={displayFilename}>{displayFilename}</span>
      <span className="attachment-card__metadata">
        <span>{typeLabel}</span>
        {size && <> · <span>{size}</span></>}
      </span>
      {description && <p className="attachment-card__description">{description}</p>}
      {status && <div className={`attachment-card__status attachment-card__status--${status.kind}`} role="status">
        <strong>{status.label}</strong>
        {status.message && <span>{status.message}</span>}
      </div>}
    </div>
    {(primaryHref || actions) && <div className="attachment-card__actions">
      {primaryHref && <a
        className="attachment-card__primary"
        href={primaryHref}
        download={download}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        aria-label={actionAriaLabel || `${actionLabel}: ${displayFilename}`}
      >{actionLabel}</a>}
      {actions}
    </div>}
  </div>;
}
