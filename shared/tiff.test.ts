import { describe, expect, it } from "vitest";
import {
  isTiffMetadata,
  normalizedAttachmentClassificationMimeType,
  normalizedBrowserSafeAttachmentPreviewMimeType,
} from "./tiff";

describe("TIFF identification", () => {
  it("recognizes instrument TIFF files even when their MIME type is missing", () => {
    expect(isTiffMetadata("surface.TIF", "")).toBe(true);
    expect(isTiffMetadata("surface.bin", "image/tiff")).toBe(true);
    expect(isTiffMetadata("surface.png", "image/png")).toBe(false);
  });

  it("rejects NUL metadata and uses ASCII-only MIME case folding", () => {
    expect(isTiffMetadata("\u0000surface.tif", "image/png")).toBe(false);
    expect(isTiffMetadata("surface.tif", "image/png\u0000ignored")).toBe(false);
    expect(isTiffMetadata("surface.bin", "\u0000image/tiff")).toBe(false);
    expect(normalizedAttachmentClassificationMimeType("IMAGE/PNG")).toBe("image/png");
    expect(normalizedAttachmentClassificationMimeType("image/pn\u212A")).toBeNull();
  });

  it("normalizes only browser-safe raster preview MIME types", () => {
    expect(normalizedBrowserSafeAttachmentPreviewMimeType(
      "\u00A0IMAGE/WEBP\u00A0; charset=binary",
    )).toBe("image/webp");
    expect(normalizedBrowserSafeAttachmentPreviewMimeType("image/svg+xml")).toBeNull();
    expect(normalizedBrowserSafeAttachmentPreviewMimeType("image/not valid")).toBeNull();
  });

  it("fails closed for non-string metadata", () => {
    for (const value of [123, [], {}]) {
      expect(isTiffMetadata(value, "image/png")).toBe(false);
      expect(isTiffMetadata("surface.bin", value)).toBe(false);
      expect(normalizedAttachmentClassificationMimeType(value)).toBeNull();
      expect(normalizedBrowserSafeAttachmentPreviewMimeType(value)).toBeNull();
    }
  });
});
