import type {
  CommentAttachment,
  CommentImage,
  CommentSubmission,
  CommentSubmissionStatus,
} from "../shared/types";

export type CommentSubmissionRow = {
  id: string;
  context_kind: "sample" | "run_steps";
  sample_id: string | null;
  scope: "common" | "individual" | null;
  body: string;
  status: CommentSubmissionStatus;
  error_message: string | null;
  actor_email: string | null;
  created_at: string;
  updated_at: string;
};

export type CommentSubmissionItemRow = {
  id: string;
  submission_id: string;
  kind: "comment_image" | "attachment" | "link";
  status: CommentImage["status"];
  filename: string | null;
  mime_type: string | null;
  byte_size: number | null;
  original_filename: string | null;
  original_mime_type: string | null;
  original_byte_size: number | null;
  title: string | null;
  description: string | null;
  external_url: string | null;
  sha256: string | null;
  related_item_id: string | null;
  error_message: string | null;
  asset_key: string | null;
  storage_object_id: string | null;
};

export function serializeCommentSubmissions(
  submissions: CommentSubmissionRow[],
  items: CommentSubmissionItemRow[],
) {
  const itemsBySubmission = new Map<string, CommentSubmissionItemRow[]>();
  for (const item of items) {
    itemsBySubmission.set(item.submission_id, [...(itemsBySubmission.get(item.submission_id) ?? []), item]);
  }
  return submissions.map((submission): CommentSubmission => {
    const submissionItems = itemsBySubmission.get(submission.id) ?? [];
    const images: CommentImage[] = submissionItems
      .filter((item) => item.kind === "comment_image")
      .map((item) => ({
        id: item.id,
        filename: item.filename || "comment-image",
        mimeType: item.mime_type || "application/octet-stream",
        byteSize: Number(item.byte_size || 0),
        originalFilename: item.original_filename || item.filename || "comment-image",
        originalMimeType: item.original_mime_type || "application/octet-stream",
        originalByteSize: Number(item.original_byte_size || 0),
        assetKey: item.asset_key,
        status: item.status,
        error: item.error_message,
        relatedAttachmentId: item.related_item_id,
      }));
    const attachments: CommentAttachment[] = submissionItems
      .filter((item) => item.kind !== "comment_image")
      .map((item): CommentAttachment => item.kind === "link" ? {
        id: item.id,
        kind: "link",
        title: item.title || item.external_url || "Attachment link",
        description: item.description,
        url: item.external_url || "",
        status: item.status,
        error: item.error_message,
      } : {
        id: item.id,
        kind: "file",
        title: item.title || item.filename || "Attachment",
        description: item.description,
        filename: item.filename || "attachment",
        mimeType: item.mime_type || "application/octet-stream",
        byteSize: Number(item.byte_size || 0),
        sha256: item.sha256,
        downloadUrl: item.status === "ready" && item.storage_object_id
          ? `/api/attachments/${encodeURIComponent(item.id)}/download`
          : null,
        status: item.status,
        error: item.error_message,
        relatedCommentImageId: item.related_item_id,
      });
    return {
      id: submission.id,
      contextKind: submission.context_kind,
      scope: submission.scope,
      body: submission.body,
      status: submission.status,
      error: submission.error_message,
      images,
      attachments,
      actorEmail: submission.actor_email,
      createdAt: submission.created_at,
      updatedAt: submission.updated_at,
    };
  });
}
