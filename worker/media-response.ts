import { normalizedAttachmentClassificationMimeType } from "../shared/tiff";

const SAFE_INLINE_RASTER_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function normalizedMediaMimeType(value: unknown) {
  return normalizedAttachmentClassificationMimeType(value)
    ?? "application/octet-stream";
}

export function isSafeInlineRasterMimeType(value: unknown) {
  return SAFE_INLINE_RASTER_MIME_TYPES.has(normalizedMediaMimeType(value));
}

function wellFormedFilename(value: string) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += "\uFFFD";
    } else {
      result += value[index];
    }
  }
  return result;
}

function encodedFilename(value: string) {
  return encodeURIComponent(wellFormedFilename(value || "download")).replace(/[\'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export function safeMediaResponseHeaders({
  headers = new Headers(),
  mimeType,
  filename,
  cacheControl,
  etag,
}: {
  headers?: Headers;
  mimeType: string | null | undefined;
  filename: string;
  cacheControl: string;
  etag?: string | null;
}) {
  const normalizedMimeType = normalizedMediaMimeType(mimeType);
  const inline = isSafeInlineRasterMimeType(normalizedMimeType);

  headers.set("content-type", normalizedMimeType);
  headers.set("cache-control", cacheControl);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set(
    "content-disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename(filename)}`,
  );
  if (etag) headers.set("etag", etag);

  if (inline) {
    headers.delete("content-security-policy");
  } else {
    headers.set(
      "content-security-policy",
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  }

  return headers;
}
