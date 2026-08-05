import { describe, expect, it } from "vitest";
import UTIF from "utif";
import {
  decodeTiffPreview,
  grayscale16ToRgba,
  orientAndResizeRgba,
} from "./tiffPreviewCore";

describe("TIFF preview decoding", () => {
  it("decodes the first page of an uncompressed 8-bit RGBA TIFF", () => {
    const source = new Uint8Array([
      10, 20, 30, 255,
      40, 50, 60, 255,
    ]);
    const encoded = UTIF.encodeImage(source, 2, 1);
    const decoded = decodeTiffPreview(encoded);
    expect(decoded).toMatchObject({ width: 2, height: 1, sourceWidth: 2, sourceHeight: 1 });
    expect([...decoded.rgba]).toEqual([...source]);
  });

  it("maps 16-bit grayscale percentiles and supports WhiteIsZero", () => {
    const values = new Uint16Array([1_000, 2_000, 3_000, 4_000]);
    const bytes = new Uint8Array(values.buffer);
    const blackIsZero = grayscale16ToRgba(bytes, values.length, false);
    const whiteIsZero = grayscale16ToRgba(bytes, values.length, true);
    expect([...blackIsZero.filter((_, index) => index % 4 === 0)]).toEqual([0, 85, 170, 255]);
    expect([...whiteIsZero.filter((_, index) => index % 4 === 0)]).toEqual([255, 170, 85, 0]);
  });

  it("decodes an unsigned 16-bit grayscale TIFF into a visible 8-bit preview", () => {
    const ifd = {
      t256: [4],
      t257: [1],
      t258: [16],
      t259: [1],
      t262: [1],
      t273: [1_000],
      t277: [1],
      t278: [1],
      t279: [8],
      t284: [1],
    };
    const header = new Uint8Array(UTIF.encode([ifd]));
    const encoded = new Uint8Array(1_008);
    encoded.set(header);
    encoded.set(new Uint8Array([0x03, 0xe8, 0x07, 0xd0, 0x0b, 0xb8, 0x0f, 0xa0]), 1_000);
    const decoded = decodeTiffPreview(encoded.buffer);
    expect([...decoded.rgba.filter((_, index) => index % 4 === 0)]).toEqual([0, 85, 170, 255]);
  });

  it("applies TIFF orientation before returning preview pixels", () => {
    const source = new Uint8Array([
      10, 0, 0, 255, 20, 0, 0, 255,
      30, 0, 0, 255, 40, 0, 0, 255,
      50, 0, 0, 255, 60, 0, 0, 255,
    ]);
    const rotated = orientAndResizeRgba(source, 2, 3, 6, 1600);
    expect(rotated.width).toBe(3);
    expect(rotated.height).toBe(2);
    expect([...rotated.rgba.filter((_, index) => index % 4 === 0)]).toEqual([
      50, 30, 10,
      60, 40, 20,
    ]);
  });

  it("rejects oversized pages and unsupported compression before decoding pixels", () => {
    const metadata = {
      t256: [5_001],
      t257: [5_000],
      t258: [8],
      t259: [1],
      t262: [1],
      t273: [1_000],
      t277: [1],
      t278: [5_000],
      t279: [25_005_000],
    };
    expect(() => decodeTiffPreview(UTIF.encode([metadata])))
      .toThrow("The TIFF page is too large to preview safely");
    expect(() => decodeTiffPreview(UTIF.encode([{ ...metadata, t256: [1], t257: [1], t259: [7] }])))
      .toThrow("This TIFF compression is not supported");
  });
});
