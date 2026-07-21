export type PixelBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function visibleAlphaBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 8,
): PixelBounds | null {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) return null;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] <= alphaThreshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
