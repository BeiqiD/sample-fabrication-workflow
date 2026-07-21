import { describe, expect, it } from "vitest";
import { visibleAlphaBounds } from "./diagramImage";

function pixels(width: number, height: number, visible: Array<[number, number, number]>) {
  const result = new Uint8ClampedArray(width * height * 4);
  for (const [x, y, alpha] of visible) result[(y * width + x) * 4 + 3] = alpha;
  return result;
}

describe("visibleAlphaBounds", () => {
  it("finds content positioned at the bottom of a transparent diagram canvas", () => {
    const data = pixels(6, 6, [[1, 4, 255], [4, 4, 255], [2, 5, 255]]);
    expect(visibleAlphaBounds(data, 6, 6)).toEqual({ x: 1, y: 4, width: 4, height: 2 });
  });

  it("ignores nearly transparent antialiasing noise", () => {
    const data = pixels(4, 4, [[0, 0, 4], [2, 1, 255]]);
    expect(visibleAlphaBounds(data, 4, 4)).toEqual({ x: 2, y: 1, width: 1, height: 1 });
  });

  it("returns null for a fully transparent or invalid canvas", () => {
    expect(visibleAlphaBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
    expect(visibleAlphaBounds(new Uint8ClampedArray(), 2, 2)).toBeNull();
  });
});
