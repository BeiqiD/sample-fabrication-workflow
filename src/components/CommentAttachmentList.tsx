import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommentAttachment, CommentImage } from "../../shared/types";
import { isTiffMetadata } from "../../shared/tiff";
import { api } from "../lib/api";
import { commentImageUrl } from "../lib/asset-media";
import { AttachmentCard } from "./AttachmentCard";
import { attachmentStatusLabel, safeAttachmentHref } from "../lib/attachment-presentation";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

type Removal = { id: string; filename: string; hasBytes: boolean };

export function CommentAttachmentList({ attachments, images = [], submissionId, onChanged, common = false, density = "compact", className = "comment-attachment-list" }: {
  attachments: CommentAttachment[];
  images?: CommentImage[];
  submissionId?: string | null;
  onChanged?: () => Promise<void>;
  common?: boolean;
  density?: "comfortable" | "compact" | "dense";
  className?: string;
}) {
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reloadRequired, setReloadRequired] = useState(false);
  const confirmedRemoved = useRef(false);
  const unresolvedRemovals = useRef(new Map<string, boolean>());
  const listRef = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const itemIds = [...attachments, ...images].map(item => item.id).join(",");
  useEffect(() => {
    if (removal && !itemIds.split(",").includes(removal.id)) {
      unresolvedRemovals.current.delete(removal.id);
      setRemoval(null); setReloadRequired(false); setError(""); confirmedRemoved.current = false;
    }
  }, [removal, itemIds]);

  function requestRemoval(item: Removal) {
    confirmedRemoved.current = unresolvedRemovals.current.get(item.id) ?? false;
    setError(""); setReloadRequired(unresolvedRemovals.current.has(item.id)); setRemoval(item);
  }
  async function reload() {
    if (!onChanged) return;
    setBusy(true);
    try {
      await onChanged();
      if (!active.current) return;
      if (removal && !confirmedRemoved.current) unresolvedRemovals.current.delete(removal.id);
      // Confirmed removal is never resent if owner refresh is stale or fails.
      setReloadRequired(confirmedRemoved.current);
      setError(confirmedRemoved.current ? "Attachment removed. Reload the owner to update its attachment list." : "Attachment state reloaded. Review the current attachment before trying again.");
    } catch (cause) {
      if (active.current) setError(`Could not reload attachment state. ${(cause as Error).message}`);
    } finally { if (active.current) setBusy(false); }
  }
  async function remove() {
    if (!removal || !submissionId || !onChanged || busy) return;
    if (reloadRequired) { await reload(); return; }
    setBusy(true); setError("");
    try {
      await api.removeReadyCommentSubmissionItem(submissionId, removal.id);
      confirmedRemoved.current = true;
      unresolvedRemovals.current.set(removal.id, true);
      await onChanged();
      if (active.current) {
        setRemoval(null);
      }
    } catch (cause) {
      if (!active.current) return;
      // Even an apparent failure may follow a committed DELETE. Keep the body
      // and other items, and require a read before another explicit mutation.
      setReloadRequired(true);
      unresolvedRemovals.current.set(removal.id, confirmedRemoved.current);
      setError(`${(cause as Error).message} Reload attachment state before another removal attempt.`);
    } finally { if (active.current) setBusy(false); }
  }
  function actions(item: CommentAttachment | CommentImage, filename: string) {
    if (!submissionId || !onChanged || item.status !== "ready") return undefined;
    const dependent = "relatedCommentImageId" in item && item.relatedCommentImageId
      ? images.some(image => image.id === item.relatedCommentImageId && image.status === "ready" && isTiffMetadata(image.originalFilename, image.originalMimeType))
      : false;
    return <div className="comment-attachment-child-actions">
      {dependent && <span className="attachment-dependency-hint">Required by the TIFF preview. Remove its preview first.</span>}
      <button type="button" className="text-button" disabled={busy || dependent} title={dependent ? "Required by the TIFF preview. Remove its preview first." : undefined}
        aria-label={`Remove attachment: ${filename}`} onClick={() => requestRemoval({ id: item.id, filename, hasBytes: !("kind" in item) || item.kind !== "link" })}>Remove attachment</button>
    </div>;
  }
  if (!attachments.length && !images.length && !removal && !submissionId) return null;
  return <div ref={listRef} tabIndex={-1} className={className} aria-label="Comment attachments">
    <small>{attachments.length || images.length ? "Attachments" : "No attachments"}</small>
    {images.map(image => {
      const href = image.status === "ready" ? safeAttachmentHref(commentImageUrl(image)) : null;
      return <AttachmentCard key={image.id} filename={image.filename} title={image.originalFilename !== image.filename ? image.originalFilename : undefined}
        description="Comment image preview; the original file is a separate attachment when included."
        mimeType={image.mimeType} byteSize={image.byteSize} href={href} actionLabel="Open image" external density={density}
        status={href ? undefined : { kind: image.status === "failed" ? "failed" : image.status === "ready" ? "unavailable" : "pending", label: image.status === "ready" ? "Image unavailable" : attachmentStatusLabel(image.status), message: image.error ?? undefined }}
        actions={actions(image, image.filename)} />;
    })}
    {attachments.map(attachment => {
      const filename = attachment.kind === "file" ? attachment.filename : attachment.title;
      const href = attachment.status === "ready" ? safeAttachmentHref(attachment.kind === "file" ? attachment.downloadUrl : attachment.url) : null;
      return <AttachmentCard key={attachment.id} filename={filename} title={attachment.title}
        description={attachment.description || (attachment.kind === "link" ? attachment.url : null)}
        mimeType={attachment.kind === "file" ? attachment.mimeType : "External link"} byteSize={attachment.kind === "file" ? attachment.byteSize : null}
        href={href} actionLabel={attachment.kind === "file" ? "Download file" : "Open source link"}
        download={attachment.kind === "file" ? attachment.filename : undefined} external={attachment.kind === "link"} density={density}
        status={href ? undefined : { kind: attachment.status === "failed" ? "failed" : attachment.status === "ready" ? "unavailable" : "pending", label: attachment.status === "ready" ? "Attachment unavailable" : attachmentStatusLabel(attachment.status), message: attachment.error ?? undefined }}
        actions={actions(attachment, filename)} />;
    })}
    {removal && createPortal(<ConfirmDeleteDialog title="Remove this attachment?"
      returnFocusRef={listRef}
      description={`${common ? "This attachment will be removed from every target of this common Comment. " : ""}The Comment body and other attachments remain. ${removal.hasBytes ? "Removed attachment bytes have a guaranteed 24-hour recovery window; later recovery depends on whether cleanup has begun." : "Only the link is removed; the external source is unchanged."}`}
      summary={removal.filename} deleting={busy} error={error} eyebrow="Remove attachment" appendIrreversibleWarning={false}
      confirmLabel={reloadRequired ? "Reload attachment state" : "Remove attachment"} busyLabel={reloadRequired ? "Reloading…" : "Removing…"}
      onCancel={() => { setRemoval(null); setError(""); setReloadRequired(false); }} onConfirm={() => void remove()} />, document.body)}
  </div>;
}
