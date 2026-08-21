import type { CommentSubmissionItemInput, RunStepTarget } from "./types";
import {
  isTiffMetadata,
  normalizedAttachmentClassificationMimeType,
  normalizedBrowserSafeAttachmentPreviewMimeType,
} from "./tiff";

export const MAX_COMMENT_IMAGE_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_COMMENT_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_MANAGED_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_COMMENT_SUBMISSION_ITEMS = 24;

const ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/;
const MAX_ATTACHMENT_FILENAME_LENGTH = 255;
const MAX_ATTACHMENT_MIME_LENGTH = 200;
const MAX_ATTACHMENT_TITLE_LENGTH = 500;
const MAX_ATTACHMENT_DESCRIPTION_LENGTH = 2_000;
const MAX_ATTACHMENT_URL_LENGTH = 2_000;
const MAX_CONTEXT_VALUE_LENGTH = 200;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRequiredString(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !value.includes("\u0000");
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_CONTEXT_VALUE_LENGTH
    && !value.includes("\u0000");
}

function validOptionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined
    || (typeof value === "string"
      && value.length <= maxLength
      && !value.includes("\u0000"));
}

function validAttachmentMimeType(value: unknown): value is string {
  return validRequiredString(value, MAX_ATTACHMENT_MIME_LENGTH)
    && PRINTABLE_ASCII_PATTERN.test(value)
    && value.trim() === value
    && normalizedAttachmentClassificationMimeType(value) !== null;
}

function validBrowserPreviewMimeType(value: unknown): value is string {
  return validAttachmentMimeType(value)
    && normalizedBrowserSafeAttachmentPreviewMimeType(value) !== null;
}

function validByteSize(value: unknown, maxBytes: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= maxBytes;
}

function validOptionalItemId(value: unknown): value is string | undefined {
  return value === undefined || validSubmissionId(value);
}

export function validSubmissionId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function requiresManagedStorage(items: CommentSubmissionItemInput[]) {
  return items.some((item) => item.kind === "attachment");
}

export function safeAttachmentUrl(value: unknown) {
  if (typeof value !== "string" || value.length > MAX_ATTACHMENT_URL_LENGTH
    || value.includes("\u0000")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validRunStepTargets(value: unknown): value is RunStepTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return false;
  const stepIds = new Set<string>();
  return value.every((target) => {
    if (!isRecord(target)
      || !validNonEmptyString(target.sampleId)
      || !validNonEmptyString(target.runId)
      || !validNonEmptyString(target.stepId)
      || !validNonEmptyString(target.expectedUpdatedAt)
      || stepIds.has(target.stepId)) return false;
    stepIds.add(target.stepId);
    return true;
  });
}

export function validateCommentSubmissionInput(input: unknown): string | null {
  if (!isRecord(input)) return "A comment submission is required";
  if (!validSubmissionId(input.id)) return "The submission ID is invalid";
  if (typeof input.body !== "string" || input.body.length > 10_000) return "Comment text is invalid";
  if (!Array.isArray(input.items) || input.items.length > MAX_COMMENT_SUBMISSION_ITEMS) {
    return `A comment can contain at most ${MAX_COMMENT_SUBMISSION_ITEMS} uploaded items`;
  }
  if (!input.body.trim() && input.items.length === 0) return "The comment is empty";
  if (!isRecord(input.context)) return "A comment context is required";

  if (input.context.kind === "sample") {
    if (!validNonEmptyString(input.context.sampleId)
      || !validNonEmptyString(input.context.expectedUpdatedAt)) {
      return "A current sample revision is required";
    }
  } else if (input.context.kind === "run_steps") {
    if ((input.context.scope !== "common" && input.context.scope !== "individual")
      || !validRunStepTargets(input.context.targets)
      || (input.context.scope === "individual" && input.context.targets.length !== 1)) {
      return "Valid process-step targets are required";
    }
  } else {
    return "The comment context is invalid";
  }

  const ids = new Set<string>();
  const itemsById = new Map<string, CommentSubmissionItemInput>();
  const validatedItems: CommentSubmissionItemInput[] = [];

  for (const rawItem of input.items) {
    if (!isRecord(rawItem) || !validSubmissionId(rawItem.id) || ids.has(rawItem.id)) {
      return "A submission item is invalid";
    }

    if (rawItem.kind === "comment_image") {
      if (!validRequiredString(rawItem.filename, MAX_ATTACHMENT_FILENAME_LENGTH)
        || !validBrowserPreviewMimeType(rawItem.mimeType)
        || !validByteSize(rawItem.byteSize, MAX_COMMENT_IMAGE_UPLOAD_BYTES)
        || !validRequiredString(rawItem.originalFilename, MAX_ATTACHMENT_FILENAME_LENGTH)
        || !validAttachmentMimeType(rawItem.originalMimeType)
        || !validByteSize(rawItem.originalByteSize, MAX_COMMENT_IMAGE_SOURCE_BYTES)
        || !validOptionalItemId(rawItem.relatedAttachmentId)) {
        return "Comment image metadata is invalid";
      }
    } else if (rawItem.kind === "attachment") {
      if (!validRequiredString(rawItem.filename, MAX_ATTACHMENT_FILENAME_LENGTH)
        || !validAttachmentMimeType(rawItem.mimeType)
        || !validByteSize(rawItem.byteSize, MAX_MANAGED_ATTACHMENT_BYTES)
        || !validOptionalString(rawItem.title, MAX_ATTACHMENT_TITLE_LENGTH)
        || !validOptionalItemId(rawItem.relatedCommentImageId)) {
        return "Attachment metadata is invalid";
      }
    } else if (rawItem.kind === "link") {
      if (!validRequiredString(rawItem.title, MAX_ATTACHMENT_TITLE_LENGTH)
        || !rawItem.title.trim()
        || !safeAttachmentUrl(rawItem.url)
        || !validOptionalString(rawItem.description, MAX_ATTACHMENT_DESCRIPTION_LENGTH)) {
        return "Attachment link metadata is invalid";
      }
    } else {
      return "The submission item type is invalid";
    }

    const item = rawItem as unknown as CommentSubmissionItemInput;
    ids.add(item.id);
    itemsById.set(item.id, item);
    validatedItems.push(item);
  }

  for (const item of validatedItems) {
    if (item.kind === "comment_image") {
      const imageDeclaresTiff = isTiffMetadata(item.originalFilename, item.originalMimeType);
      const original = item.relatedAttachmentId
        ? itemsById.get(item.relatedAttachmentId)
        : undefined;
      if (item.relatedAttachmentId && (!original || original.kind !== "attachment")) {
        return "A related original attachment is missing";
      }
      if (original?.kind === "attachment") {
        const pairDeclaresTiff = imageDeclaresTiff
          || isTiffMetadata(original.filename, original.mimeType);
        const relationMatches = original.relatedCommentImageId === item.id;
        const metadataMatches = original.filename === item.originalFilename
          && original.mimeType === item.originalMimeType
          && original.byteSize === item.originalByteSize;
        if (!relationMatches || !metadataMatches) {
          return pairDeclaresTiff
            ? "A TIFF preview requires its unchanged original attachment"
            : "The related original attachment does not match the image source";
        }
      } else if (imageDeclaresTiff) {
        return "A TIFF preview requires its unchanged original attachment";
      }
    }

    if (item.kind === "attachment" && item.relatedCommentImageId) {
      const image = itemsById.get(item.relatedCommentImageId);
      if (!image || image.kind !== "comment_image" || image.relatedAttachmentId !== item.id) {
        return "A related comment image is missing";
      }
    }
  }
  return null;
}
