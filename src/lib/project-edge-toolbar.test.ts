import { describe, expect, it } from "vitest";
import { projectEdgeToolbarPosition } from "./project-edge-toolbar";

function expectClear(position: { x: number; y: number }, size: { width: number; height: number }, endpoint: { x: number; y: number }) {
  expect(position.x + size.width <= endpoint.x - 28
    || position.x >= endpoint.x + 28
    || position.y + size.height <= endpoint.y - 28
    || position.y >= endpoint.y + 28).toBe(true);
}

describe("edge toolbar screen placement", () => {
  it.each([2560, 3840])("keeps actions near the clicked section of a long diagonal edge on a %spx canvas", (width) => {
    const source = { x: 150, y: 120 };
    const target = { x: width - 120, y: 1300 };
    const anchor = { x: width - 500, y: 1000 };
    const size = { width: 360, height: 44 };
    const position = projectEdgeToolbarPosition(source, target, { width, height: 1440 }, size, anchor);
    expect(position.x + size.width / 2).toBe(anchor.x);
    expect(anchor.y - (position.y + size.height)).toBe(28);
    expectClear(position, size, source);
    expectClear(position, size, target);
  });

  it.each([
    { x: 1, y: 1 }, { x: 899, y: 1 }, { x: 1, y: 699 }, { x: 899, y: 699 },
    { x: -300, y: -100 }, { x: 1200, y: 1000 },
  ])("clamps a pointer anchor near or beyond the viewport boundary: $x, $y", (anchor) => {
    const canvas = { width: 900, height: 700 };
    const size = { width: 500, height: 120 };
    const source = { x: 100, y: 350 };
    const target = { x: 800, y: 350 };
    const position = projectEdgeToolbarPosition(source, target, canvas, size, anchor);
    expect(position.x).toBeGreaterThanOrEqual(12);
    expect(position.y).toBeGreaterThanOrEqual(12);
    expect(position.x + size.width).toBeLessThanOrEqual(canvas.width - 12);
    expect(position.y + size.height).toBeLessThanOrEqual(canvas.height - 12);
    expectClear(position, size, source);
    expectClear(position, size, target);
  });
  it("keeps a short horizontal connection's two reconnect targets clear", () => {
    const source = { x: 900, y: 727 };
    const target = { x: 732, y: 727 };
    const size = { width: 310, height: 44 };
    const position = projectEdgeToolbarPosition(source, target, { width: 1440, height: 900 }, size);
    expectClear(position, size, source);
    expectClear(position, size, target);
    expect(position.y + size.height).toBeLessThanOrEqual(699);
  });

  it("moves below endpoints near the canvas top and keeps a wider editor inside the viewport", () => {
    const source = { x: 32, y: 15 };
    const target = { x: 95, y: 18 };
    const size = { width: 470, height: 120 };
    const canvas = { width: 600, height: 420 };
    const position = projectEdgeToolbarPosition(source, target, canvas, size);
    expect(position.x).toBeGreaterThanOrEqual(12);
    expect(position.y).toBeGreaterThanOrEqual(12);
    expect(position.x + size.width).toBeLessThanOrEqual(canvas.width - 12);
    expect(position.y + size.height).toBeLessThanOrEqual(canvas.height - 12);
    expectClear(position, size, source);
    expectClear(position, size, target);
  });
});
