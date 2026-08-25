import { isCanonicalMimeType } from "./mime-type";

const TIFF_EXTENSION = /\.tiff?$/;
const TIFF_MIME_TYPES = new Set(["image/tiff", "image/x-tiff"]);
const BROWSER_SAFE_ATTACHMENT_PREVIEW_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Keep attachment classification independent from host-language trim/case-fold
// semantics. This is the ECMAScript WhiteSpace + LineTerminator set used by
// String.trim(), but case folding below is deliberately ASCII-only.
const ATTACHMENT_CLASSIFICATION_EDGE_WHITESPACE =
  /^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$/g;

export function trimAttachmentClassificationWhitespace(value: string) {
  return value.replace(ATTACHMENT_CLASSIFICATION_EDGE_WHITESPACE, "");
}

export function asciiLowercaseAttachmentClassification(value: string) {
  return value.replace(/[A-Z]/g, (character) => (
    String.fromCharCode(character.charCodeAt(0) + 32)
  ));
}

export function normalizedAttachmentClassificationMimeType(value: unknown) {
  if (typeof value !== "string" || value.includes("\u0000")) return null;
  const base = value.split(";", 1)[0] ?? "";
  const normalized = asciiLowercaseAttachmentClassification(
    trimAttachmentClassificationWhitespace(base),
  );
  return isCanonicalMimeType(normalized) ? normalized : null;
}

export function normalizedBrowserSafeAttachmentPreviewMimeType(value: unknown) {
  const normalized = normalizedAttachmentClassificationMimeType(value);
  return normalized !== null && BROWSER_SAFE_ATTACHMENT_PREVIEW_MIME_TYPES.has(normalized)
    ? normalized
    : null;
}

export function normalizedAttachmentClassificationFilename(value: unknown) {
  if (typeof value !== "string" || value.includes("\u0000")) return null;
  return asciiLowercaseAttachmentClassification(
    trimAttachmentClassificationWhitespace(value),
  );
}

export function isTiffMetadata(filename: unknown, mimeType: unknown) {
  // TIFF identity is one atomic classification input. If either presentation
  // field is structurally invalid, do not let the other field classify it.
  if (typeof filename !== "string" || typeof mimeType !== "string"
    || filename.includes("\u0000") || mimeType.includes("\u0000")) return false;
  const normalizedFilename = normalizedAttachmentClassificationFilename(filename);
  const normalizedMimeType = normalizedAttachmentClassificationMimeType(mimeType);
  return (normalizedFilename !== null && TIFF_EXTENSION.test(normalizedFilename))
    || (normalizedMimeType !== null && TIFF_MIME_TYPES.has(normalizedMimeType));
}
