import { describe, expect, it } from "vitest";
import {
  isSafeInlineRasterMimeType,
  normalizedMediaMimeType,
  safeMediaResponseHeaders,
} from "./media-response";

describe("safe media response policy", () => {
  it.each(["image/png", "IMAGE/JPEG; charset=binary", "image/webp"])(
    "allows safe raster media inline for %s",
    (mimeType) => {
      const headers = safeMediaResponseHeaders({
        mimeType,
        filename: "image test.png",
        cacheControl: "private, no-store",
        etag: '"etag"',
      });
      expect(isSafeInlineRasterMimeType(mimeType)).toBe(true);
      expect(headers.get("content-disposition")).toMatch(/^inline;/);
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(headers.get("content-security-policy")).toBeNull();
    },
  );

  it.each(["image/svg+xml", "image/tiff", "image/x-tiff", "text/html", "application/octet-stream", ""])(
    "forces active or unknown media to a sandboxed attachment for %j",
    (mimeType) => {
      const headers = safeMediaResponseHeaders({
        mimeType,
        filename: "unsafe.svg",
        cacheControl: "private, no-store",
      });
      expect(isSafeInlineRasterMimeType(mimeType)).toBe(false);
      expect(headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(headers.get("content-security-policy")).toContain("sandbox");
      expect(headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  it("normalizes parameters and falls back for invalid header values", () => {
    expect(normalizedMediaMimeType(" Image/PNG ; charset=utf-8 ")).toBe("image/png");
    expect(normalizedMediaMimeType("image/png\r\nx-test: injected"))
      .toBe("application/octet-stream");
    expect(normalizedMediaMimeType("image/pn\u212A"))
      .toBe("application/octet-stream");
    expect(normalizedMediaMimeType("text/\u017Fvg"))
      .toBe("application/octet-stream");
    for (const value of [null, 123, [], {}]) {
      expect(normalizedMediaMimeType(value)).toBe("application/octet-stream");
      expect(isSafeInlineRasterMimeType(value)).toBe(false);
    }

    expect(() => safeMediaResponseHeaders({
      mimeType: "image/png\r\nx-test: injected",
      filename: "unsafe.png",
      cacheControl: "private, no-store",
    })).not.toThrow();
  });

  it("replaces isolated UTF-16 surrogates instead of failing the download response", () => {
    for (const filename of ["bad-\uD800-name.tif", "bad-\uDC00-name.tif"]) {
      expect(() => safeMediaResponseHeaders({
        mimeType: "application/octet-stream",
        filename,
        cacheControl: "private, no-store",
      })).not.toThrow();
      const headers = safeMediaResponseHeaders({
        mimeType: "application/octet-stream",
        filename,
        cacheControl: "private, no-store",
      });
      expect(headers.get("content-disposition")).toContain("%EF%BF%BD");
    }
  });
});
