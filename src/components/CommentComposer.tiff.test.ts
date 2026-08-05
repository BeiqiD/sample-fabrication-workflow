import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composer = readFileSync(new URL("./CommentComposer.tsx", import.meta.url), "utf8");
const images = readFileSync(new URL("../lib/images.ts", import.meta.url), "utf8");

describe("TIFF comment previews", () => {
  it("loads TIFF support on demand and keeps the original required", () => {
    expect(images).toMatch(/await import\("\.\/tiffPreview"\)/);
    expect(composer).toMatch(/accept="image\/\*,\.tif,\.tiff,image\/tiff"/);
    expect(composer).toMatch(/attachOriginal: tiff/);
    expect(composer).toMatch(/originalRequired: tiff/);
    expect(composer).toMatch(/!image\.originalRequired && <button/);
  });

  it("falls back to an ordinary attachment when a TIFF preview cannot be generated", () => {
    expect(composer).toMatch(/fallbackAttachments\.push/);
    expect(composer).toMatch(/The original TIFF will be attached without a preview/);
    expect(composer).toMatch(/item\.required \? "Required original TIFF"/);
  });
});
