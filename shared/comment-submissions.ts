import type { CommentSubmissionItemInput, CreateCommentSubmissionInput } from "./types";

export const MAX_COMMENT_IMAGE_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_COMMENT_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_MANAGED_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_COMMENT_SUBMISSION_ITEMS = 24;

const ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function validSubmissionId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function requiresManagedStorage(items: CommentSubmissionItemInput[]) {
  return items.some((item) => item.kind === "attachment");
}

export function safeAttachmentUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validCommonItem(item: CommentSubmissionItemInput) {
  return validSubmissionId(item.id);
}

export function validateCommentSubmissionInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return "A comment submission is required";
  const candidate = input as Partial<CreateCommentSubmissionInput>;
  if (!validSubmissionId(candidate.id)) return "The submission ID is invalid";
  if (typeof candidate.body !== "string" || candidate.body.length > 10_000) return "Comment text is invalid";
  if (!Array.isArray(candidate.items) || candidate.items.length > MAX_COMMENT_SUBMISSION_ITEMS) {
    return `A comment can contain at most ${MAX_COMMENT_SUBMISSION_ITEMS} uploaded items`;
  }
  if (!candidate.body.trim() && candidate.items.length === 0) return "The comment is empty";
  if (!candidate.context || typeof candidate.context !== "object") return "A comment context is required";

  if (candidate.context.kind === "sample") {
    if (!candidate.context.sampleId || typeof candidate.context.expectedUpdatedAt !== "string") {
      return "A current sample revision is required";
    }
  } else if (candidate.context.kind === "run_steps") {
    if (!["common", "individual"].includes(candidate.context.scope)
      || !Array.isArray(candidate.context.targets)
      || candidate.context.targets.length < 1
      || candidate.context.targets.length > 12
      || (candidate.context.scope === "individual" && candidate.context.targets.length !== 1)) {
      return "Valid process-step targets are required";
    }
  } else {
    return "The comment context is invalid";
  }

  const ids = new Set<string>();
  const kinds = new Map<string, CommentSubmissionItemInput["kind"]>();
  for (const item of candidate.items) {
    if (!item || typeof item !== "object" || !validCommonItem(item) || ids.has(item.id)) return "A submission item is invalid";
    ids.add(item.id);
    kinds.set(item.id, item.kind);
    if (item.kind === "comment_image") {
      if (!item.filename || !item.mimeType.startsWith("image/") || item.byteSize < 1
        || item.byteSize > MAX_COMMENT_IMAGE_UPLOAD_BYTES || !item.originalFilename
        || !item.originalMimeType || item.originalByteSize < 1
        || item.originalByteSize > MAX_COMMENT_IMAGE_SOURCE_BYTES) return "Comment image metadata is invalid";
    } else if (item.kind === "attachment") {
      if (!item.filename || item.filename.length > 255 || !item.mimeType || item.mimeType.length > 200
        || item.byteSize < 1 || item.byteSize > MAX_MANAGED_ATTACHMENT_BYTES) return "Attachment metadata is invalid";
    } else if (item.kind === "link") {
      if (!item.title.trim() || item.title.length > 500 || item.url.length > 2_000
        || !safeAttachmentUrl(item.url) || (item.description?.length ?? 0) > 2_000) return "Attachment link metadata is invalid";
    } else {
      return "The submission item type is invalid";
    }
  }

  for (const item of candidate.items) {
    if (item.kind === "comment_image" && item.relatedAttachmentId && kinds.get(item.relatedAttachmentId) !== "attachment") {
      return "A related original attachment is missing";
    }
    if (item.kind === "attachment" && item.relatedCommentImageId && kinds.get(item.relatedCommentImageId) !== "comment_image") {
      return "A related comment image is missing";
    }
  }
  return null;
}
