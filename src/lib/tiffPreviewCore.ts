import UTIF, { type TiffIfd } from "utif";

export const MAX_TIFF_PREVIEW_PIXELS = 25_000_000;
export const MAX_TIFF_DECODED_BYTES = 220 * 1024 * 1024;
const SUPPORTED_COMPRESSIONS = new Set([1, 5, 8, 32946]);
const MAX_ORIENTATION = 8;

export interface DecodedTiffPreview {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  sourceWidth: number;
  sourceHeight: number;
}

export class TiffPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TiffPreviewError";
  }
}

function numericTag(ifd: TiffIfd, tag: string) {
  const value = ifd[tag];
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return [];
  return Array.from(value as ArrayLike<unknown>, (item) => Number(item));
}

function firstNumericTag(ifd: TiffIfd, tag: string, fallback: number) {
  const value = numericTag(ifd, tag)[0];
  return Number.isFinite(value) ? value : fallback;
}

function validDimension(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function percentileRange16(data: Uint8Array, pixelCount: number, ifd: TiffIfd) {
  const declaredMin = firstNumericTag(ifd, "t280", Number.NaN);
  const declaredMax = firstNumericTag(ifd, "t281", Number.NaN);
  if (Number.isFinite(declaredMin) && Number.isFinite(declaredMax) && declaredMax > declaredMin) {
    return [Math.max(0, declaredMin), Math.min(65_535, declaredMax)] as const;
  }

  const histogram = new Uint32Array(65_536);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 2;
    histogram[data[offset] | (data[offset + 1] << 8)] += 1;
  }
  const lowTarget = Math.max(1, Math.ceil(pixelCount * 0.01));
  const highTarget = Math.ceil(pixelCount * 0.99);
  let count = 0;
  let low = 0;
  let high = 65_535;
  for (let value = 0; value < histogram.length; value += 1) {
    count += histogram[value];
    if (count >= lowTarget) {
      low = value;
      break;
    }
  }
  count = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    count += histogram[value];
    if (count >= highTarget) {
      high = value;
      break;
    }
  }
  if (high <= low) return [low, Math.min(65_535, low + 1)] as const;
  return [low, high] as const;
}

export function grayscale16ToRgba(data: Uint8Array, pixelCount: number, whiteIsZero: boolean, ifd: TiffIfd = {}) {
  if (data.byteLength < pixelCount * 2) throw new TiffPreviewError("The TIFF pixel data is incomplete.");
  const [low, high] = percentileRange16(data, pixelCount, ifd);
  const scale = 255 / (high - low);
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 2;
    const source = data[offset] | (data[offset + 1] << 8);
    const mapped = Math.max(0, Math.min(255, Math.round((source - low) * scale)));
    const value = whiteIsZero ? 255 - mapped : mapped;
    const target = index * 4;
    rgba[target] = value;
    rgba[target + 1] = value;
    rgba[target + 2] = value;
    rgba[target + 3] = 255;
  }
  return rgba;
}

function orientedDimensions(width: number, height: number, orientation: number) {
  return orientation >= 5
    ? { width: height, height: width }
    : { width, height };
}

function sourceCoordinates(x: number, y: number, orientation: number, width: number, height: number) {
  switch (orientation) {
    case 2: return [width - 1 - x, y] as const;
    case 3: return [width - 1 - x, height - 1 - y] as const;
    case 4: return [x, height - 1 - y] as const;
    case 5: return [y, x] as const;
    case 6: return [y, height - 1 - x] as const;
    case 7: return [width - 1 - y, height - 1 - x] as const;
    case 8: return [width - 1 - y, x] as const;
    default: return [x, y] as const;
  }
}

function sampleChannel(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, x: number, y: number, channel: number) {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  return rgba[(clampedY * width + clampedX) * 4 + channel];
}

export function orientAndResizeRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  orientation: number,
  maxEdge: number,
) {
  const oriented = orientedDimensions(width, height, orientation);
  const scale = Math.min(1, maxEdge / Math.max(oriented.width, oriented.height));
  const targetWidth = Math.max(1, Math.round(oriented.width * scale));
  const targetHeight = Math.max(1, Math.round(oriented.height * scale));
  if (orientation === 1 && targetWidth === width && targetHeight === height) {
    return {
      width,
      height,
      rgba: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    };
  }
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const xRatio = oriented.width / targetWidth;
  const yRatio = oriented.height / targetHeight;

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const orientedY = (targetY + 0.5) * yRatio - 0.5;
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const orientedX = (targetX + 0.5) * xRatio - 0.5;
      const [sourceX, sourceY] = sourceCoordinates(orientedX, orientedY, orientation, width, height);
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const xWeight = sourceX - x0;
      const yWeight = sourceY - y0;
      const target = (targetY * targetWidth + targetX) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = sampleChannel(rgba, width, height, x0, y0, channel) * (1 - xWeight)
          + sampleChannel(rgba, width, height, x1, y0, channel) * xWeight;
        const bottom = sampleChannel(rgba, width, height, x0, y1, channel) * (1 - xWeight)
          + sampleChannel(rgba, width, height, x1, y1, channel) * xWeight;
        output[target + channel] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }
  return { width: targetWidth, height: targetHeight, rgba: output };
}

export function decodeTiffPreview(buffer: ArrayBuffer, maxEdge = 1600): DecodedTiffPreview {
  let ifds: TiffIfd[];
  try {
    ifds = UTIF.decode(buffer);
  } catch {
    throw new TiffPreviewError("The TIFF header or image directory is invalid.");
  }
  const first = ifds[0];
  if (!first) throw new TiffPreviewError("The TIFF does not contain an image page.");

  const width = firstNumericTag(first, "t256", 0);
  const height = firstNumericTag(first, "t257", 0);
  if (!validDimension(width) || !validDimension(height)) {
    throw new TiffPreviewError("The TIFF page dimensions are invalid.");
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_TIFF_PREVIEW_PIXELS) {
    throw new TiffPreviewError("The TIFF page is too large to preview safely (maximum 25 MP).");
  }

  const compression = firstNumericTag(first, "t259", 1);
  if (!SUPPORTED_COMPRESSIONS.has(compression)) {
    throw new TiffPreviewError("This TIFF compression is not supported for browser previews.");
  }
  if (compression === 32946) first.t259 = [8];

  const photometric = firstNumericTag(first, "t262", 1);
  const samples = firstNumericTag(first, "t277", numericTag(first, "t258").length || 1);
  if (!Number.isInteger(samples) || samples < 1 || samples > 4) {
    throw new TiffPreviewError("The TIFF channel count is not supported for browser previews.");
  }
  const bits = numericTag(first, "t258");
  const normalizedBits = bits.length ? bits : Array.from({ length: samples }, () => 1);
  const sampleFormat = numericTag(first, "t339");
  const planarConfiguration = firstNumericTag(first, "t284", 1);
  const orientation = firstNumericTag(first, "t274", 1);
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > MAX_ORIENTATION) {
    throw new TiffPreviewError("The TIFF orientation is invalid.");
  }
  if (planarConfiguration !== 1) {
    throw new TiffPreviewError("Planar TIFF channels are not supported for browser previews.");
  }
  if (sampleFormat.some((value) => value !== 1)) {
    throw new TiffPreviewError("Floating-point and signed TIFF samples are not supported for browser previews.");
  }

  const grayscale = (photometric === 0 || photometric === 1) && samples === 1
    && normalizedBits.length === 1 && (normalizedBits[0] === 8 || normalizedBits[0] === 16);
  const rgb = photometric === 2 && (samples === 3 || samples === 4)
    && normalizedBits.length >= samples && normalizedBits.slice(0, samples).every((value) => value === 8);
  if (!grayscale && !rgb) {
    throw new TiffPreviewError("Only 8/16-bit grayscale and 8-bit RGB/RGBA TIFF previews are supported.");
  }

  const sourceBytesPerPixel = normalizedBits.slice(0, samples).reduce((total, value) => total + value, 0) / 8;
  const estimatedDecodedBytes = pixelCount * (sourceBytesPerPixel + 4);
  if (estimatedDecodedBytes > MAX_TIFF_DECODED_BYTES) {
    throw new TiffPreviewError("The TIFF would use too much memory to preview safely.");
  }

  try {
    UTIF.decodeImage(buffer, first, ifds);
  } catch {
    throw new TiffPreviewError("The TIFF pixel data could not be decoded.");
  }
  if (!first.data) throw new TiffPreviewError("The TIFF pixel data could not be decoded.");

  let rgba: Uint8Array | Uint8ClampedArray;
  if (grayscale && normalizedBits[0] === 16) {
    rgba = grayscale16ToRgba(first.data, pixelCount, photometric === 0, first);
  } else {
    try {
      rgba = UTIF.toRGBA8(first);
    } catch {
      throw new TiffPreviewError("The TIFF colors could not be converted for preview.");
    }
  }
  if (rgba.byteLength !== pixelCount * 4) {
    throw new TiffPreviewError("The decoded TIFF pixel count does not match its metadata.");
  }
  const preview = orientAndResizeRgba(rgba, width, height, orientation, maxEdge);
  return { ...preview, sourceWidth: width, sourceHeight: height };
}
