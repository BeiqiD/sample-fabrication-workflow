const TIFF_EXTENSION = /\.tiff?$/i;
const TIFF_MIME_TYPES = new Set(["image/tiff", "image/x-tiff"]);

export function isTiffMetadata(filename: string, mimeType: string) {
  return TIFF_EXTENSION.test(filename.trim()) || TIFF_MIME_TYPES.has(mimeType.trim().toLowerCase());
}
