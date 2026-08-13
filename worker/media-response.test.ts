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

it("normalizes parameters and empty media types", () => {
  expect(normalizedMediaMimeType(" Image/PNG ; charset=utf-8 ")).toBe("image/png");
  expect(normalizedMediaMimeType(null)).toBe("application/octet-stream");
});
});
