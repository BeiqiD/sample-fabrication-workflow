const SAFE_INLINE_RASTER_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/x-tiff",
]);

export function normalizedMediaMimeType(value: string | null | undefined) {
  const normalized = (value ?? "").split(";", 1)[0].trim().toLowerCase();
  return normalized || "application/octet-stream";
}

export function isSafeInlineRasterMimeType(value: string | null | undefined) {
  return SAFE_INLINE_RASTER_MIME_TYPES.has(normalizedMediaMimeType(value));
}

function encodedFilename(value: string) {
  return encodeURIComponent(value || "download").replace(/[\'()*]/g, (character) => (
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
