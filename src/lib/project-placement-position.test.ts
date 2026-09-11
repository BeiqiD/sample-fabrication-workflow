import { describe, expect, it } from "vitest";
import type { ProjectMapGeometry } from "../../shared/project-types";
import { findAvailableProjectPlacementPoint } from "./project-placement-position";
import { projectAttachmentGeometryAtPoint, projectMarkdownGeometryAtPoint } from "./project-owned-content";

function separated(left: ProjectMapGeometry, right: ProjectMapGeometry) {
  return left.x + left.width + 23.9999999 <= right.x
    || right.x + right.width + 23.9999999 <= left.x
    || left.y + left.height + 23.9999999 <= right.y
    || right.y + right.height + 23.9999999 <= left.y;
}

describe("actual-size Project button placement", () => {
  it("keeps mixed notes, generic attachments and images apart at the same Reading anchor", () => {
    const anchor = { x: 240, y: 160 };
    const occupied: ProjectMapGeometry[] = [];
    const factories = [
      (point: { x: number; y: number }) => projectMarkdownGeometryAtPoint(point, 0),
      (point: { x: number; y: number }) => projectAttachmentGeometryAtPoint(point, 0, "application/pdf"),
      (point: { x: number; y: number }) => projectAttachmentGeometryAtPoint(point, 0, "image/png"),
    ];
    for (let index = 0; index < 24; index += 1) {
      const factory = factories[index % factories.length];
      const point = findAvailableProjectPlacementPoint(anchor, occupied, factory);
      expect(point).not.toBeNull();
      const geometry = factory(point!)!;
      expect(geometry.width).toBe(index % 3 === 1 ? 340 : 360);
      expect(geometry.height).toBe([220, 170, 300][index % 3]);
      expect(geometry.x).toBe(point!.x - geometry.width / 2);
      expect(geometry.y).toBe(point!.y - Math.min(72, geometry.height / 3));
      expect(occupied.every((previous) => separated(previous, geometry))).toBe(true);
      occupied.push(geometry);
    }
  });

  it("preserves a free anchor and rejects a nonfinite anchor even when the factory clamps coordinates", () => {
    const anchor = { x: 240, y: 160 };
    const factory = (point: { x: number; y: number }) => projectMarkdownGeometryAtPoint(point, 0);
    expect(findAvailableProjectPlacementPoint(anchor, [], factory)).toEqual(anchor);
    expect(findAvailableProjectPlacementPoint({ x: Infinity, y: 0 }, [], factory)).toBeNull();
  });

  it("uses the closest fractional-anchor gap instead of moving the attachment sideways", () => {
    const occupied = [
      { x: 20, y: 40, width: 250, height: 180, zIndex: 0 },
      { x: 320, y: 40, width: 240, height: 150, zIndex: 1 },
    ];
    const factory = (point: { x: number; y: number }) => projectAttachmentGeometryAtPoint(point, 0, "application/pdf");
    const point = findAvailableProjectPlacementPoint({ x: 400, y: 300 }, occupied, factory)!;
    const geometry = factory(point)!;
    expect(geometry.x).toBe(230);
    expect(geometry.y).toBeCloseTo(244, 8);
  });

});
