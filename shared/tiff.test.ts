import { describe, expect, it } from "vitest";
import { isTiffMetadata } from "./tiff";

describe("TIFF identification", () => {
  it("recognizes instrument TIFF files even when their MIME type is missing", () => {
    expect(isTiffMetadata("surface.TIF", "")).toBe(true);
    expect(isTiffMetadata("surface.bin", "image/tiff")).toBe(true);
    expect(isTiffMetadata("surface.png", "image/png")).toBe(false);
  });
});
