import type { CommentAttachment } from "../../shared/types";

function formatBytes(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CommentAttachmentList({
  attachments,
  className = "comment-attachment-list",
}: {
  attachments: CommentAttachment[];
  className?: string;
}) {
  if (!attachments.length) return null;

  return <div className={className}>
    <small>Attachments</small>
    {attachments.map((attachment) => attachment.kind === "link"
      ? <a href={attachment.url} target="_blank" rel="noreferrer" key={attachment.id}>↗ {attachment.title}</a>
      : attachment.downloadUrl
        ? <a href={attachment.downloadUrl} download={attachment.filename} key={attachment.id}>📎 {attachment.filename} · {formatBytes(attachment.byteSize)}</a>
        : <span className={`attachment-status status-${attachment.status}`} key={attachment.id}>📎 {attachment.filename} · {attachment.status}</span>)}
  </div>;
}
